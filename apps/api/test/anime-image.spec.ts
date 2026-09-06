import { EventEmitter } from 'node:events';
import type { IncomingMessage, ClientRequest } from 'node:http';
import type { RequestOptions } from 'node:https';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnimeImageService } from '../src/ai/anime-image.service';

const transport = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup: transport.lookup }));
vi.mock('node:https', () => ({ request: transport.request }));

const input = { prompt: '은빛 머리와 푸른 눈의 인물이 숲을 걷는다.', orientation: 'portrait' as const, allowNSFW: false };
const remoteUrl = 'https://cdn.example.com/character.webp';
const webp = Buffer.concat([
  Buffer.from('RIFF'), Buffer.from([16, 0, 0, 0]), Buffer.from('WEBPVP8 '),
  Buffer.from([4, 0, 0, 0]), Buffer.from([0, 0, 0, 0]),
]);
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]), Buffer.from('IHDR'),
  Buffer.from([0, 0, 0, 1, 0, 0, 0, 1]), Buffer.alloc(9),
]);
const jpg = Buffer.from([255, 216, 255, 224, 0, 0, 255, 217]);

function mockDownload(options: {
  status?: number;
  type?: string;
  length?: string;
  bytes?: Buffer;
  chunks?: Buffer[];
  pending?: boolean;
  error?: Error;
} = {}): void {
  transport.request.mockImplementation((_url: URL, requestOptions: RequestOptions, callback: (response: IncomingMessage) => void) => {
    const req = new EventEmitter() as ClientRequest;
    let response: PassThrough | undefined;
    req.destroy = vi.fn((error?: Error) => {
      if (error) queueMicrotask(() => req.emit('error', error));
      response?.destroy();
      return req;
    });
    const abort = () => req.destroy(new Error('internal transport cancellation'));
    requestOptions.signal?.addEventListener('abort', abort, { once: true });
    req.end = vi.fn(() => {
      queueMicrotask(() => {
        if (options.error) {
          req.emit('error', options.error);
          return;
        }
        if (options.pending) return;
        response = new PassThrough();
        const incoming = response as unknown as IncomingMessage;
        incoming.statusCode = options.status ?? 200;
        incoming.headers = {
          'content-type': options.type ?? 'image/webp',
          ...(options.length === undefined ? {} : { 'content-length': options.length }),
        };
        callback(incoming);
        if (!response.destroyed) {
          for (const chunk of options.chunks ?? [options.bytes ?? webp]) response.write(chunk);
          response.end();
        }
        requestOptions.signal?.removeEventListener('abort', abort);
      });
      return req;
    }) as ClientRequest['end'];
    return req;
  });
}

