import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseService } from '../src/database/database.service';
import { HighlightStorageService } from '../src/highlights/highlight-storage.service';
import { HighlightsController } from '../src/highlights/highlights.controller';
import { HighlightsService } from '../src/highlights/highlights.service';
import { ApiExceptionFilter } from '../src/shared/api-exception.filter';

const source = '성문 앞에 선 서아.\n\n은빛 머리 위로 달이 떠올랐다. 🌙';
const plan = {
  afterParagraphId: 2, altText: '달빛 아래 서 있는 은빛 머리의 서아',
  prompt: 'Silver-haired Seo-a stands at the castle gate under the moon.', orientation: 'portrait', allowNSFW: false,
};
const mediaBytes = Buffer.from('RIFF\x10\x00\x00\x00WEBPVP8 \x04\x00\x00\x00\x00\x00\x00\x00', 'binary');
const root = '/api/projects/project-one/episodes/episode-one/highlight';

interface HighlightState {
  configured: boolean;
  image: {
    id: string; url: string; altText: string; generatedSourceContent: string;
    anchorText: string; anchorOffset: number;
  } | null;
  generation: { id: string; status: string; idempotencyKey: string } | null;
}

describe('highlight HTTP routes', () => {
  let database: DatabaseService;
  let directory: string;
  let app: INestApplication;
  let origin: string;
  const ai = { completeTool: vi.fn() };
  const anime = { isConfigured: vi.fn(), generate: vi.fn(), download: vi.fn() };

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'paranovel-highlight-routes-'));
    vi.stubEnv('DB_PATH', join(directory, 'paranovel.sqlite'));
    vi.stubEnv('IMAGE_STORAGE_PATH', join(directory, 'images'));
    vi.stubEnv('OPENROUTER_EMBEDDING_DIMENSIONS', '4');
    vi.stubEnv('OPENROUTER_API_KEY', 'test-router-key');
    vi.stubEnv('ANIMEAPI_API_KEY', 'test-anime-key');
    database = new DatabaseService();
    const project = database.connection.prepare('INSERT INTO projects(id, title, logline, created_at, updated_at) VALUES (?, ?, ?, ?, ?)');
    project.run('project-one', '달빛 성문', '성문을 지키는 서아', '2026-09-06', '2026-09-06');
    project.run('project-two', '다른 작품', '다른 이야기', '2026-09-06', '2026-09-06');
    const episode = database.connection.prepare('INSERT INTO episodes(id, project_id, number, title, direction, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    episode.run('episode-one', 'project-one', 1, '달이 뜬 밤', '성문을 지킨다', source, '2026-09-06', '2026-09-06');
    episode.run('episode-two', 'project-one', 2, '다음 날', '아침이 온다', '아침이 밝았다.', '2026-09-06', '2026-09-06');
    episode.run('episode-other-project', 'project-two', 1, '다른 밤', '다른 사건', '해가 졌다.', '2026-09-06', '2026-09-06');
    database.connection.prepare('INSERT INTO ai_runs(id, task, project_id, episode_id, model, context_hash, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run('highlight-test-run', 'episode_highlight', 'project-one', 'episode-one', 'test-model', 'test-hash', 'SUCCEEDED', '2026-09-06');
    ai.completeTool.mockReset().mockResolvedValue({ runId: 'highlight-test-run', value: plan });
    anime.isConfigured.mockReset().mockReturnValue(true);
    anime.generate.mockReset().mockResolvedValue({ imageUrl: 'https://cdn.example.com/image.webp' });
    anime.download.mockReset().mockResolvedValue({ bytes: mediaBytes, mimeType: 'image/webp', extension: 'webp' });
    const service = new HighlightsService(database, ai as never, anime as never, new HighlightStorageService(database));
    // Vitest's esbuild transform omits the constructor metadata emitted by tsc.
    Reflect.defineMetadata('design:paramtypes', [HighlightsService], HighlightsController);
    const module = await Test.createTestingModule({
      controllers: [HighlightsController], providers: [{ provide: HighlightsService, useValue: service }],
    }).compile();
    app = module.createNestApplication({ logger: false });
    app.setGlobalPrefix('api');
    app.useGlobalFilters(new ApiExceptionFilter());
    await app.listen(0, '127.0.0.1');
    origin = await app.getUrl();
  });

  afterEach(async () => {
    await app?.close();
    database?.onApplicationShutdown();
    if (directory) rmSync(directory, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  function request(path: string, method = 'GET', body?: unknown, key?: string): Promise<Response> {
    return fetch(`${origin}${path}`, {
      method,
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(key ? { 'Idempotency-Key': key } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  it('reports initial state and enforces configuration, revision and idempotency input through HTTP', async () => {
    const initial = await request(root);
    expect(initial.status).toBe(200);
    expect(await initial.json()).toEqual({ configured: true, image: null, generation: null });
    expect((await request(`${root}/generate`, 'POST', { expectedRevision: 1 })).status).toBe(400);
    expect((await request(`${root}/generate`, 'POST', {}, 'missing-revision')).status).toBe(400);
    expect((await request(`${root}/generate`, 'POST', { expectedRevision: 2 }, 'stale-revision')).status).toBe(409);
    anime.isConfigured.mockReturnValue(false);
    expect(await (await request(root)).json()).toMatchObject({ configured: false });
    const missingKey = await request(`${root}/generate`, 'POST', { expectedRevision: 1 }, 'missing-key');
    expect(missingKey.status).toBe(503);
    expect(await missingKey.json()).toMatchObject({ code: 'SERVICE_UNAVAILABLE', message: expect.stringContaining('ANIMEAPI_API_KEY') });
    expect(ai.completeTool).not.toHaveBeenCalled();
    expect(anime.generate).not.toHaveBeenCalled();
  });

  it('serves the saved raster and applies placement/removal conflicts without exposing images through other episodes', async () => {
    const generatedResponse = await request(`${root}/generate`, 'POST', { expectedRevision: 1 }, 'generate-one');
    expect(generatedResponse.status).toBe(200);
    const generated = await generatedResponse.json() as HighlightState;
    expect(generated.generation).toMatchObject({ status: 'SUCCEEDED', idempotencyKey: 'generate-one' });
    expect(generated.image).toMatchObject({ altText: plan.altText, generatedSourceContent: source });
    const image = generated.image!;
    expect(image.url).toBe(`${root}/${image.id}/image`);
    const media = await request(image.url);
    expect(media.status).toBe(200);
    expect(media.headers.get('content-type')).toBe('image/webp');
    expect(media.headers.get('x-content-type-options')).toBe('nosniff');
    expect(Buffer.from(await media.arrayBuffer())).toEqual(mediaBytes);
    expect((await request(`/api/projects/project-two/episodes/episode-one/highlight/${image.id}/image`)).status).toBe(404);
    expect((await request(`/api/projects/project-one/episodes/episode-two/highlight/${image.id}/image`)).status).toBe(404);
    expect((await request(`/api/projects/project-two/episodes/episode-other-project/highlight/${image.id}/image`)).status).toBe(404);

    const placement = { expectedEpisodeRevision: 1, expectedImageId: image.id, afterParagraphId: 1 };
    expect((await request(`${root}/placement`, 'PATCH', { ...placement, expectedEpisodeRevision: 2 })).status).toBe(409);
    expect((await request(`${root}/placement`, 'PATCH', { ...placement, expectedImageId: 'old-image' })).status).toBe(409);
    const placed = await request(`${root}/placement`, 'PATCH', placement);
    expect(placed.status).toBe(200);
    expect(await placed.json()).toMatchObject({ image: { id: image.id, anchorText: '성문 앞에 선 서아.', anchorOffset: '성문 앞에 선 서아.'.length, generatedSourceContent: source } });

    expect((await request(root, 'DELETE', { expectedImageId: 'old-image' })).status).toBe(409);
    const removed = await request(root, 'DELETE', { expectedImageId: image.id });
    expect(removed.status).toBe(200);
    expect(await removed.json()).toMatchObject({ image: null });
    expect((await request(image.url)).status).toBe(404);
    expect(readdirSync(join(directory, 'images'))).toEqual([]);
    expect(database.connection.prepare('SELECT content FROM episodes WHERE id = ?').get('episode-one')).toEqual({ content: source });
  });

  it('returns pending state and HTTP 202 for an identical in-flight request while blocking a second generation', async () => {
    let finish!: (value: { imageUrl: string }) => void;
    anime.generate.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const pending = request(`${root}/generate`, 'POST', { expectedRevision: 1 }, 'pending-one');
    try {
      await vi.waitFor(() => expect(anime.generate).toHaveBeenCalledTimes(1));
      const state = await request(root);
      expect(state.status).toBe(200);
      expect(await state.json()).toMatchObject({ image: null, generation: { status: 'RUNNING', idempotencyKey: 'pending-one' } });
      const replay = await request(`${root}/generate`, 'POST', { expectedRevision: 1 }, 'pending-one');
      expect(replay.status).toBe(202);
      expect(await replay.json()).toMatchObject({ generation: { status: 'RUNNING', idempotencyKey: 'pending-one' } });
      expect((await request(`${root}/generate`, 'POST', { expectedRevision: 1 }, 'pending-two')).status).toBe(409);
    } finally {
      finish({ imageUrl: 'https://cdn.example.com/image.webp' });
    }
    const completed = await pending;
    expect(completed.status).toBe(200);
    const generated = await completed.json() as HighlightState;
    expect(generated.generation?.status).toBe('SUCCEEDED');
    const replay = await request(`${root}/generate`, 'POST', { expectedRevision: 1 }, 'pending-one');
    expect(replay.status).toBe(200);
    expect((await replay.json() as HighlightState).image?.id).toBe(generated.image?.id);
    expect((await request(`${root}/generate`, 'POST', { expectedRevision: 2 }, 'pending-one')).status).toBe(409);
    expect(ai.completeTool).toHaveBeenCalledTimes(1);
    expect(anime.generate).toHaveBeenCalledTimes(1);
    expect(anime.download).toHaveBeenCalledTimes(1);
  });
});
