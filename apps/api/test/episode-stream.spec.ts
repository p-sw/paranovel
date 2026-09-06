import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContinuityIssue } from '../src/ai/ai.types';
import { DatabaseService } from '../src/database/database.service';
import { EpisodesService, type StreamEvent } from '../src/episodes/episodes.service';
import { ProjectsService } from '../src/projects/projects.service';

const blockingIssue: ContinuityIssue = {
  category: 'CANON', severity: 'BLOCKING', excerpt: '문', explanation: '닫힌 문을 통과했다.',
  evidenceRefs: [], repairInstruction: '문을 먼저 연다.',
};
const warningIssue: ContinuityIssue = {
  category: 'TIMELINE', severity: 'WARNING', excerpt: '정오', explanation: '같은 사건의 시각이 오전에서 정오로 바뀌었다.',
  evidenceRefs: ['episode:previous'], repairInstruction: '사건의 시각을 오전으로 맞춘다.',
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
        projectContext: '{}', writingDirection: '주인공 1인칭 현재 시점을 유지한다.',
        canon: '[]', currentArc: 'null', currentScene: 'null',
        recentSummaries: '[]', openForeshadowing: '[]', retrievedMemories: '[]', improvements: '[]',
      })),
    } as never, ai as never);
  }

  async function generateCandidate(service: EpisodesService, operation: 'generate' | 'continue', emit: (event: StreamEvent) => void, signal?: AbortSignal) {
    if (operation === 'generate') {
      return service.generate(projectId, { title: '문', direction: '문을 연다.' }, emit, signal);
    }
    const episode = await service.create(projectId, { title: '문', content: '저장된 원문.' });
    service.updateScene(projectId, episode.id, { expectedRevision: episode.revision, location: '문 앞' });
    return service.continue(projectId, episode.id, { expectedRevision: episode.revision, cursorOffset: 0 }, emit, signal);
  }

  describe.each(['generate', 'continue'] as const)('%s', (operation) => {
    it.each([
      { name: 'no issues', issues: [], blocked: false },
      { name: 'warnings', issues: [warningIssue], blocked: false },
      { name: 'blocking issues', issues: [blockingIssue], blocked: true },
      { name: 'mixed issues', issues: [blockingIssue, warningIssue], blocked: true },
    ])('returns the exact streamed draft and $name without invoking repair', async ({ issues, blocked }) => {
      const chunks = ['\n  원래 초안. ', '\n\n“문을 열까?” 🌙', '\n\t다음 문장.  \n'];
      const draft = chunks.join('');
      const ai = {
        streamText: vi.fn(async (_input: unknown, onDelta: (text: string) => void) => {
          chunks.forEach(onDelta);
          return completion(draft);
        }),
        completeJson: vi.fn(async () => ({ value: { issues } })),
      };
      const service = serviceWith(ai);
      const events: StreamEvent[] = [];
      await generateCandidate(service, operation, (event) => events.push(event));

      expect(ai.streamText).toHaveBeenCalledTimes(1);
      expect(ai.streamText.mock.calls[0]![0]).toMatchObject({
        variables: { writing_direction: '주인공 1인칭 현재 시점을 유지한다.' },
      });
      expect(ai.completeJson).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        task: 'continuity_review', includeCore: false,
        variables: expect.objectContaining({ draft_text: draft }),
      }));
      expect(events.filter((event) => event.type === 'delta')).toEqual(chunks.map((text) => ({ type: 'delta', text })));
      expect(events).not.toContainEqual({ type: 'stage', stage: 'REPAIRING' });
      expect(events).not.toContainEqual({ type: 'reset' });
      expect(events.at(-1)).toMatchObject({ type: 'done', content: draft, issues, blocked });
      if (operation === 'continue') {
        expect(events.at(-1)).toMatchObject({ baseRevision: 1 });
        expect(service.list(projectId)).toEqual([expect.objectContaining({ content: '저장된 원문.', revision: 1 })]);
      } else {
        expect(service.list(projectId)).toEqual([]);
      }
    });
  });

  it('keeps the original draft throughout review and reports blocking issues without a replacement', async () => {
    let finishReview!: (value: { value: { issues: ContinuityIssue[] } }) => void;
    const ai = {
      streamText: vi.fn(async (_input: unknown, onDelta: (text: string) => void) => {
        onDelta('원래 초안');
        return completion('원래 초안');
      }),
      completeJson: vi.fn(() => new Promise((resolve) => { finishReview = resolve; })),
    };
    const events: StreamEvent[] = [];
    const pending = serviceWith(ai).generate(projectId, { title: '문', direction: '문을 연다.' }, (event) => events.push(event));
    await vi.waitFor(() => expect(ai.completeJson).toHaveBeenCalledTimes(1));
    expect(events.filter((event) => event.type === 'delta' || event.type === 'reset')).toEqual([{ type: 'delta', text: '원래 초안' }]);

    expect(events.at(-1)).toEqual({ type: 'stage', stage: 'CHECKING' });
    expect(events.some((event) => event.type === 'done')).toBe(false);
    finishReview({ value: { issues: [blockingIssue] } });
    await pending;

    expect(ai.streamText).toHaveBeenCalledTimes(1);
    expect(events.at(-1)).toMatchObject({ type: 'done', content: '원래 초안', blocked: true, issues: [blockingIssue] });
    expect(events.filter((event) => event.type === 'delta' || event.type === 'reset')).toEqual([{ type: 'delta', text: '원래 초안' }]);
  });

  it.each(['review-error', 'cancelled-review'] as const)('preserves the original draft on %s', async (failure) => {
    const controller = new AbortController();
    const ai = {
      streamText: vi.fn(async (_input: unknown, onDelta: (text: string) => void) => {
        onDelta('원래 초안');
        return completion('원래 초안');
      }),
      completeJson: vi.fn(async () => {
        if (failure === 'review-error') throw new Error('review failed');
        controller.abort();
        return { value: { issues: [blockingIssue] } };
      }),
    };
    const events: StreamEvent[] = [];
    await expect(serviceWith(ai).generate(projectId, { title: '문', direction: '문을 연다.' }, (event) => events.push(event), controller.signal)).rejects.toThrow();
    expect(events.filter((event) => event.type === 'delta' || event.type === 'reset')).toEqual([{ type: 'delta', text: '원래 초안' }]);
    expect(events.some((event) => event.type === 'done')).toBe(false);
    expect(ai.streamText).toHaveBeenCalledTimes(1);
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