beforeEach(() => {
  vi.stubEnv('ANIMEAPI_API_KEY', 'ank-test-secret');
  transport.lookup.mockReset().mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
  transport.request.mockReset();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('AnimeAPI generation', () => {
  const fetchMock = vi.fn<typeof fetch>();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  it('fixes quality and enhancement while retaining AI-selected fields', async () => {
    fetchMock.mockResolvedValue(Response.json({
      image_url: remoteUrl, enhanced_prompt: 'Silver hair', generation_time_ms: 1_200, balance_usd: 20,
    }));
    expect(await new AnimeImageService().generate(input)).toEqual({
      imageUrl: remoteUrl, enhancedPrompt: 'Silver hair', generationTimeMs: 1_200,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('https://www.animeapi.ai/api/generate', expect.objectContaining({
      method: 'POST', redirect: 'error',
      headers: { Authorization: 'Bearer ank-test-secret', 'Content-Type': 'application/json' },
      signal: expect.any(AbortSignal),
    }));
    expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string)).toEqual({
      ...input, model: 'ultra-max', enhance: true,
    });
  });

  it.each([
    { ...input, prompt: '' }, { ...input, prompt: ' ' }, { ...input, prompt: '가'.repeat(1_001) },
    { ...input, orientation: 'wide' }, { ...input, allowNSFW: 'true' },
    { ...input, model: 'anime' }, { ...input, enhance: false }, { ...input, token: 'override' },
  ])('rejects invalid arguments and undeclared options without requesting generation: %j', async (args) => {
    await expect(new AnimeImageService().generate(args as typeof input)).rejects.toMatchObject({ status: 400 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('accepts the maximum prompt length and all supported orientations', async () => {
    for (const orientation of ['portrait', 'square', 'landscape'] as const) {
      fetchMock.mockResolvedValueOnce(Response.json({ image_url: remoteUrl }));
      await expect(new AnimeImageService().generate({ ...input, prompt: '가'.repeat(1_000), orientation, allowNSFW: true }))
        .resolves.toMatchObject({ imageUrl: remoteUrl });
    }
  });

  it('provides a configuration message when the key is absent', async () => {
    vi.stubEnv('ANIMEAPI_API_KEY', '  ');
    const service = new AnimeImageService();
    expect(service.isConfigured()).toBe(false);
    await expect(service.generate(input)).rejects.toMatchObject({ status: 503, message: expect.stringContaining('ANIMEAPI_API_KEY') });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([401, 402, 429, 500])('sanitizes upstream status %s and never retries', async (status) => {
    fetchMock.mockResolvedValue(Response.json({ error: 'provider echoed ank-test-secret' }, { status }));
    const error = await new AnimeImageService().generate(input).catch((failure: Error) => failure);
    expect(error).toMatchObject({ status: 502 });
    expect(JSON.stringify(error)).not.toContain('ank-test-secret');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    { image_url: 'http://cdn.example.com/image.webp' }, { image_url: 'https://127.0.0.1/image.webp' },
    { image_url: remoteUrl, generation_time_ms: -1 }, { image_url: remoteUrl, enhanced_prompt: 42 }, {},
  ])('rejects malformed provider results: %j', async (payload) => {
    fetchMock.mockResolvedValue(Response.json(payload));
    await expect(new AnimeImageService().generate(input)).rejects.toMatchObject({ status: 502 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects non-JSON and oversized response bodies', async () => {
    fetchMock.mockResolvedValueOnce(new Response('not json'))
      .mockResolvedValueOnce(new Response('a'.repeat(256 * 1_024 + 1)));
    await expect(new AnimeImageService().generate(input)).rejects.toMatchObject({ status: 502 });
    await expect(new AnimeImageService().generate(input)).rejects.toMatchObject({ status: 502 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('sanitizes network errors and never retries the POST', async () => {
    fetchMock.mockRejectedValue(new Error('request key: ank-test-secret'));
    const error = await new AnimeImageService().generate(input).catch((failure: Error) => failure);
    expect(error).toMatchObject({ status: 502 });
    expect(JSON.stringify(error)).not.toContain('ank-test-secret');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('times out after 120 seconds without resubmitting generation', async () => {
    const timeout = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal);
    fetchMock.mockImplementation(() => new Promise(() => undefined));
    const pending = new AnimeImageService().generate(input);
    timeout.abort();
    await expect(pending).rejects.toMatchObject({ status: 504 });
    expect(timeoutSpy).toHaveBeenCalledWith(120_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![1]!.signal!.aborted).toBe(true);
  });

  it('handles cancellation before and during generation without leaking its reason', async () => {
    const cancelled = new AbortController();
    cancelled.abort(new Error('ank-test-secret'));
    const service = new AnimeImageService();
    await expect(service.generate(input, cancelled.signal)).rejects.toMatchObject({ status: 408 });
    expect(fetchMock).not.toHaveBeenCalled();

    fetchMock.mockImplementation(() => new Promise(() => undefined));
    const current = new AbortController();
    const pending = service.generate(input, current.signal);
    current.abort(new Error('ank-test-secret'));
    const error = await pending.catch((failure: Error) => failure);
    expect(error).toMatchObject({ status: 408 });
    expect(JSON.stringify(error)).not.toContain('ank-test-secret');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('AnimeAPI image downloads', () => {
  it.each([
    ['webp', 'image/webp', webp], ['png', 'image/png', png], ['jpg', 'image/jpeg', jpg],
  ] as const)('validates %s raster signatures and MIME types', async (extension, type, bytes) => {
    mockDownload({ type, bytes });
    expect(await new AnimeImageService().download(remoteUrl)).toEqual({ bytes, mimeType: type, extension });
    const [url, options] = transport.request.mock.calls[0]!;
    expect(url.href).toBe(remoteUrl);
    expect(options).toMatchObject({ method: 'GET', agent: false });
    expect(options.headers).not.toHaveProperty('Authorization');
    expect(JSON.stringify(options)).not.toContain('ank-test-secret');
    const callback = vi.fn();
    options.lookup('cdn.example.com', {}, callback);
    expect(callback).toHaveBeenCalledWith(null, '8.8.8.8', 4);
    const all = vi.fn();
    options.lookup('cdn.example.com', { all: true }, all);
    expect(all).toHaveBeenCalledWith(null, [{ address: '8.8.8.8', family: 4 }]);
    expect(transport.lookup).toHaveBeenCalledTimes(1);
  });

  it.each([
    'http://cdn.example.com/image.webp', 'file:///etc/passwd', 'https://user:pass@cdn.example.com/image.webp',
    'https://cdn.example.com:444/image.webp', 'https://127.0.0.1/image', 'https://2130706433/image',
    'https://10.1.2.3/image', 'https://169.254.169.254/latest/meta-data', 'https://[::1]/image',
    'https://[::ffff:127.0.0.1]/image', 'https://[fc00::1]/image', 'https://[2002:7f00:1::]/image',
    'https://[2001:db8::1]/image',
  ])('blocks non-public or unsafe addresses before requesting: %s', async (url) => {
    await expect(new AnimeImageService().download(url)).rejects.toMatchObject({ status: 502 });
    expect(transport.lookup).not.toHaveBeenCalled();
    expect(transport.request).not.toHaveBeenCalled();
  });

  it.each([
    ['127.0.0.1', 4], ['10.0.0.1', 4], ['172.16.1.2', 4], ['192.168.0.1', 4], ['100.64.0.1', 4],
    ['169.254.169.254', 4], ['0.0.0.0', 4], ['224.0.0.1', 4], ['198.18.0.1', 4],
    ['::1', 6], ['::ffff:10.0.0.1', 6], ['fe80::1', 6], ['fd00::1', 6], ['2001:db8::1', 6],
  ])('blocks private and reserved DNS answers including mixed responses: %s', async (address, family) => {
    transport.lookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }, { address, family }]);
    await expect(new AnimeImageService().download(remoteUrl)).rejects.toMatchObject({ status: 502 });
    expect(transport.request).not.toHaveBeenCalled();
  });

  it('accepts public IPv6 and pins the resolved address', async () => {
    transport.lookup.mockResolvedValue([{ address: '2606:4700:4700::1111', family: 6 }]);
    mockDownload();
    await expect(new AnimeImageService().download(remoteUrl)).resolves.toMatchObject({ extension: 'webp' });
    const callback = vi.fn();
    transport.request.mock.calls[0]![1].lookup('cdn.example.com', {}, callback);
    expect(callback).toHaveBeenCalledWith(null, '2606:4700:4700::1111', 6);
  });

  it.each([301, 302, 307, 308, 403, 500])('rejects HTTP status %s without following redirects', async (status) => {
    mockDownload({ status });
    await expect(new AnimeImageService().download(remoteUrl)).rejects.toMatchObject({ status: 502 });
    expect(transport.request).toHaveBeenCalledTimes(1);
  });

  it.each([
    { type: 'image/svg+xml', bytes: Buffer.from('<svg></svg>') },
    { type: 'image/webp', bytes: Buffer.from('<html>error</html>') },
    { type: 'image/png', bytes: webp },
    { type: 'image/jpeg', bytes: Buffer.from([255, 216, 255, 224]) },
    { type: 'image/webp', bytes: webp.subarray(0, 20) },
  ])('rejects unsupported, mismatched, or invalid raster contents: %j', async (options) => {
    mockDownload(options);
    await expect(new AnimeImageService().download(remoteUrl)).rejects.toMatchObject({ status: 502 });
  });

  it('bounds both advertised and streamed download size to 20MiB', async () => {
    mockDownload({ length: String(20 * 1_024 * 1_024 + 1) });
    await expect(new AnimeImageService().download(remoteUrl)).rejects.toMatchObject({ status: 502, message: expect.stringContaining('20MiB') });
    mockDownload({ chunks: [Buffer.alloc(20 * 1_024 * 1_024), Buffer.alloc(1)] });
    await expect(new AnimeImageService().download(remoteUrl)).rejects.toMatchObject({ status: 502, message: expect.stringContaining('20MiB') });
  });

  it('bounds DNS lookup within the 30-second download timeout', async () => {
    const timeout = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal);
    transport.lookup.mockImplementation(() => new Promise(() => undefined));
    const pending = new AnimeImageService().download(remoteUrl);
    timeout.abort();
    await expect(pending).rejects.toMatchObject({ status: 504 });
    expect(timeoutSpy).toHaveBeenCalledWith(30_000);
    expect(transport.request).not.toHaveBeenCalled();
  });

  it('cancels an active download and sanitizes the cancellation reason', async () => {
    mockDownload({ pending: true });
    const controller = new AbortController();
    const pending = new AnimeImageService().download(remoteUrl, controller.signal);
    await vi.waitFor(() => expect(transport.request).toHaveBeenCalledTimes(1));
    controller.abort(new Error('ank-test-secret'));
    const error = await pending.catch((failure: Error) => failure);
    expect(error).toMatchObject({ status: 408 });
    expect(JSON.stringify(error)).not.toContain('ank-test-secret');
  });

  it('sanitizes DNS and transport errors and permits downloads without an API key', async () => {
    vi.stubEnv('ANIMEAPI_API_KEY', '');
    transport.lookup.mockRejectedValueOnce(new Error('ank-test-secret'));
    const service = new AnimeImageService();
    const dnsError = await service.download(remoteUrl).catch((failure: Error) => failure);
    expect(JSON.stringify(dnsError)).not.toContain('ank-test-secret');
    expect(dnsError).toMatchObject({ status: 502 });
    mockDownload({ error: new Error('ank-test-secret') });
    const networkError = await service.download(remoteUrl).catch((failure: Error) => failure);
    expect(JSON.stringify(networkError)).not.toContain('ank-test-secret');
    expect(networkError).toMatchObject({ status: 502 });
    mockDownload();
    await expect(service.download(remoteUrl)).resolves.toMatchObject({ extension: 'webp' });
  });
});
