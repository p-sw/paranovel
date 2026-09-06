import { BadRequestException, ConflictException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseService } from '../src/database/database.service';
import { episodes, sceneStates } from '../src/database/schema';
import { EpisodesController } from '../src/episodes/episodes.controller';
import { EpisodesService, type StreamEvent } from '../src/episodes/episodes.service';
import { MemoryService } from '../src/memory/memory.service';
import { ProjectsService } from '../src/projects/projects.service';

const extraction = {
  events: ['문을 열었다.'], emotionalChanges: [], newForeshadowing: [], resolvedForeshadowing: [],
  endScene: { location: '문 앞', time: null, pointOfView: null, characters: [], goal: null },
  canonCandidates: [],
};
const completion = (content = '새 원고') => ({
  runId: 'test-run', result: { content, toolCalls: [], usage: {}, model: 'test' },
});
const issue = {
  category: 'SCENE', severity: 'WARNING', excerpt: '문', explanation: '문의 위치가 모호하다.',
  evidenceRefs: [], repairInstruction: '문의 위치를 명확히 쓴다.',
};

describe('episode order', () => {
  let database: DatabaseService;
  let projects: ProjectsService;
  let memory: MemoryService;
  let service: EpisodesService;
  let projectId: string;
  let ai: { completeJson: ReturnType<typeof vi.fn>; streamText: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.stubEnv('DB_PATH', ':memory:');
    vi.stubEnv('OPENROUTER_EMBEDDING_DIMENSIONS', '4');
    database = new DatabaseService();
    projects = new ProjectsService(database);
    memory = new MemoryService(database, {
      embeddings: vi.fn(async (texts: string[]) => texts.map(() => [1, 0.5, 0.25, 0.125])),
    } as never);
    ai = { completeJson: vi.fn(async () => ({ value: extraction })), streamText: vi.fn() };
    service = new EpisodesService(database, projects, memory, ai as never);
    projectId = projects.createInternal({ title: '기록관', logline: '기억을 정리한다.', genreTags: ['판타지'] }).id;
  });

  afterEach(() => {
    database.onApplicationShutdown();
    vi.unstubAllEnvs();
  });

  async function createEpisodes(count: number) {
    const created = [];
    for (let index = 0; index < count; index += 1) {
      created.push(await service.create(projectId, {
        title: `제목 ${index + 1}`, direction: `전개 ${index + 1}`, content: `내용 ${index + 1}`,
      }));
    }
    return created;
  }

  function save(slots: Array<string | null>) {
    return service.updateOrder(projectId, { slots, expectedRevision: service.order(projectId).revision });
  }

  it('returns order from the static GET route and atomically swaps real cards through PUT', async () => {
    const [first, second] = await createEpisodes(2);
    // Vitest's transpiler omits the constructor metadata emitted by production tsc.
    Reflect.defineMetadata('design:paramtypes', [EpisodesService], EpisodesController);
    const module = await Test.createTestingModule({
      controllers: [EpisodesController], providers: [{ provide: EpisodesService, useValue: service }],
    }).compile();
    const app = module.createNestApplication();
    await app.init();
    try {
      const before = await request(app.getHttpServer()).get(`/projects/${projectId}/episodes/order`).expect(200);
      expect(before.body.slots).toEqual([first!.id, second!.id]);
      const saved = await request(app.getHttpServer()).put(`/projects/${projectId}/episodes/order`)
        .send({ slots: [second!.id, first!.id], expectedRevision: before.body.revision }).expect(200);
      expect(saved.body.slots).toEqual([second!.id, first!.id]);
      expect(service.list(projectId).map(({ id, number, revision, title, direction, content }) => ({ id, number, revision, title, direction, content }))).toEqual([
        { id: second!.id, number: 1, revision: 2, title: second!.title, direction: second!.direction, content: second!.content },
        { id: first!.id, number: 2, revision: 2, title: first!.title, direction: first!.direction, content: first!.content },
      ]);
      expect(projects.get(projectId).nextEpisodeNumber).toBe(3);
      await request(app.getHttpServer()).put(`/projects/${projectId}/episodes/order`)
        .send({ slots: [first!.id, second!.id], expectedRevision: before.body.revision }).expect(409);
    } finally {
      await app.close();
    }
  });

  it('represents leading and interior gaps, moves them to the end, and removes only requested slots', async () => {
    const [first, second, third, fourth] = await createEpisodes(4);
    service.remove(projectId, first!.id, { expectedRevision: first!.revision });
    service.remove(projectId, third!.id, { expectedRevision: service.get(projectId, third!.id).revision });
    expect(service.order(projectId).slots).toEqual([null, second!.id, null, fourth!.id]);

    expect(save([second!.id, fourth!.id, null, null]).slots).toEqual([second!.id, fourth!.id, null, null]);
    expect(projects.get(projectId).nextEpisodeNumber).toBe(5);
    const before = service.list(projectId);
    expect(save([second!.id, fourth!.id, null]).slots).toEqual([second!.id, fourth!.id, null]);
    expect(service.list(projectId)).toEqual(before);
    expect(projects.get(projectId).nextEpisodeNumber).toBe(4);
    expect((await service.create(projectId, { title: '다음 회차' })).number).toBe(4);
  });

  it('collapses a removed leading placeholder and starts again at one after removing every card', async () => {
    const [first, second] = await createEpisodes(2);
    service.remove(projectId, first!.id, { expectedRevision: first!.revision });
    expect(save([second!.id]).episodes[0]).toMatchObject({ id: second!.id, number: 1 });
    service.remove(projectId, second!.id, { expectedRevision: service.get(projectId, second!.id).revision });
    expect(service.order(projectId).slots).toEqual([]);
    expect((await service.create(projectId, { title: '다시 시작' })).number).toBe(1);
  });

  it('shrinks only a deleted final slot, keeping remaining placeholders when no real cards remain', async () => {
    const [first, second] = await createEpisodes(2);
    service.remove(projectId, first!.id, { expectedRevision: first!.revision });
    service.remove(projectId, second!.id, { expectedRevision: service.get(projectId, second!.id).revision });
    expect(service.order(projectId)).toMatchObject({ slots: [null], episodes: [] });
    expect(projects.get(projectId).nextEpisodeNumber).toBe(2);
    expect(save([]).slots).toEqual([]);
    expect(projects.get(projectId).nextEpisodeNumber).toBe(1);
  });

  it('retains explicit trailing placeholders when deleting the highest real episode', async () => {
    const [first, second] = await createEpisodes(2);
    service.remove(projectId, first!.id, { expectedRevision: first!.revision });
    save([second!.id, null]);
    service.remove(projectId, second!.id, { expectedRevision: service.get(projectId, second!.id).revision });
    expect(service.order(projectId).slots).toEqual([null, null]);
    expect((await service.create(projectId, { title: '이어 쓰기' })).number).toBe(3);
  });

  it('rejects real-card deletion, duplicates, foreign IDs, malformed slots and placeholder additions without writes', async () => {
    const [first, second] = await createEpisodes(2);
    const otherProject = projects.createInternal({ title: '다른 작품', logline: '다른 이야기', genreTags: ['판타지'] });
    const foreign = await service.create(otherProject.id, { title: '다른 회차' });
    const before = service.order(projectId);
    for (const slots of [
      [], [first!.id], [first!.id, first!.id], [first!.id, foreign.id],
      [first!.id, second!.id, null], [first!.id, 2], 'invalid', null,
    ]) {
      expect(() => service.updateOrder(projectId, { slots, expectedRevision: before.revision })).toThrow(BadRequestException);
      expect(service.order(projectId)).toEqual(before);
    }
  });

  it.each(['create', 'delete', 'edit', 'reorder'] as const)('rejects an order snapshot made stale by %s', async (change) => {
    const [first, second] = await createEpisodes(2);
    const before = service.order(projectId);
    if (change === 'create') await service.create(projectId, { title: '추가' });
    if (change === 'delete') service.remove(projectId, second!.id, { expectedRevision: second!.revision });
    if (change === 'edit') await service.update(projectId, first!.id, { title: '수정', expectedRevision: first!.revision });
    if (change === 'reorder') save([second!.id, first!.id]);
    const changed = service.order(projectId);
    expect(() => service.updateOrder(projectId, { slots: before.slots, expectedRevision: before.revision })).toThrow(ConflictException);
    expect(service.order(projectId)).toEqual(changed);
  });

  it('does not change revisions or memory for an unchanged layout', async () => {
    const [first] = await createEpisodes(1);
    await service.finalize(projectId, first!.id, { expectedRevision: first!.revision });
    const before = service.order(projectId);
    const removeMemory = vi.spyOn(memory, 'removeSource');
    expect(save(before.slots)).toEqual(before);
    expect(removeMemory).not.toHaveBeenCalled();
  });

  it('invalidates only the affected suffix while preserving review and draft states', async () => {
    const [first, second, third, fourth, fifth] = await createEpisodes(5);
    for (const episode of [first!, second!, fifth!]) {
      await service.finalize(projectId, episode.id, { expectedRevision: episode.revision });
    }
    database.orm.update(episodes).set({ status: 'NEEDS_REVIEW' }).where(eq(episodes.id, third!.id)).run();
    const before = service.get(projectId, first!.id);
    const ordered = save([first!.id, third!.id, second!.id, fourth!.id, fifth!.id]);
    expect(ordered.episodes.map(({ id, revision, status }) => ({ id, revision, status }))).toEqual([
      { id: first!.id, revision: 1, status: 'CONFIRMED' },
      { id: third!.id, revision: 2, status: 'NEEDS_REVIEW' },
      { id: second!.id, revision: 2, status: 'MEMORY_STALE' },
      { id: fourth!.id, revision: 2, status: 'DRAFT' },
      { id: fifth!.id, revision: 2, status: 'MEMORY_STALE' },
    ]);
    expect(service.get(projectId, first!.id)).toEqual(before);
    expect(service.get(projectId, fifth!.id).summary?.stale).toBe(true);
    expect(database.orm.select().from(sceneStates).where(eq(sceneStates.episodeId, fifth!.id)).get()?.sourceRevision).toBe(1);
    expect(database.connection.prepare('SELECT DISTINCT source_id FROM memory_chunks').all()).toEqual([{ source_id: first!.id }]);
  });

  it('rolls back all number, revision, counter and memory changes if persistence fails', async () => {
    const [first, second] = await createEpisodes(2);
    await service.finalize(projectId, first!.id, { expectedRevision: first!.revision });
    const before = service.order(projectId);
    const chunks = database.connection.prepare('SELECT * FROM memory_chunks').all();
    database.connection.exec(`CREATE TRIGGER reject_episode_counter BEFORE UPDATE OF next_episode_number ON projects
      BEGIN SELECT RAISE(ABORT, 'forced counter failure'); END;`);
    expect(() => save([second!.id, first!.id])).toThrow('forced counter failure');
    expect(service.order(projectId)).toEqual(before);
    expect(database.connection.prepare('SELECT * FROM memory_chunks').all()).toEqual(chunks);
    expect(projects.get(projectId).nextEpisodeNumber).toBe(3);
  });

  it.each(['propose', 'refine'] as const)('rejects %s results when the order changes while AI is pending', async (operation) => {
    const [first, second] = await createEpisodes(2);
    let finish!: (value: { value: unknown }) => void;
    ai.completeJson.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const pending = operation === 'propose'
      ? service.propose(projectId, { hint: '다음 전개' })
      : service.refine(projectId, { title: '제목', direction: '방향', instruction: '짧게' });
    await vi.waitFor(() => expect(ai.completeJson).toHaveBeenCalledOnce());
    save([second!.id, first!.id]);
    const rejected = expect(pending).rejects.toThrow(ConflictException);
    finish({ value: { title: '새 제목', direction: '새 방향', conflicts: [] } });
    await rejected;
  });

  it.each(['generate', 'repairDraft', 'continue'] as const)('rejects pending %s completion after reorder without emitting done', async (operation) => {
    const [first, second] = await createEpisodes(2);
    service.updateScene(projectId, second!.id, { expectedRevision: second!.revision, location: '문 앞' });
    let finish!: (value: ReturnType<typeof completion>) => void;
    ai.streamText.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    ai.completeJson.mockResolvedValue({ value: { issues: [] } });
    const events: StreamEvent[] = [];
    const emit = (event: StreamEvent) => events.push(event);
    const pending = operation === 'generate'
      ? service.generate(projectId, { title: '제목', direction: '방향' }, emit)
      : operation === 'repairDraft'
        ? service.repairDraft(projectId, { title: '제목', direction: '방향', content: '원고', issue }, emit)
        : service.continue(projectId, second!.id, { expectedRevision: second!.revision, cursorOffset: 0 }, emit);
    await vi.waitFor(() => expect(ai.streamText).toHaveBeenCalledOnce());
    save([second!.id, first!.id]);
    const rejected = expect(pending).rejects.toThrow(ConflictException);
    finish(completion());
    await rejected;
    expect(events.some((event) => event.type === 'done')).toBe(false);
  });

  it('does not save a pending memory extraction after its episode was renumbered', async () => {
    const [first, second] = await createEpisodes(2);
    let finish!: (value: { value: typeof extraction }) => void;
    ai.completeJson.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const pending = service.finalize(projectId, second!.id, { expectedRevision: second!.revision });
    await vi.waitFor(() => expect(ai.completeJson).toHaveBeenCalledOnce());
    save([second!.id, first!.id]);
    const rejected = expect(pending).rejects.toThrow(ConflictException);
    finish({ value: extraction });
    await rejected;
    expect(service.get(projectId, second!.id).summary).toBeNull();
    expect(database.connection.prepare('SELECT * FROM memory_chunks').all()).toEqual([]);
  });

  it('does not overwrite a newer scene with extraction started before a reorder', async () => {
    const [first, second] = await createEpisodes(2);
    let finish!: (value: { value: typeof extraction.endScene }) => void;
    ai.completeJson.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const pending = service.continue(projectId, second!.id, { expectedRevision: second!.revision, cursorOffset: 0 }, () => undefined);
    await vi.waitFor(() => expect(ai.completeJson).toHaveBeenCalledOnce());
    save([second!.id, first!.id]);
    service.updateScene(projectId, second!.id, { expectedRevision: service.get(projectId, second!.id).revision, location: '새 장면' });
    const rejected = expect(pending).rejects.toThrow(ConflictException);
    finish({ value: extraction.endScene });
    await rejected;
    expect(service.getScene(projectId, second!.id).location).toBe('새 장면');
    expect(ai.streamText).not.toHaveBeenCalled();
  });
});
