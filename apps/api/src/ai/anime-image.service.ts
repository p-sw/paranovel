import {
  BadGatewayException,
  BadRequestException,
  GatewayTimeoutException,
  Injectable,
  RequestTimeoutException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { lookup } from 'node:dns/promises';
import { request as requestHttps } from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { z } from 'zod';

const generateArguments = z.strictObject({
  prompt: z.string().trim().min(1).max(1_000),
  orientation: z.enum(['portrait', 'square', 'landscape']),
  allowNSFW: z.boolean(),
});

const generationResponse = z.object({
  image_url: z.string().min(1).max(8_192),
  enhanced_prompt: z.string().max(64_000).optional(),
  generation_time_ms: z.number().nonnegative().finite().optional(),
});

export type AnimeImageInput = z.infer<typeof generateArguments>;
export interface AnimeImageResult {
  imageUrl: string;
  enhancedPrompt?: string;
  generationTimeMs?: number;
}
export interface DownloadedAnimeImage {
  bytes: Buffer;
  mimeType: string;
  extension: 'webp' | 'png' | 'jpg';
}

const MAX_RESPONSE_BYTES = 256 * 1_024;
const MAX_IMAGE_BYTES = 20 * 1_024 * 1_024;
const blockedAddresses = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blockedAddresses.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [
  ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20],
] as const) blockedAddresses.addSubnet(address, prefix, 'ipv6');
const globalIpv6 = new BlockList();
globalIpv6.addSubnet('2000::', 3, 'ipv6');

// Messages from this private error class are authored here, never copied from a provider.
class ImageFailure extends Error {}

function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blockedAddresses.check(address, 'ipv4');
  return family === 6 && globalIpv6.check(address, 'ipv6')
    && !blockedAddresses.check(address, 'ipv6');
}

function imageUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new ImageFailure('이미지 주소가 올바르지 않습니다.'); }
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (value.length > 8_192 || url.protocol !== 'https:' || url.username || url.password
    || (url.port && url.port !== '443') || !hostname
    || (isIP(hostname) && !isPublicAddress(hostname))) {
    throw new ImageFailure('공개 HTTPS 이미지 주소만 사용할 수 있습니다.');
  }
  return url;
}

function withAbort<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new ImageFailure('요청이 취소되었습니다.'));
    signal.addEventListener('abort', abort, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) abort();
  });
}

