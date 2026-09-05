import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseService } from '../src/database/database.service';
import { EpisodesService, type StreamEvent } from '../src/episodes/episodes.service';
import { ProjectsService } from '../src/projects/projects.service';

const blockingIssue = {
  category: 'CANON', severity: 'BLOCKING', excerpt: '문', explanation: '닫힌 문을 통과했다.',
  evidenceRefs: [], repairInstruction: '문을 먼저 연다.',
};
const completion = (content: string) => ({
  runId: 'test-run', result: { content, toolCalls: [], usage: {}, model: 'test' },
});

describe('episode draft review stream', () => {
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

  function serviceWith(ai: unknown) {
    return new EpisodesService(database, projects, {
      assemble: vi.fn(async () => ({
        projectContext: '{}', canon: '[]', currentArc: 'null', currentScene: 'null',
        recentSummaries: '[]', openForeshadowing: '[]', retrievedMemories: '[]', improvements: '[]',
      })),
    } as never, ai as never);
  }

  it('keeps the original draft during repair and its review, committing the replacement only at done', async () => {
    let finishRepair!: (result: ReturnType<typeof completion>) => void;
    let finishReview!: (value: { value: { issues: unknown[] } }) => void;
    const repairPending = new Promise<ReturnType<typeof completion>>((resolve) => { finishRepair = resolve; });
    const reviewPending = new Promise<{ value: { issues: unknown[] } }>((resolve) => { finishReview = resolve; });
    const ai = {
      streamText: vi.fn(async (input: { task: string }, onDelta: (text: string) => void) => {
        if (input.task === 'continuity_repair') {
          onDelta('수정 중인 미완성 문장');
          return repairPending;
        }
        onDelta('원래 초안');
        return completion('원래 초안');
      }),
      completeJson: vi.fn()
        .mockResolvedValueOnce({ value: { issues: [blockingIssue] } })
        .mockImplementationOnce(() => reviewPending),
    };
    const events: StreamEvent[] = [];
    const pending = serviceWith(ai).generate(projectId, { title: '문', direction: '문을 연다.' }, (event) => events.push(event));
    await vi.waitFor(() => expect(ai.streamText).toHaveBeenCalledTimes(2));
    expect(events.filter((event) => event.type === 'delta' || event.type === 'reset')).toEqual([{ type: 'delta', text: '원래 초안' }]);

    finishRepair(completion('수정이 끝난 초안'));
    await vi.waitFor(() => expect(ai.completeJson).toHaveBeenCalledTimes(2));
    expect(events.at(-1)).toEqual({ type: 'stage', stage: 'CHECKING' });
    expect(events.some((event) => event.type === 'done')).toBe(false);
    finishReview({ value: { issues: [] } });
    await pending;

    expect(events.at(-1)).toMatchObject({ type: 'done', content: '수정이 끝난 초안', blocked: false, issues: [] });
    expect(events.filter((event) => event.type === 'delta' || event.type === 'reset')).toEqual([{ type: 'delta', text: '원래 초안' }]);
  });

  it.each(['repair-error', 'empty-repair', 'cancelled-repair', 'review-error'] as const)('preserves the original draft on %s', async (failure) => {
    const controller = new AbortController();
    const ai = {
      streamText: vi.fn(async (input: { task: string }, onDelta: (text: string) => void) => {
        if (input.task === 'continuity_repair') {
          onDelta('수정 중');
          if (failure === 'repair-error') throw new Error('repair failed');
          if (failure === 'cancelled-repair') controller.abort();
          return completion(failure === 'empty-repair' ? ' ' : '수정된 초안');
        }
        onDelta('원래 초안');
        return completion('원래 초안');
      }),
      completeJson: vi.fn()
        .mockResolvedValueOnce({ value: { issues: [blockingIssue] } })
        .mockRejectedValueOnce(new Error('review failed')),
    };
    const events: StreamEvent[] = [];
    await expect(serviceWith(ai).generate(projectId, { title: '문', direction: '문을 연다.' }, (event) => events.push(event), controller.signal)).rejects.toThrow();
    expect(events.filter((event) => event.type === 'delta' || event.type === 'reset')).toEqual([{ type: 'delta', text: '원래 초안' }]);
    expect(events.some((event) => event.type === 'done')).toBe(false);
  });

  it('rejects an empty initial draft before continuity review', async () => {
    const ai = {
      streamText: vi.fn(async () => completion('')),
      completeJson: vi.fn(),
    };
    const events: StreamEvent[] = [];
    await expect(serviceWith(ai).generate(projectId, { title: '문', direction: '문을 연다.' }, (event) => events.push(event))).rejects.toThrow('empty episode draft');
    expect(ai.completeJson).not.toHaveBeenCalled();
    expect(events.some((event) => event.type === 'done')).toBe(false);
  });
});
