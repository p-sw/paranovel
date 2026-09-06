import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnimeImageService, AnimeImageResult } from '../src/ai/anime-image.service';
import { CanonService } from '../src/canon/canon.service';
import { DatabaseService } from '../src/database/database.service';
import { episodeHighlights } from '../src/database/schema';
import { EpisodesService } from '../src/episodes/episodes.service';
import { HighlightStorageService } from '../src/highlights/highlight-storage.service';
import { HighlightsService } from '../src/highlights/highlights.service';
import { highlightParagraphs, type HighlightPlan } from '../src/highlights/highlight.schemas';
import { MemoryService } from '../src/memory/memory.service';
import { ProjectsService } from '../src/projects/projects.service';

const sourceContent = '하린은 은빛 머리카락을 뒤로 넘겼다.\n\n그녀의 초승달 귀걸이에 빛이 맺혔다.\n\n문이 열렸다.';
const plan: HighlightPlan = {
  afterParagraphId: 2, altText: '빛나는 초승달 귀걸이를 한 하린이 문을 여는 모습',
  prompt: 'Silver-haired Harin with violet eyes and a crescent earring opens a glowing door.',
  orientation: 'landscape', allowNSFW: false,
};
const providerResult = { imageUrl: 'https://images.example.com/highlight.png', enhancedPrompt: 'Enhanced illustration prompt', generationTimeMs: 900 };
const imageBytes = Buffer.from('persisted image bytes');
const planRunId = 'plan-run';
type PlanResult = { runId: string; value: HighlightPlan };

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe('episode highlight lifecycle', () => {
  let directory: string;
  let database: DatabaseService;
  let storage: HighlightStorageService;
  let projects: ProjectsService;
  let episodes: EpisodesService;
  let canon: CanonService;
  let memory: MemoryService;
  let service: HighlightsService;
  let projectId: string;
  let episodeId: string;
  let sourceRevision: number;
  const completeTool = vi.fn<(_input: { variables: Record<string, unknown> }) => Promise<PlanResult>>();
  const anime = {
    isConfigured: vi.fn(() => true),
    generate: vi.fn<AnimeImageService['generate']>(),
    download: vi.fn<AnimeImageService['download']>(),
  };

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'paranovel-highlights-'));
    vi.stubEnv('DB_PATH', join(directory, 'state.sqlite'));
    vi.stubEnv('IMAGE_STORAGE_PATH', join(directory, 'images'));
    vi.stubEnv('OPENROUTER_API_KEY', 'test-key');
    vi.stubEnv('ANIMEAPI_API_KEY', 'test-image-key');
    vi.stubEnv('OPENROUTER_EMBEDDING_DIMENSIONS', '4');
    completeTool.mockReset().mockResolvedValue({ runId: planRunId, value: plan });
    anime.isConfigured.mockReset().mockReturnValue(true);
    anime.generate.mockReset().mockResolvedValue(providerResult);
    anime.download.mockReset().mockResolvedValue({ bytes: imageBytes, extension: 'png', mimeType: 'image/png' });
    database = new DatabaseService();
    storage = new HighlightStorageService(database);
    projects = new ProjectsService(database);
    memory = new MemoryService(database, { embeddings: async (texts: string[]) => texts.map(() => [0, 1, 0, 1]) } as never);
    canon = new CanonService(database, memory, {} as never);
    episodes = new EpisodesService(database, projects, memory, {} as never);
    projectId = projects.createInternal({ title: '기록의 문', logline: '기억을 읽는 기록관', genreTags: ['판타지'] }).id;
    const episode = await episodes.create(projectId, { title: '빛나는 문', direction: '하린이 문을 연다.', content: sourceContent });
    episodeId = episode.id;
    sourceRevision = episode.revision;
    database.connection.prepare(`INSERT INTO ai_runs
      (id, task, project_id, episode_id, model, context_hash, status, created_at)
      VALUES (?, 'episode_highlight', ?, ?, 'test', 'context', 'SUCCEEDED', ?)`)
      .run(planRunId, projectId, episodeId, '2026-01-01T00:00:00.000Z');
    service = new HighlightsService(database, { completeTool } as never, anime as never, storage);
  });

  afterEach(() => {
    database.onApplicationShutdown();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  });

  function generate(key = 'request-1', expectedRevision = sourceRevision) {
    return service.generate(projectId, episodeId, { expectedRevision }, key);
  }

  function storedRow(id: string) {
    return database.orm.select().from(episodeHighlights).where(eq(episodeHighlights.id, id)).get()!;
  }

  function episodeRow() {
    return database.connection.prepare('SELECT * FROM episodes WHERE id = ?').get(episodeId);
  }

  function files() {
    const path = join(directory, 'images');
    return existsSync(path) ? readdirSync(path) : [];
  }

  it('stores an illustration and its anchor while preserving the episode, revision and indexed memory', async () => {
    await memory.indexSource({ projectId, sourceType: 'EPISODE', sourceId: episodeId, text: sourceContent });
    const stamp = '2026-01-01T00:00:00.000Z';
    database.connection.prepare(`INSERT INTO episode_summaries
      (episode_id, synopsis, source_revision, source_hash, updated_at) VALUES (?, ?, ?, ?, ?)`)
      .run(episodeId, '하린이 문을 연다.', sourceRevision, 'source-hash', stamp);
    database.connection.prepare('INSERT INTO scene_states (episode_id, location, source_revision, updated_at) VALUES (?, ?, ?, ?)')
      .run(episodeId, '문 앞', sourceRevision, stamp);
    const before = {
      episode: episodeRow(), memory: database.connection.prepare('SELECT * FROM memory_chunks').all(),
      summary: database.connection.prepare('SELECT * FROM episode_summaries').all(),
      scene: database.connection.prepare('SELECT * FROM scene_states').all(),
    };
    const result = await generate();
    expect(result.generation).toMatchObject({ status: 'SUCCEEDED', retryableDownload: false, idempotencyKey: 'request-1' });
    expect(result.image).toMatchObject({
      altText: plan.altText, generatedSourceRevision: sourceRevision, generatedSourceContent: sourceContent,
      anchorSourceContent: sourceContent, anchorText: highlightParagraphs(sourceContent)[1]!.text,
      anchorOffset: highlightParagraphs(sourceContent)[1]!.end,
    });
    const file = service.imageFile(projectId, episodeId, result.image!.id);
    expect(file.mimeType).toBe('image/png');
    expect(readFileSync(file.path)).toEqual(imageBytes);
    expect(storedRow(result.image!.id)).toMatchObject({ runId: planRunId, providerResultJson: JSON.stringify(providerResult) });
    expect(anime.generate).toHaveBeenCalledWith({ prompt: plan.prompt, orientation: plan.orientation, allowNSFW: plan.allowNSFW });
    expect({
      episode: episodeRow(), memory: database.connection.prepare('SELECT * FROM memory_chunks').all(),
      summary: database.connection.prepare('SELECT * FROM episode_summaries').all(),
      scene: database.connection.prepare('SELECT * FROM scene_states').all(),
    }).toEqual(before);
    expect(service.get(projectId, episodeId)).toEqual(result);
  });

  it('freezes only approved canon from the current project in the AI request and stored snapshot', async () => {
    const active = canon.persistCreate(projectId, { category: 'CHARACTER_APPEARANCE', name: '하린', content: '은발, 보라색 눈', aliases: ['기록관'] });
    const accepted = canon.persistCreate(projectId, { category: 'CHARACTER', name: '하린', content: '기억을 읽는다.', status: 'ACCEPTED' });
    canon.persistCreate(projectId, { category: 'CHARACTER_APPEARANCE', name: '미정 외형', content: '붉은 눈', status: 'PENDING' });
    canon.persistCreate(projectId, { category: 'CHARACTER_APPEARANCE', name: '제외 외형', content: '초록 눈', status: 'REJECTED' });
    const foreign = projects.createInternal({ title: '다른 작품', logline: '다른 주인공', genreTags: ['판타지'] });
    canon.persistCreate(foreign.id, { category: 'CHARACTER_APPEARANCE', name: '하린', content: '다른 작품의 검은 머리' });
    const pending = deferred<PlanResult>();
    completeTool.mockReturnValueOnce(pending.promise);
    const request = generate();
    const variables = completeTool.mock.calls[0]![0].variables;
    expect(variables.canon).toHaveLength(2);
    expect(variables.canon).toEqual(expect.arrayContaining([
      { ref: `canon:${active.id}`, revision: 1, category: active.category, name: active.name, aliases: ['기록관'], content: active.content },
      { ref: `canon:${accepted.id}`, revision: 1, category: accepted.category, name: accepted.name, aliases: [], content: accepted.content },
    ]));
    expect(variables.episode_paragraphs).toEqual(highlightParagraphs(sourceContent).map(({ id, text }) => ({ id, text })));
    canon.persistUpdate(projectId, active.id, { expectedRevision: active.revision, content: '새로 승인한 금발' });
    pending.resolve({ runId: planRunId, value: plan });
    const result = await request;
    expect(JSON.parse(storedRow(result.image!.id).canonSnapshotJson).canon).toEqual(variables.canon);
    expect(JSON.stringify(variables)).not.toMatch(/붉은 눈|초록 눈|다른 작품의|새로 승인한/);
  });

  it('replays a running or completed key without a second provider call and rejects competing requests', async () => {
    const pending = deferred<PlanResult>();
    completeTool.mockReturnValueOnce(pending.promise);
    const first = generate('same-key');
    expect((await generate('same-key')).generation?.status).toBe('RUNNING');
    await expect(generate('other-key')).rejects.toBeInstanceOf(ConflictException);
    await expect(generate('same-key', sourceRevision + 1)).rejects.toBeInstanceOf(ConflictException);
    expect(() => service.remove(projectId, episodeId, { expectedImageId: 'not-yet-created' })).toThrow(ConflictException);
    expect(completeTool).toHaveBeenCalledTimes(1);
    pending.resolve({ runId: planRunId, value: plan });
    const completed = await first;
    expect(await generate('same-key')).toEqual(completed);
    expect(anime.generate).toHaveBeenCalledTimes(1);
    expect(anime.download).toHaveBeenCalledTimes(1);
  });

  it('persists provider failure and never retries the paid request with the same key', async () => {
    anime.generate.mockRejectedValueOnce(new Error('ambiguous provider response'));
    const failed = await generate();
    expect(failed).toMatchObject({ image: null, generation: { status: 'FAILED', retryableDownload: false } });
    expect(await generate()).toEqual(failed);
    expect(completeTool).toHaveBeenCalledTimes(1);
    expect(anime.generate).toHaveBeenCalledTimes(1);
    expect(anime.download).not.toHaveBeenCalled();
    expect((await generate('explicit-new-request')).generation?.status).toBe('SUCCEEDED');
    expect(anime.generate).toHaveBeenCalledTimes(2);
  });

  it('retries only the persisted image URL after a failed download', async () => {
    anime.download.mockRejectedValueOnce(new Error('download interrupted'));
    const failed = await generate();
    expect(failed.generation).toMatchObject({ status: 'FAILED', retryableDownload: true });
    expect(storedRow(failed.generation!.id).providerResultJson).toBe(JSON.stringify(providerResult));
    const completed = await generate();
    expect(completed.generation).toMatchObject({ id: failed.generation!.id, status: 'SUCCEEDED' });
    expect(completeTool).toHaveBeenCalledTimes(1);
    expect(anime.generate).toHaveBeenCalledTimes(1);
    expect(anime.download).toHaveBeenCalledTimes(2);
    expect(anime.download).toHaveBeenLastCalledWith(providerResult.imageUrl);
  });

  it('rejects an AI-selected nonexistent paragraph before calling the paid provider', async () => {
    completeTool.mockResolvedValueOnce({ runId: planRunId, value: { ...plan, afterParagraphId: 99 } });
    const failed = await generate();
    expect(failed.generation).toMatchObject({ status: 'FAILED', retryableDownload: false });
    expect(anime.generate).not.toHaveBeenCalled();
    expect(anime.download).not.toHaveBeenCalled();
    expect(files()).toEqual([]);
  });

  it('keeps the original image source when prose is edited during provider generation', async () => {
    const pending = deferred<AnimeImageResult>();
    const started = deferred<void>();
    anime.generate.mockImplementationOnce(() => { started.resolve(); return pending.promise; });
    const request = generate();
    await started.promise;
    const newContent = `서문을 추가했다.\n\n${sourceContent}`;
    await episodes.update(projectId, episodeId, { expectedRevision: sourceRevision, content: newContent });
    const saved = episodeRow();
    pending.resolve(providerResult);
    const result = await request;
    expect(result.image).toMatchObject({
      generatedSourceRevision: sourceRevision, generatedSourceContent: sourceContent, anchorSourceContent: sourceContent,
    });
    expect(episodeRow()).toEqual(saved);
  });

  it('retains the current image and file when regeneration fails', async () => {
    const first = await generate();
    const originalFile = service.imageFile(projectId, episodeId, first.image!.id).path;
    anime.generate.mockRejectedValueOnce(new Error('provider unavailable'));
    const failed = await generate('regenerate');
    expect(failed.image).toEqual(first.image);
    expect(failed.generation).toMatchObject({ status: 'FAILED', idempotencyKey: 'regenerate' });
    expect(storedRow(first.image!.id).isCurrent).toBe(true);
    expect(readFileSync(originalFile)).toEqual(imageBytes);
    expect(files()).toEqual([storedRow(first.image!.id).fileName]);
  });

  it('guards placement against stale episode/image versions and changes only the anchor', async () => {
    const generated = await generate();
    const imageId = generated.image!.id;
    const newContent = `${sourceContent}\n\n하린은 문 너머로 걸음을 옮겼다.`;
    const edited = await episodes.update(projectId, episodeId, { expectedRevision: sourceRevision, content: newContent });
    const before = episodeRow();
    expect(() => service.place(projectId, episodeId, { expectedEpisodeRevision: sourceRevision, expectedImageId: imageId, afterParagraphId: 1 })).toThrow(ConflictException);
    expect(() => service.place(projectId, episodeId, { expectedEpisodeRevision: edited.revision, expectedImageId: 'stale-image', afterParagraphId: 1 })).toThrow(ConflictException);
    expect(() => service.place(projectId, episodeId, { expectedEpisodeRevision: edited.revision, expectedImageId: imageId, afterParagraphId: 99 })).toThrow(BadRequestException);
    const placed = service.place(projectId, episodeId, { expectedEpisodeRevision: edited.revision, expectedImageId: imageId, afterParagraphId: 4 });
    expect(placed.image).toMatchObject({
      id: imageId, generatedSourceRevision: sourceRevision, generatedSourceContent: sourceContent,
      anchorSourceContent: newContent, anchorText: '하린은 문 너머로 걸음을 옮겼다.', anchorOffset: newContent.length,
    });
    expect(episodeRow()).toEqual(before);
    expect(anime.generate).toHaveBeenCalledTimes(1);
  });

  it('removes an image and its file without changing prose or allowing stale-image removal', async () => {
    const result = await generate();
    const before = episodeRow();
    expect(() => service.remove(projectId, episodeId, { expectedImageId: 'stale-image' })).toThrow(ConflictException);
    expect(service.remove(projectId, episodeId, { expectedImageId: result.image!.id }).image).toBeNull();
    expect(() => service.imageFile(projectId, episodeId, result.image!.id)).toThrow(NotFoundException);
    expect(files()).toEqual([]);
    expect(database.connection.prepare('SELECT * FROM highlight_file_cleanup').all()).toEqual([]);
    expect(episodeRow()).toEqual(before);
    expect((await generate()).image).toBeNull();
    expect(anime.generate).toHaveBeenCalledTimes(1);
  });

  it('does not unlink a referenced image when a stale cleanup entry reuses its filename', async () => {
    const generated = await generate();
    const imageId = generated.image!.id;
    const fileName = storedRow(imageId).fileName!;
    database.connection.prepare('INSERT INTO highlight_file_cleanup(file_name) VALUES (?)').run(fileName);
    storage.cleanup();
    expect(readFileSync(service.imageFile(projectId, episodeId, imageId).path)).toEqual(imageBytes);
    expect(database.connection.prepare('SELECT * FROM highlight_file_cleanup').all()).toEqual([]);
    expect(service.get(projectId, episodeId).image).toEqual(generated.image);
  });

  it.each([false, true])('recovers interrupted generation after restart without another paid call (known URL: %s)', async (hasKnownUrl) => {
    const imageId = '11111111-1111-4111-8111-111111111111';
    const fileName = `${imageId}.png`;
    database.orm.insert(episodeHighlights).values({
      id: imageId, projectId, episodeId, idempotencyKey: 'interrupted', sourceRevision, sourceContent,
      canonSnapshotJson: '{}', status: 'RUNNING', isCurrent: false, runId: planRunId,
      planJson: JSON.stringify(plan), providerResultJson: hasKnownUrl ? JSON.stringify(providerResult) : null,
      fileName, mimeType: 'image/png', createdAt: '2026-01-01T00:00:00.000Z',
    }).run();
    await storage.write(fileName, imageBytes);
    database.onApplicationShutdown();
    database = new DatabaseService();
    storage = new HighlightStorageService(database);
    service = new HighlightsService(database, { completeTool } as never, anime as never, storage);
    service.onModuleInit();
    expect(service.get(projectId, episodeId)).toMatchObject({
      image: null, generation: { status: 'FAILED', retryableDownload: hasKnownUrl },
    });
    expect(files()).toEqual([]);
    expect(anime.generate).not.toHaveBeenCalled();
    expect(anime.download).not.toHaveBeenCalled();
    const replay = await generate('interrupted');
    expect(replay.generation?.status).toBe(hasKnownUrl ? 'SUCCEEDED' : 'FAILED');
    expect(completeTool).not.toHaveBeenCalled();
    expect(anime.generate).not.toHaveBeenCalled();
    expect(anime.download).toHaveBeenCalledTimes(hasKnownUrl ? 1 : 0);
  });

  it.each(['episode', 'project'] as const)('cleans a file that arrives after its %s is deleted in flight', async (target) => {
    const beforeWrite = deferred<void>();
    const resumeWrite = deferred<void>();
    const actualWrite = storage.write.bind(storage);
    vi.spyOn(storage, 'write').mockImplementationOnce(async (fileName, bytes) => {
      beforeWrite.resolve();
      await resumeWrite.promise;
      await actualWrite(fileName, bytes);
    });
    const request = generate();
    await beforeWrite.promise;
    if (target === 'episode') episodes.remove(projectId, episodeId, { expectedRevision: sourceRevision });
    else projects.remove(projectId);
    const rejection = expect(request).rejects.toBeInstanceOf(NotFoundException);
    resumeWrite.resolve();
    await rejection;
    expect(database.connection.prepare('SELECT * FROM episode_highlights').all()).toEqual([]);
    expect(files()).toEqual([]);
    expect(database.connection.prepare('SELECT * FROM highlight_file_cleanup').all()).toEqual([]);
    expect(() => service.get(projectId, episodeId)).toThrow(NotFoundException);
  });

  it.each(['episode', 'project'] as const)('deletes a completed image file with its %s', async (target) => {
    await generate();
    expect(files()).toHaveLength(1);
    if (target === 'episode') episodes.remove(projectId, episodeId, { expectedRevision: sourceRevision });
    else projects.remove(projectId);
    expect(files()).toEqual([]);
    expect(database.connection.prepare('SELECT * FROM episode_highlights').all()).toEqual([]);
    expect(database.connection.prepare('SELECT * FROM highlight_file_cleanup').all()).toEqual([]);
  });
});