async function readJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.body) throw new ImageFailure('이미지 생성 서비스의 응답이 올바르지 않습니다.');
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await withAbort(reader.read(), signal);
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new ImageFailure('이미지 생성 서비스의 응답이 너무 큽니다.');
      parts.push(value);
    }
    return JSON.parse(Buffer.concat(parts).toString('utf8'));
  } finally {
    // Cancelling the stream also stops reading an oversized or interrupted response.
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function rasterFormat(bytes: Buffer): Pick<DownloadedAnimeImage, 'extension' | 'mimeType'> | undefined {
  if (bytes.length >= 20 && bytes.toString('ascii', 0, 4) === 'RIFF'
    && bytes.toString('ascii', 8, 12) === 'WEBP'
    && ['VP8 ', 'VP8L', 'VP8X'].includes(bytes.toString('ascii', 12, 16))
    && bytes.readUInt32LE(4) + 8 === bytes.length) {
    return { extension: 'webp', mimeType: 'image/webp' };
  }
  if (bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    && bytes.readUInt32BE(8) === 13 && bytes.toString('ascii', 12, 16) === 'IHDR'
    && bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(20) > 0) {
    return { extension: 'png', mimeType: 'image/png' };
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
    && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9) {
    return { extension: 'jpg', mimeType: 'image/jpeg' };
  }
  return undefined;
}

@Injectable()
export class AnimeImageService {
  private readonly apiKey = process.env.ANIMEAPI_API_KEY?.trim();

  isConfigured(): boolean { return Boolean(this.apiKey); }

  async generate(input: AnimeImageInput, signal?: AbortSignal): Promise<AnimeImageResult> {
    const args = generateArguments.safeParse(input);
    if (!args.success) throw new BadRequestException('이미지 프롬프트는 1~1,000자이며 방향과 성인 콘텐츠 허용 여부가 필요합니다.');
    if (!this.isConfigured()) throw new ServiceUnavailableException('이미지 생성을 사용하려면 서버에 ANIMEAPI_API_KEY를 설정해 주세요.');
    if (signal?.aborted) throw new RequestTimeoutException('이미지 생성 요청이 취소되었습니다.');
    const timeout = AbortSignal.timeout(120_000);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      // The provider has no documented idempotency support: never retry this POST.
      const response = await withAbort(fetch('https://www.animeapi.ai/api/generate', {
        method: 'POST',
        redirect: 'error',
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...args.data, model: 'ultra-max', enhance: true }),
        signal: combined,
      }), combined);
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined);
        const message = response.status === 401 ? '이미지 생성 API 키를 확인해 주세요.'
          : response.status === 402 ? '이미지 생성 서비스의 잔액이 부족합니다.'
            : response.status === 429 ? '이미지 생성 서비스의 요청 한도에 도달했습니다. 잠시 후 다시 시도해 주세요.'
              : '이미지 생성 서비스가 요청을 처리하지 못했습니다.';
        throw new ImageFailure(message);
      }
      const result = generationResponse.safeParse(await readJson(response, combined));
      if (!result.success) throw new ImageFailure('이미지 생성 서비스의 응답이 올바르지 않습니다.');
      imageUrl(result.data.image_url);
      return {
        imageUrl: result.data.image_url,
        enhancedPrompt: result.data.enhanced_prompt,
        generationTimeMs: result.data.generation_time_ms,
      };
    } catch (error) {
      if (signal?.aborted) throw new RequestTimeoutException('이미지 생성 요청이 취소되었습니다. 자동으로 다시 요청하지 않습니다.');
      if (timeout.aborted) throw new GatewayTimeoutException('이미지 생성 응답 시간이 초과되었습니다. 중복 생성을 막기 위해 자동으로 다시 요청하지 않습니다.');
      throw new BadGatewayException(error instanceof ImageFailure ? error.message
        : error instanceof SyntaxError ? '이미지 생성 서비스의 응답이 올바르지 않습니다.'
          : '이미지 생성 서비스에 연결할 수 없습니다. 자동으로 다시 요청하지 않습니다.');
    }
  }

  async download(value: string, signal?: AbortSignal): Promise<DownloadedAnimeImage> {
    if (signal?.aborted) throw new RequestTimeoutException('이미지 다운로드가 취소되었습니다.');
    const timeout = AbortSignal.timeout(30_000);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const url = imageUrl(value);
      const hostname = url.hostname.replace(/^\[|\]$/g, '');
      const family = isIP(hostname);
      const addresses = family ? [{ address: hostname, family }]
        : await withAbort(lookup(hostname, { all: true, verbatim: true }), combined);
      if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
        throw new ImageFailure('공개 네트워크의 이미지만 다운로드할 수 있습니다.');
      }
      const address = addresses[0]!;
      // Resolve once and pin the checked IP; TLS still verifies the original hostname.
      const pinnedLookup: LookupFunction = (_hostname, options, callback) => {
        if (options.all) callback(null, [address]);
        else callback(null, address.address, address.family);
      };
      return await new Promise<DownloadedAnimeImage>((resolve, reject) => {
        const req = requestHttps(url, {
          method: 'GET',
          agent: false,
          lookup: pinnedLookup,
          signal: combined,
          headers: { Accept: 'image/webp, image/png, image/jpeg' },
        }, (response) => {
          const fail = (message: string) => {
            reject(new ImageFailure(message));
            response.destroy();
            req.destroy();
          };
          // Do not follow redirects, including redirects to private hosts.
          if (response.statusCode !== 200) {
            fail('이미지 다운로드에 실패했습니다. 저장된 이미지 주소로 다시 시도할 수 있습니다.');
            return;
          }
          const contentType = response.headers['content-type']?.split(';')[0]?.trim().toLowerCase();
          if (!['image/webp', 'image/png', 'image/jpeg'].includes(contentType ?? '')) {
            fail('이미지 파일 형식이 올바르지 않습니다.');
            return;
          }
          const declaredSize = Number(response.headers['content-length']);
          if (Number.isFinite(declaredSize) && declaredSize > MAX_IMAGE_BYTES) {
            fail('이미지 파일이 20MiB 제한을 초과했습니다.');
            return;
          }
          const parts: Buffer[] = [];
          let size = 0;
          response.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_IMAGE_BYTES) fail('이미지 파일이 20MiB 제한을 초과했습니다.');
            else parts.push(chunk);
          });
          response.on('end', () => {
            const bytes = Buffer.concat(parts);
            const format = rasterFormat(bytes);
            if (!format || format.mimeType !== contentType) {
              fail('이미지 파일의 내용과 형식이 일치하지 않습니다.');
              return;
            }
            resolve({ bytes, ...format });
          });
          response.on('error', reject);
          response.on('aborted', () => reject(new ImageFailure('이미지 다운로드가 중단되었습니다. 다시 시도해 주세요.')));
        });
        req.on('error', reject);
        req.end();
      });
    } catch (error) {
      if (signal?.aborted) throw new RequestTimeoutException('이미지 다운로드가 취소되었습니다.');
      if (timeout.aborted) throw new GatewayTimeoutException('이미지 다운로드 시간이 초과되었습니다. 저장된 이미지 주소로 다시 시도할 수 있습니다.');
      throw new BadGatewayException(error instanceof ImageFailure ? error.message
        : '이미지를 다운로드할 수 없습니다. 저장된 이미지 주소로 다시 시도할 수 있습니다.');
    }
  }
}
