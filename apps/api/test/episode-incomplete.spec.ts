import { BadRequestException, ConflictException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContinuityIssue } from '../src/ai/ai.types';
import { DatabaseService } from '../src/database/database.service';
import { EpisodesService, type StreamEvent } from '../src/episodes/episodes.service';
import { MemoryService } from '../src/memory/memory.service';
import { ProjectsService } from '../src/projects/projects.service';

const plan = { title: '닫힌 문', direction: '주인공이 문을 연다.' };
const completion = (content: string) => ({
  runId: 'draft-run', result: { content, toolCalls: [], usage: {}, model: 'test' },
});

describe('persistent incomplete episodes', () => {
  let database: DatabaseService;
  let projects: ProjectsService;
  let projectId: string;

  beforeEach(() => {
    vi.stubEnv('DB_PATH', ':memory:');
    vi.stubEnv('OPENROUTER_EMBEDDING_DIMENSIONS', '4');
    database = new DatabaseService();
    projects = new ProjectsService(database);
    projectId = projects.createInternal({ title: '문', logline: '문 너머를 찾는다.', genreTags: ['판타지'] }).id;
  });

  afterEach(() => {
    database.onApplicationShutdown();
    vi.unstubAllEnvs();
  });

  function fixture() {
    const memory = new MemoryService(database, {} as never);
    vi.spyOn(memory, 'search').mockResolvedValue([]);
    const ai = {
      streamText: vi.fn(async (_input: unknown, onDelta: (text: string) => void, onRun?: (runId: string) => void) => {
        onRun?.('draft-run');
        onDelta('문을 열었다.');
        return completion('문을 열었다.');
      }),
      completeJson: vi.fn(async (_input: unknown) => ({ value: { ...plan, conflicts: [], issues: [] } })),
    };
    const service = new EpisodesService(database, projects, memory, ai as never);
    return { service, memory, ai };
  }

  function seedMemory(episode: { id: string; revision: number }, location: string) {
    database.connection.prepare("UPDATE episodes SET status = 'CONFIRMED' WHERE id = ?").run(episode.id);
    database.connection.prepare(`INSERT INTO episode_summaries
      (episode_id, synopsis, source_revision, source_hash, updated_at)
      VALUES (?, ?, ?, 'hash', '2026-09-01')`).run(episode.id, `${location}에 도착했다.`, episode.revision);
    database.connection.prepare(`INSERT INTO scene_states
      (episode_id, location, source_revision, updated_at)
      VALUES (?, ?, ?, '2026-09-01')`).run(episode.id, location, episode.revision);
  }

  it('reserves one reusable episode for a plan and transitions to an editable draft without consuming another number', async () => {
    const { service } = fixture();
    const input = { ...plan, incomplete: true };
    const reserved = await service.create(projectId, input, 'plan-request');
    expect(await service.create(projectId, input, 'plan-request')).toEqual(reserved);
    expect(service.list(projectId)).toEqual([expect.objectContaining({ ...plan, status: 'INCOMPLETE', content: '', number: 1 })]);

    const refined = await service.update(projectId, reserved.id, {
      title: '문 너머', direction: '문 너머의 동료를 만난다.', expectedRevision: reserved.revision,
    });
    expect(refined).toMatchObject({ id: reserved.id, status: 'INCOMPLETE', revision: 2 });
    const opened = await service.update(projectId, reserved.id, { expectedRevision: refined.revision, incomplete: false });
    expect(opened).toMatchObject({ id: reserved.id, status: 'DRAFT', number: 1, revision: 3 });
    const cancelled = await service.update(projectId, reserved.id, { expectedRevision: opened.revision, content: '', incomplete: true });
    expect(cancelled.status).toBe('INCOMPLETE');
    const written = await service.update(projectId, reserved.id, { expectedRevision: cancelled.revision, content: '동료를 만났다.' });
    expect(written).toMatchObject({ status: 'DRAFT', number: 1 });
    expect(service.list(projectId)).toHaveLength(1);
    expect(projects.get(projectId).nextEpisodeNumber).toBe(2);
    await expect(service.update(projectId, reserved.id, { expectedRevision: refined.revision, incomplete: true, content: '' }))
      .rejects.toBeInstanceOf(ConflictException);
  });

  it('keeps empty manual drafts as drafts and never hides review requirements or content behind the incomplete status', async () => {
    const { service } = fixture();
    const manual = await service.create(projectId, plan);
    expect(manual.status).toBe('DRAFT');
    await expect(service.create(projectId, { ...plan, content: '원고', incomplete: true })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.create(projectId, { ...plan, incomplete: 'true' })).rejects.toBeInstanceOf(BadRequestException);
    const review = await service.update(projectId, manual.id, { expectedRevision: manual.revision, content: '원고', forceNeedsReview: true });
    await expect(service.update(projectId, manual.id, { expectedRevision: review.revision, incomplete: true })).rejects.toBeInstanceOf(BadRequestException);
    expect((await service.update(projectId, manual.id, { expectedRevision: review.revision, content: '고친 원고', incomplete: false })).status).toBe('NEEDS_REVIEW');
  });

  it('preserves incomplete plans when earlier content changes and when episode slots move', async () => {
    const { service } = fixture();
    const first = await service.create(projectId, { ...plan, content: '첫 회차.' });
    const reserved = await service.create(projectId, { ...plan, incomplete: true });
    await service.update(projectId, first.id, { expectedRevision: first.revision, content: '고친 첫 회차.' });
    expect(service.get(projectId, reserved.id).status).toBe('INCOMPLETE');
    service.updateOrder(projectId, { expectedRevision: service.order(projectId).revision, slots: [reserved.id, first.id] });
    expect(service.get(projectId, reserved.id)).toMatchObject({ number: 1, status: 'INCOMPLETE' });
  });

  it('generates and reviews the reserved episode using only its predecessors and their last scene', async () => {
    const { service, memory, ai } = fixture();
    const previous = await service.create(projectId, { ...plan, content: '문 앞에 섰다.' });
    seedMemory(previous, '문 앞');
    const reserved = await service.create(projectId, { ...plan, incomplete: true });
    const future = await service.create(projectId, { ...plan, content: '미래의 성에 도착했다.' });
    seedMemory(future, '미래의 성');
    const events: StreamEvent[] = [];

    await service.generate(projectId, { ...plan, episodeId: reserved.id, expectedRevision: reserved.revision }, (event) => events.push(event));

    const request = ai.streamText.mock.calls[0]![0] as { variables: Record<string, string> };
    expect(JSON.parse(request.variables.current_scene!)).toMatchObject({ location: '문 앞', previousParagraph: '문 앞에 섰다.' });
    expect(request.variables.recent_summaries).toContain('문 앞에 도착했다.');
    expect(request.variables.recent_summaries).not.toContain('미래의 성');
    expect(memory.search).toHaveBeenCalledWith(projectId, expect.any(String), 12, reserved.number);
    expect(ai.streamText).toHaveBeenCalledWith(expect.objectContaining({ episodeId: reserved.id, baseRevision: reserved.revision }), expect.any(Function), expect.any(Function));
    expect(ai.completeJson).toHaveBeenCalledWith(expect.objectContaining({ task: 'continuity_review', episodeId: reserved.id }));
    expect(events.at(-1)).toEqual({ type: 'done', content: '문을 열었다.', blocked: false, issues: [], baseRevision: reserved.revision });
    expect(service.get(projectId, reserved.id)).toEqual(reserved);
    expect(projects.get(projectId).nextEpisodeNumber).toBe(4);
  });

  it.each(['propose', 'refine'] as const)('uses the reserved plan history for %s and avoids refreshing later stale episodes', async (operation) => {
    const { service, memory, ai } = fixture();
    const reserved = await service.create(projectId, { ...plan, incomplete: true });
    const future = await service.create(projectId, { ...plan, content: '미래 회차.' });
    database.connection.prepare("UPDATE episodes SET status = 'MEMORY_STALE' WHERE id = ?").run(future.id);
    await service[operation](projectId, { ...plan, instruction: '제목을 바꿔줘.', episodeId: reserved.id, expectedRevision: reserved.revision });
    expect(memory.search).toHaveBeenCalledWith(projectId, expect.any(String), 12, reserved.number);
    expect(ai.completeJson).toHaveBeenCalledTimes(1);
    expect(service.get(projectId, future.id).status).toBe('MEMORY_STALE');
    expect(service.get(projectId, reserved.id)).toEqual(reserved);
  });

  it('repairs a saved complete draft using its predecessors rather than its own ending or later episodes', async () => {
    const { service, ai } = fixture();
    const previous = await service.create(projectId, { ...plan, content: '문 앞에 섰다.' });
    seedMemory(previous, '문 앞');
    const current = await service.create(projectId, { ...plan, content: '문을 통과했다.' });
    seedMemory(current, '문 너머');
    const issue: ContinuityIssue = { category: 'SCENE', severity: 'WARNING', excerpt: '통과', explanation: '문이 닫혀 있다.', evidenceRefs: [], repairInstruction: '문을 먼저 연다.' };
    const events: StreamEvent[] = [];
    await service.repairDraft(projectId, { ...plan, content: current.content, issue, episodeId: current.id, expectedRevision: current.revision }, (event) => events.push(event));
    const request = ai.streamText.mock.calls[0]![0] as { variables: Record<string, string> };
    expect(JSON.parse(request.variables.current_scene!)).toMatchObject({ location: '문 앞' });
    expect(request.variables.recent_summaries).not.toContain('문 너머');
    expect(events.at(-1)).toMatchObject({ type: 'done', baseRevision: current.revision });
  });

  it('requires the reserved revision and an empty episode before spending generation work', async () => {
    const { service, memory, ai } = fixture();
    const reserved = await service.create(projectId, { ...plan, incomplete: true });
    for (const input of [
      { episodeId: reserved.id },
      { expectedRevision: reserved.revision },
      { episodeId: reserved.id, expectedRevision: reserved.revision + 1 },
    ]) {
      await expect(service.generate(projectId, { ...plan, ...input }, () => undefined)).rejects.toThrow();
    }
    const written = await service.update(projectId, reserved.id, { expectedRevision: reserved.revision, content: '작성된 원고.' });
    await expect(service.generate(projectId, { ...plan, episodeId: written.id, expectedRevision: written.revision }, () => undefined)).rejects.toBeInstanceOf(BadRequestException);
    expect(memory.search).not.toHaveBeenCalled();
    expect(ai.streamText).not.toHaveBeenCalled();
  });

  it.each(['writing', 'review'] as const)('rejects a concurrent episode change during %s without publishing a completed draft', async (stage) => {
    const { service, ai } = fixture();
    const reserved = await service.create(projectId, { ...plan, incomplete: true });
    const modify = () => service.update(projectId, reserved.id, { expectedRevision: reserved.revision, title: '다른 창의 제목' });
    if (stage === 'writing') {
      ai.streamText.mockImplementationOnce(async (_input, onDelta) => {
        onDelta('문을 열었다.');
        await modify();
        return completion('문을 열었다.');
      });
    } else {
      ai.completeJson.mockImplementationOnce(async () => {
        await modify();
        return { value: { ...plan, conflicts: [], issues: [] } };
      });
    }
    const events: StreamEvent[] = [];
    await expect(service.generate(projectId, { ...plan, episodeId: reserved.id, expectedRevision: reserved.revision }, (event) => events.push(event))).rejects.toBeInstanceOf(ConflictException);
    expect(events.some((event) => event.type === 'done')).toBe(false);
    expect(service.get(projectId, reserved.id)).toMatchObject({ title: '다른 창의 제목', content: '', status: 'INCOMPLETE' });
  });
});
