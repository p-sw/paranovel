import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContinuityIssue } from '../src/ai/ai.types';
import { DatabaseService } from '../src/database/database.service';
import { EpisodesService, type StreamEvent } from '../src/episodes/episodes.service';
import { ProjectsService } from '../src/projects/projects.service';

const warning: ContinuityIssue = {
  category: 'SCENE', severity: 'WARNING', excerpt: '문을 통과했다.',
  explanation: '닫힌 문을 여는 동작이 빠졌다.', evidenceRefs: ['scene:door'],
  repairInstruction: '문을 여는 동작만 추가한다.',
};
const blocking: ContinuityIssue = {
  category: 'CANON', severity: 'BLOCKING', excerpt: '오른손',
  explanation: '다친 오른손을 썼다.', evidenceRefs: ['canon:injury'],
  repairInstruction: '왼손을 사용한다.',
};
const draftInput = {
  title: '문 앞에서', direction: '주인공이 문을 연다.',
  content: '\n  문을 통과했다.\n\n오른손을 들었다.\n', issue: warning,
};
const completion = (content: string) => ({
  runId: 'repair-run', result: { content, toolCalls: [], usage: {}, model: 'test' },
});

describe('selective episode continuity repair', () => {
  let database: DatabaseService;
  let projects: ProjectsService;
  let projectId: string;

  beforeEach(() => {
    vi.stubEnv('DB_PATH', ':memory:');
    vi.stubEnv('OPENROUTER_EMBEDDING_DIMENSIONS', '4');
    database = new DatabaseService();
    projects = new ProjectsService(database);
    projectId = projects.createInternal({ title: '검토', logline: '문을 여는 이야기', genreTags: ['판타지'] }).id;
  });

  afterEach(() => {
    database.onApplicationShutdown();
    vi.unstubAllEnvs();
  });

  function fixture() {
    const memory = {
      assemble: vi.fn(async () => ({
        projectContext: '{"title":"검토"}', canon: '["오른손 부상"]', currentArc: 'null',
        currentScene: '{"location":"문 앞"}', recentSummaries: '["닫힌 문에 도착했다."]',
        openForeshadowing: '[]', retrievedMemories: '[]', improvements: '[]',
      })),
    };
    const ai = {
      streamText: vi.fn(async (_input: unknown, onDelta: (text: string) => void, onRun?: (id: string) => void) => {
        onRun?.('repair-run');
        onDelta('검토 전 수정 중인 원고');
        return completion('\n  문을 열고 통과했다.\n\n오른손을 들었다.\n');
      }),
      completeJson: vi.fn(async (_input: unknown) => ({ value: { issues: [] as ContinuityIssue[] } })),
    };
    const service = new EpisodesService(database, projects, memory as never, ai as never);
    const events: StreamEvent[] = [];
    const emit = (event: StreamEvent) => events.push(event);
    return { service, memory, ai, events, emit };
  }

  it('repairs just the selected warning, reviews the entire corrected candidate, and keeps other issues actionable', async () => {
    const { service, memory, ai, events, emit } = fixture();
    const controller = new AbortController();
    ai.completeJson.mockResolvedValue({ value: { issues: [blocking] } });

    await service.repairDraft(projectId, { ...draftInput, issues: [warning, blocking] }, emit, controller.signal);

    expect(ai.streamText).toHaveBeenCalledTimes(1);
    expect(ai.streamText).toHaveBeenCalledWith(expect.objectContaining({
      task: 'continuity_repair', signal: controller.signal,
      variables: expect.objectContaining({
        candidate_text: draftInput.content, draft_text: draftInput.content,
        review_issues: JSON.stringify([warning]), issues: JSON.stringify([warning]),
        continuity_issues: JSON.stringify([warning]), canon: '["오른손 부상"]',
        boundary_context: '새 회차 전체 초안',
      }),
    }), expect.any(Function), expect.any(Function));
    expect(ai.completeJson).toHaveBeenCalledTimes(1);
    expect(ai.completeJson).toHaveBeenCalledWith(expect.objectContaining({
      task: 'continuity_review', signal: controller.signal,
      variables: expect.objectContaining({ candidate_text: '\n  문을 열고 통과했다.\n\n오른손을 들었다.\n' }),
    }));
    expect(memory.assemble).toHaveBeenCalledWith(projectId, `${draftInput.title}\n${draftInput.direction}`);
    expect(events.filter((event) => event.type === 'stage')).toEqual([
      { type: 'stage', stage: 'MEMORY' }, { type: 'stage', stage: 'REPAIRING' }, { type: 'stage', stage: 'CHECKING' },
    ]);
    expect(events.at(-1)).toMatchObject({
      type: 'done', content: '\n  문을 열고 통과했다.\n\n오른손을 들었다.\n', blocked: true, issues: [blocking],
    });
    expect(events.some((event) => event.type === 'delta' || event.type === 'reset')).toBe(false);
    expect(service.list(projectId)).toEqual([]);
  });

  it('publishes no replacement until both repair and review have completed', async () => {
    const { service, ai, events, emit } = fixture();
    let finishRepair!: (value: ReturnType<typeof completion>) => void;
    let finishReview!: (value: { value: { issues: ContinuityIssue[] } }) => void;
    ai.streamText.mockImplementation(() => new Promise((resolve) => { finishRepair = resolve; }));
    ai.completeJson.mockImplementation(() => new Promise((resolve) => { finishReview = resolve; }));
    const pending = service.repairDraft(projectId, draftInput, emit);
    await vi.waitFor(() => expect(ai.streamText).toHaveBeenCalledTimes(1));
    expect(events.at(-1)).toEqual({ type: 'stage', stage: 'REPAIRING' });
    finishRepair(completion('문을 열었다.'));
    await vi.waitFor(() => expect(ai.completeJson).toHaveBeenCalledTimes(1));
    expect(events.at(-1)).toEqual({ type: 'stage', stage: 'CHECKING' });
    expect(events.some((event) => ['delta', 'reset', 'done'].includes(event.type))).toBe(false);
    finishReview({ value: { issues: [] } });
    await pending;
    expect(events.at(-1)).toMatchObject({ type: 'done', content: '문을 열었다.', blocked: false, issues: [] });
  });

  it.each(['repair-error', 'empty-repair', 'cancelled-repair', 'review-error', 'cancelled-review'] as const)(
    'retains the prior preview and issues on %s', async (failure) => {
      const { service, ai, events, emit } = fixture();
      const controller = new AbortController();
      ai.streamText.mockImplementation(async (_input, onDelta) => {
        onDelta('실패할 수정 중인 원고');
        if (failure === 'repair-error') throw new Error('repair failed');
        if (failure === 'cancelled-repair') controller.abort();
        return completion(failure === 'empty-repair' ? '\n  ' : '수정한 초안');
      });
      ai.completeJson.mockImplementation(async () => {
        if (failure === 'review-error') throw new Error('review failed');
        if (failure === 'cancelled-review') controller.abort();
        return { value: { issues: [] } };
      });
      await expect(service.repairDraft(projectId, draftInput, emit, controller.signal)).rejects.toThrow();
      expect(events.some((event) => ['delta', 'reset', 'done'].includes(event.type))).toBe(false);
      expect(service.list(projectId)).toEqual([]);
    },
  );

  it.each([
    { content: undefined }, { content: '' }, { content: ' \n' }, { content: 42 },
    { issue: undefined }, { issue: null }, { issue: [] }, { issue: {} },
    { issue: { ...warning, severity: 'INFO' } }, { issue: { ...warning, category: 'UNKNOWN' } },
    { issue: { ...warning, evidenceRefs: 'scene:door' } },
    { issue: { ...warning, explanation: ' ', repairInstruction: '\n' } },
  ])('rejects unusable repair input before loading memory or invoking AI: %j', async (invalid) => {
    const { service, memory, ai, emit } = fixture();
    await expect(service.repairDraft(projectId, { ...draftInput, ...invalid }, emit)).rejects.toThrow();
    expect(memory.assemble).not.toHaveBeenCalled();
    expect(ai.streamText).not.toHaveBeenCalled();
    expect(ai.completeJson).not.toHaveBeenCalled();
  });

  it('can fix an explained warning even when the reviewer supplied no repair instruction', async () => {
    const { service, ai, emit } = fixture();
    await service.repairDraft(projectId, { ...draftInput, issue: { ...warning, repairInstruction: '' } }, emit);
    expect(ai.streamText).toHaveBeenCalledTimes(1);
  });

  it('respects cancellation before memory or AI work starts', async () => {
    const { service, memory, ai, events, emit } = fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(service.repairDraft(projectId, draftInput, emit, controller.signal)).rejects.toThrow();
    expect(memory.assemble).not.toHaveBeenCalled();
    expect(ai.streamText).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it('repairs only the continuation candidate using the stored title, direction and both cursor boundaries', async () => {
    const { service, memory, ai, events, emit } = fixture();
    const episode = await service.create(projectId, { title: '원래 제목', direction: '원래 방향', content: '그는 문 앞에 섰다.\n\n뒤쪽에서 발소리가 들렸다.' });
    const cursorOffset = episode.content.indexOf('뒤쪽');
    service.updateScene(projectId, episode.id, { expectedRevision: episode.revision, location: '문 앞' });
    await service.repairContinuation(projectId, episode.id, {
      expectedRevision: episode.revision, cursorOffset, content: draftInput.content, issue: warning,
      title: '클라이언트가 바꾼 제목', text_before_cursor: '잘못된 경계',
    }, emit);
    const boundary = JSON.stringify({
      textBeforeCursor: episode.content.slice(0, cursorOffset),
      textAfterCursor: episode.content.slice(cursorOffset), insertionPoint: cursorOffset,
    });
    expect(memory.assemble).toHaveBeenCalledWith(projectId, '원래 방향\n그는 문 앞에 섰다.', episode.id);
    expect(ai.streamText).toHaveBeenCalledWith(expect.objectContaining({
      episodeId: episode.id, variables: expect.objectContaining({
        episode_title: episode.title, episode_direction: episode.direction, draft_text: draftInput.content,
        text_before_cursor: episode.content.slice(0, cursorOffset),
        text_after_cursor: episode.content.slice(cursorOffset), boundary_context: boundary,
      }),
    }), expect.any(Function), expect.any(Function));
    expect(ai.completeJson).toHaveBeenCalledWith(expect.objectContaining({
      variables: expect.objectContaining({ boundary_context: boundary }),
    }));
    expect(events.at(-1)).toMatchObject({ type: 'done', baseRevision: episode.revision });
    expect(service.get(projectId, episode.id)).toEqual(episode);
  });

  it('refreshes only earlier stale episodes when repairing a continuation', async () => {
    const { service, emit } = fixture();
    const predecessor = await service.create(projectId, { title: '이전 회차', content: '이전 원고' });
    const episode = await service.create(projectId, { title: '현재 회차', content: '현재 원고' });
    await service.create(projectId, { title: '다음 회차', content: '다음 원고' });
    database.connection.prepare("UPDATE episodes SET status = 'MEMORY_STALE'").run();
    service.updateScene(projectId, episode.id, { expectedRevision: episode.revision, location: '문 앞' });
    const finalize = vi.spyOn(service, 'finalize').mockImplementation(async (id, episodeId) => service.get(id, episodeId));
    await service.repairContinuation(projectId, episode.id, {
      expectedRevision: episode.revision, cursorOffset: 0, content: draftInput.content, issue: warning,
    }, emit);
    expect(finalize).toHaveBeenCalledTimes(1);
    expect(finalize).toHaveBeenCalledWith(projectId, predecessor.id, { expectedRevision: predecessor.revision });
  });

  it.each(['stale-revision', 'outside-cursor'] as const)('rejects continuation %s before AI work', async (invalid) => {
    const { service, memory, ai, emit } = fixture();
    const episode = await service.create(projectId, { title: '문', content: '저장된 원고' });
    await expect(service.repairContinuation(projectId, episode.id, {
      expectedRevision: invalid === 'stale-revision' ? episode.revision + 1 : episode.revision,
      cursorOffset: invalid === 'outside-cursor' ? episode.content.length + 1 : 0,
      content: draftInput.content, issue: warning,
    }, emit)).rejects.toThrow(invalid === 'stale-revision' ? 'revision is stale' : 'outside the episode');
    expect(memory.assemble).not.toHaveBeenCalled();
    expect(ai.streamText).not.toHaveBeenCalled();
    expect(ai.completeJson).not.toHaveBeenCalled();
  });

  it('discards a repaired continuation if the stored revision changes during review', async () => {
    const { service, ai, events, emit } = fixture();
    const episode = await service.create(projectId, { title: '문', content: '저장된 원고' });
    service.updateScene(projectId, episode.id, { expectedRevision: episode.revision });
    ai.completeJson.mockImplementation(async () => {
      database.connection.prepare('UPDATE episodes SET revision = revision + 1 WHERE id = ?').run(episode.id);
      return { value: { issues: [] } };
    });
    await expect(service.repairContinuation(projectId, episode.id, {
      expectedRevision: episode.revision, cursorOffset: 0, content: draftInput.content, issue: warning,
    }, emit)).rejects.toThrow('Episode revision changed during repair');
    expect(events.some((event) => ['delta', 'reset', 'done'].includes(event.type))).toBe(false);
    expect(service.get(projectId, episode.id).content).toBe(episode.content);
  });
});
