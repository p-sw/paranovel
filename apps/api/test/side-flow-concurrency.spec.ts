import { ConflictException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseService } from '../src/database/database.service';
import { canonEntries, episodes, improvements } from '../src/database/schema';
import { EpisodesService, type StreamEvent } from '../src/episodes/episodes.service';
import { MemoryService } from '../src/memory/memory.service';
import { ProjectsService } from '../src/projects/projects.service';
import { SideStoriesService } from '../src/side-stories/side-stories.service';

const proposal = {
  title: '얼어붙은 문',
  direction: '문 너머의 기억을 확인한다.',
  conflicts: [],
};

const draftCompletion = (content = '문을 열었다.') => ({
  runId: 'side-draft-run',
  result: { content, toolCalls: [], usage: {}, model: 'test' },
});

const extractedScene = {
  location: 'AI가 읽은 옛 장면',
  time: null,
  pointOfView: null,
  characters: [],
  goal: null,
};

const memoryExtraction = {
  events: ['문을 통과했다.'],
  emotionalChanges: [],
  newForeshadowing: [],
  resolvedForeshadowing: [],
  endScene: extractedScene,
  canonCandidates: [],
};

const refreshedExtraction = (episodeId: string) => ({
  events: [`refreshed-summary:${episodeId}`],
  emotionalChanges: [],
  newForeshadowing: [],
  resolvedForeshadowing: [],
  endScene: {
    location: `refreshed-scene:${episodeId}`,
    time: null,
    pointOfView: null,
    characters: [],
    goal: null,
  },
  canonCandidates: [],
});

describe('side-story flow invalidation and concurrency', () => {
  let database: DatabaseService;
  let projects: ProjectsService;
  let memory: MemoryService;
  let episodesService: EpisodesService;
  let sideStories: SideStoriesService;
  let projectId: string;
  let ai: {
    completeJson: ReturnType<typeof vi.fn>;
    streamText: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.stubEnv('DB_PATH', ':memory:');
    vi.stubEnv('OPENROUTER_EMBEDDING_DIMENSIONS', '4');
    database = new DatabaseService();
    projects = new ProjectsService(database);
    memory = new MemoryService(database, {
      embeddings: vi.fn(async (texts: string[]) => texts.map(() => [1, 0.5, 0.25, 0.125])),
    } as never);
    vi.spyOn(memory, 'search').mockResolvedValue([]);
    ai = {
      completeJson: vi.fn(async () => ({ value: { ...proposal, issues: [] } })),
      streamText: vi.fn(async () => draftCompletion()),
    };
    episodesService = new EpisodesService(database, projects, memory, ai as never);
    sideStories = new SideStoriesService(database, memory);
    projectId = projects.createInternal({
      title: '흐름 기록관',
      logline: '서로 다른 시간선을 기록한다.',
      genreTags: ['판타지'],
    }).id;
  });

  afterEach(() => {
    database.onApplicationShutdown();
    vi.unstubAllEnvs();
  });

  async function createMain(title: string) {
    return episodesService.create(projectId, {
      title,
      direction: `${title}의 전개`,
      content: `${title}의 원고`,
    });
  }

  function createGroup(branchFromEpisodeId: string | null, title: string) {
    return sideStories.createGroup(projectId, {
      title,
      description: `${title}의 설명`,
      branchFromEpisodeId,
      canon: `${title}에서만 유효한 정사`,
      arc: {
        title: `${title}의 아크`,
        goal: '분기된 사건을 해결한다.',
        conflict: '다른 시간선의 방해를 받는다.',
        endEpisodeNumber: 4,
        reversalPlan: [],
      },
    });
  }

  function createSide(
    title: string,
    options: { groupId?: string; branchFromEpisodeId?: string; content?: string } = {},
  ) {
    return sideStories.create(projectId, {
      title,
      direction: `${title}의 전개`,
      content: options.content ?? `${title}의 원고`,
      groupId: options.groupId ?? null,
      branchFromEpisodeId: options.branchFromEpisodeId ?? null,
    });
  }

  function confirm(...episodeIds: string[]) {
    for (const episodeId of episodeIds) {
      database.orm.update(episodes).set({ status: 'CONFIRMED' })
        .where(eq(episodes.id, episodeId)).run();
    }
  }

  function status(episodeId: string) {
    return episodesService.get(projectId, episodeId).status;
  }

  function recordRefreshes() {
    const order: string[] = [];
    ai.completeJson.mockImplementation(async (input: { task: string; episodeId?: string }) => {
      if (input.task === 'episode_memory_extract') {
        const episodeId = input.episodeId!;
        order.push(episodeId);
        return { value: refreshedExtraction(episodeId) };
      }
      return { value: { ...proposal, issues: [] } };
    });
    return order;
  }

  function directionVariables() {
    const call = ai.completeJson.mock.calls.find(
      ([input]) => (input as { task: string }).task === 'episode_direction',
    );
    expect(call).toBeDefined();
    return (call![0] as { variables: Record<string, string> }).variables;
  }

  function seedMemory(episode: { id: string; revision: number }, label: string) {
    confirm(episode.id);
    database.connection.prepare(`INSERT INTO episode_summaries
      (episode_id, synopsis, events_json, emotional_changes_json,
       foreshadowing_introduced_json, foreshadowing_resolved_json,
       source_revision, source_hash, updated_at)
      VALUES (?, ?, '[]', '[]', '[]', '[]', ?, 'seed-hash', '2026-09-01')`)
      .run(episode.id, `old-summary:${label}`, episode.revision);
    database.connection.prepare(`INSERT INTO scene_states
      (episode_id, location, story_time, point_of_view, character_names_json,
       goal, source_revision, updated_at)
      VALUES (?, ?, '', '', '[]', '', ?, '2026-09-01')`)
      .run(episode.id, `old-scene:${label}`, episode.revision);
  }

  it('invalidates side flows anchored at or after a main edit while preserving canon-only and earlier branches', async () => {
    const mainOne = await createMain('본편 1');
    const mainTwo = await createMain('본편 2');
    const mainThree = await createMain('본편 3');
    const earlierBranch = await createSide('이전 분기', { branchFromEpisodeId: mainOne.id });
    const exactBranch = await createSide('동일 분기', { branchFromEpisodeId: mainTwo.id });
    const canonOnly = await createSide('독립 외전');
    const laterGroup = createGroup(mainThree.id, '나중 분기 그룹');
    const laterGrouped = await createSide('그룹 외전', { groupId: laterGroup.id });
    confirm(earlierBranch.id, exactBranch.id, canonOnly.id, laterGrouped.id);
    const removeSource = vi.spyOn(memory, 'removeSource');

    await episodesService.update(projectId, mainTwo.id, {
      expectedRevision: mainTwo.revision,
      title: '수정된 본편 2',
    });

    expect(status(exactBranch.id)).toBe('MEMORY_STALE');
    expect(status(laterGrouped.id)).toBe('MEMORY_STALE');
    expect(status(earlierBranch.id)).toBe('CONFIRMED');
    expect(status(canonOnly.id)).toBe('CONFIRMED');
    expect(removeSource).toHaveBeenCalledWith('EPISODE', exactBranch.id);
    expect(removeSource).toHaveBeenCalledWith('EPISODE_SUMMARY', laterGrouped.id);
    expect(removeSource).not.toHaveBeenCalledWith('EPISODE', earlierBranch.id);
    expect(removeSource).not.toHaveBeenCalledWith('EPISODE', canonOnly.id);
  });

  it('invalidates only later episodes in the edited side-story group', async () => {
    const anchor = await createMain('분기점');
    const groupA = createGroup(anchor.id, 'A 그룹');
    const groupB = createGroup(anchor.id, 'B 그룹');
    const aOne = await createSide('A-1', { groupId: groupA.id });
    const aTwo = await createSide('A-2', { groupId: groupA.id });
    const aThree = await createSide('A-3', { groupId: groupA.id });
    const bOne = await createSide('B-1', { groupId: groupB.id });
    const bTwo = await createSide('B-2', { groupId: groupB.id });
    const standalone = await createSide('독립 외전', { branchFromEpisodeId: anchor.id });
    confirm(aOne.id, aTwo.id, aThree.id, bOne.id, bTwo.id, standalone.id);
    const removeSource = vi.spyOn(memory, 'removeSource');

    const edited = await episodesService.update(projectId, aTwo.id, {
      expectedRevision: aTwo.revision,
      title: '수정된 A-2',
    });

    expect(edited).toMatchObject({ revision: aTwo.revision + 1, status: 'MEMORY_STALE' });
    expect(status(aOne.id)).toBe('CONFIRMED');
    expect(status(aThree.id)).toBe('MEMORY_STALE');
    expect(status(bOne.id)).toBe('CONFIRMED');
    expect(status(bTwo.id)).toBe('CONFIRMED');
    expect(status(standalone.id)).toBe('CONFIRMED');
    expect(removeSource).toHaveBeenCalledWith('EPISODE', aTwo.id);
    expect(removeSource).toHaveBeenCalledWith('EPISODE', aThree.id);
    expect(removeSource).not.toHaveBeenCalledWith('EPISODE', aOne.id);
    expect(removeSource).not.toHaveBeenCalledWith('EPISODE', bTwo.id);
    expect(removeSource).not.toHaveBeenCalledWith('EPISODE', standalone.id);
  });

  it('cleans memory and invalidates later grouped episodes for a status-only review transition', async () => {
    const anchor = await createMain('분기점');
    const group = createGroup(anchor.id, '검토 전환 그룹');
    const first = await createSide('외전 1', { groupId: group.id });
    const second = await createSide('외전 2', { groupId: group.id });
    confirm(first.id, second.id);
    const removeSource = vi.spyOn(memory, 'removeSource');

    const review = await episodesService.update(projectId, first.id, {
      expectedRevision: first.revision,
      incomplete: false,
      forceNeedsReview: true,
    });

    expect(review.status).toBe('NEEDS_REVIEW');
    expect(status(second.id)).toBe('MEMORY_STALE');
    expect(removeSource).toHaveBeenCalledWith('EPISODE', first.id);
    expect(removeSource).toHaveBeenCalledWith('EPISODE_SUMMARY', first.id);
    expect(removeSource).toHaveBeenCalledWith('EPISODE', second.id);
    expect(removeSource).toHaveBeenCalledWith('EPISODE_SUMMARY', second.id);
  });

  it('detaches direct side branches and advances their concurrency tokens when a main anchor is deleted', async () => {
    const anchor = await createMain('삭제될 분기점');
    await createMain('다음 본편');
    const standalone = await createSide('직접 단편', { branchFromEpisodeId: anchor.id });
    const group = createGroup(anchor.id, '직접 그룹');
    const grouped = await createSide('직접 그룹 외전', { groupId: group.id });
    confirm(standalone.id, grouped.id);
    const removeSource = vi.spyOn(memory, 'removeSource');

    episodesService.remove(projectId, anchor.id, { expectedRevision: anchor.revision });

    expect(() => episodesService.get(projectId, anchor.id)).toThrow('Episode not found');
    expect(episodesService.get(projectId, standalone.id)).toMatchObject({
      branchFromEpisodeId: null,
      revision: standalone.revision + 1,
      status: 'MEMORY_STALE',
    });
    expect(sideStories.getGroup(projectId, group.id)).toMatchObject({
      branchFromEpisodeId: null,
      revision: group.revision + 1,
    });
    expect(episodesService.get(projectId, grouped.id)).toMatchObject({
      revision: grouped.revision,
      status: 'MEMORY_STALE',
    });
    expect(removeSource).toHaveBeenCalledWith('EPISODE', standalone.id);
    expect(removeSource).toHaveBeenCalledWith('EPISODE_SUMMARY', grouped.id);
  });

  it('preserves unconfirmed standalone states when their main anchor is deleted', async () => {
    const anchor = await createMain('삭제될 분기점');
    const states = ['CONFIRMED', 'DRAFT', 'NEEDS_REVIEW', 'INCOMPLETE'] as const;
    const sideStoriesByState = await Promise.all(states.map(async (state) => {
      const sideStory = await createSide(`${state} 단편`, {
        branchFromEpisodeId: anchor.id,
        content: state === 'INCOMPLETE' ? '' : `${state} 원고`,
      });
      database.orm.update(episodes).set({ status: state }).where(eq(episodes.id, sideStory.id)).run();
      return { state, sideStory };
    }));

    episodesService.remove(projectId, anchor.id, { expectedRevision: anchor.revision });

    for (const { state, sideStory } of sideStoriesByState) {
      expect(episodesService.get(projectId, sideStory.id)).toMatchObject({
        branchFromEpisodeId: null,
        revision: sideStory.revision + 1,
        status: state === 'CONFIRMED' ? 'MEMORY_STALE' : state,
      });
    }
  });

  it('rolls back an anchor edit when dependent memory invalidation fails', async () => {
    const anchor = await createMain('원래 분기점');
    const sideStory = await createSide('확정된 외전', { branchFromEpisodeId: anchor.id });
    confirm(anchor.id, sideStory.id);
    const beforeAnchor = episodesService.get(projectId, anchor.id);
    vi.spyOn(memory, 'removeSource').mockImplementation((_, sourceId) => {
      if (sourceId === sideStory.id) throw new Error('forced memory cleanup failure');
    });

    await expect(episodesService.update(projectId, anchor.id, {
      expectedRevision: anchor.revision,
      title: '저장되면 안 되는 분기점',
    })).rejects.toThrow('forced memory cleanup failure');

    expect(episodesService.get(projectId, anchor.id)).toEqual(beforeAnchor);
    expect(status(sideStory.id)).toBe('CONFIRMED');
  });

  it('rolls back scene and finalize writes when dependent invalidation fails', async () => {
    const anchor = await createMain('분기점');
    episodesService.updateScene(projectId, anchor.id, {
      expectedRevision: anchor.revision,
      location: '원래 본편 장면',
    });
    const sideStory = await createSide('확정된 외전', { branchFromEpisodeId: anchor.id });
    confirm(sideStory.id);
    vi.spyOn(memory, 'removeSource').mockImplementation((_, sourceId) => {
      if (sourceId === sideStory.id) throw new Error('forced memory cleanup failure');
    });

    expect(() => episodesService.updateScene(projectId, anchor.id, {
      expectedRevision: anchor.revision,
      location: '저장되면 안 되는 장면',
    })).toThrow('forced memory cleanup failure');
    expect(episodesService.getScene(projectId, anchor.id).location).toBe('원래 본편 장면');
    expect(status(sideStory.id)).toBe('CONFIRMED');

    ai.completeJson.mockResolvedValueOnce({ value: memoryExtraction });
    await expect(episodesService.finalize(projectId, anchor.id, {
      expectedRevision: anchor.revision,
    })).rejects.toThrow('forced memory cleanup failure');
    expect(episodesService.get(projectId, anchor.id)).toMatchObject({
      status: 'DRAFT',
      summary: null,
    });
    expect(episodesService.getScene(projectId, anchor.id).location).toBe('원래 본편 장면');
    expect(status(sideStory.id)).toBe('CONFIRMED');
  });

  it('rejects a pending grouped continuation when its target scene changes without an episode revision', async () => {
    const anchor = await createMain('분기점');
    const group = createGroup(anchor.id, '장면 동시성 그룹');
    const target = await createSide('이어 쓸 외전', { groupId: group.id });
    episodesService.updateScene(projectId, target.id, {
      expectedRevision: target.revision,
      location: '기존 장면',
    });
    let finishDraft!: (value: ReturnType<typeof draftCompletion>) => void;
    ai.streamText.mockImplementationOnce(() => new Promise((resolve) => {
      finishDraft = resolve;
    }));
    const events: StreamEvent[] = [];

    const pending = episodesService.continue(projectId, target.id, {
      expectedRevision: target.revision,
      cursorOffset: target.content.length,
    }, (event) => events.push(event));
    await vi.waitFor(() => expect(ai.streamText).toHaveBeenCalledTimes(1));
    episodesService.updateScene(projectId, target.id, {
      expectedRevision: target.revision,
      location: '사용자가 고친 장면',
    });
    expect(episodesService.get(projectId, target.id).revision).toBe(target.revision);

    const rejected = expect(pending).rejects.toBeInstanceOf(ConflictException);
    finishDraft(draftCompletion());
    await rejected;
    expect(episodesService.getScene(projectId, target.id).location).toBe('사용자가 고친 장면');
    expect(events.some((event) => event.type === 'done')).toBe(false);
  });

  it('does not let pending scene extraction overwrite a newer grouped target scene', async () => {
    const anchor = await createMain('분기점');
    const group = createGroup(anchor.id, '장면 추출 그룹');
    const target = await createSide('장면을 읽을 외전', { groupId: group.id });
    let finishScene!: (value: { value: typeof extractedScene }) => void;
    ai.completeJson.mockImplementationOnce(() => new Promise((resolve) => {
      finishScene = resolve;
    }));

    const pending = episodesService.continue(projectId, target.id, {
      expectedRevision: target.revision,
      cursorOffset: target.content.length,
    }, () => undefined);
    await vi.waitFor(() => expect(ai.completeJson).toHaveBeenCalledTimes(1));
    episodesService.updateScene(projectId, target.id, {
      expectedRevision: target.revision,
      location: '사용자가 먼저 저장한 장면',
    });
    expect(episodesService.get(projectId, target.id).revision).toBe(target.revision);

    const rejected = expect(pending).rejects.toBeInstanceOf(ConflictException);
    finishScene({ value: extractedScene });
    await rejected;
    expect(episodesService.getScene(projectId, target.id).location).toBe('사용자가 먼저 저장한 장면');
    expect(ai.streamText).not.toHaveBeenCalled();
  });

  it('does not let pending grouped finalization overwrite a newer target scene', async () => {
    const anchor = await createMain('분기점');
    const group = createGroup(anchor.id, '확정 동시성 그룹');
    const target = await createSide('확정할 외전', { groupId: group.id });
    episodesService.updateScene(projectId, target.id, {
      expectedRevision: target.revision,
      location: '확정 전 장면',
    });
    let finishExtraction!: (value: { value: typeof memoryExtraction }) => void;
    ai.completeJson.mockImplementationOnce(() => new Promise((resolve) => {
      finishExtraction = resolve;
    }));

    const pending = episodesService.finalize(projectId, target.id, {
      expectedRevision: target.revision,
    });
    await vi.waitFor(() => expect(ai.completeJson).toHaveBeenCalledTimes(1));
    episodesService.updateScene(projectId, target.id, {
      expectedRevision: target.revision,
      location: '사용자가 확정 중 고친 장면',
    });
    expect(episodesService.get(projectId, target.id).revision).toBe(target.revision);

    const rejected = expect(pending).rejects.toBeInstanceOf(ConflictException);
    finishExtraction({ value: memoryExtraction });
    await rejected;
    expect(episodesService.getScene(projectId, target.id).location).toBe('사용자가 확정 중 고친 장면');
    expect(episodesService.get(projectId, target.id)).toMatchObject({
      revision: target.revision,
      status: 'DRAFT',
      summary: null,
    });
  });

  it('refreshes stale main episodes in ascending order through a standalone branch anchor', async () => {
    const mainOne = await createMain('본편 1');
    const mainTwo = await createMain('본편 2');
    const mainThree = await createMain('본편 3');
    const target = await createSide('독립 외전', {
      branchFromEpisodeId: mainThree.id,
      content: '',
    });
    seedMemory(mainOne, 'main-1');
    seedMemory(mainTwo, 'main-2');
    seedMemory(mainThree, 'main-3');
    await episodesService.update(projectId, mainOne.id, {
      expectedRevision: mainOne.revision,
      title: '수정된 본편 1',
    });
    const refreshOrder = recordRefreshes();

    await episodesService.propose(projectId, {
      hint: '분기점 다음 전개',
      episodeId: target.id,
      expectedRevision: target.revision,
    });

    expect(refreshOrder).toEqual([mainOne.id, mainTwo.id, mainThree.id]);
    expect(status(mainOne.id)).toBe('CONFIRMED');
    expect(status(mainTwo.id)).toBe('CONFIRMED');
    expect(status(mainThree.id)).toBe('CONFIRMED');
    const variables = directionVariables();
    expect(variables.recent_summaries).toContain(`refreshed-summary:${mainThree.id}`);
    expect(JSON.parse(variables.current_scene!)).toMatchObject({
      location: `refreshed-scene:${mainThree.id}`,
    });
  });

  it('refreshes the stale main prefix before grouped predecessors and assembles their new memory', async () => {
    const mainOne = await createMain('본편 1');
    const mainTwo = await createMain('본편 2');
    const mainThree = await createMain('본편 3');
    const group = createGroup(mainThree.id, '연속 분기');
    const predecessor = await createSide('외전 1', { groupId: group.id });
    const target = await createSide('외전 2', { groupId: group.id, content: '' });
    seedMemory(mainOne, 'main-1');
    seedMemory(mainTwo, 'main-2');
    seedMemory(mainThree, 'main-3');
    seedMemory(predecessor, 'group-1');
    await episodesService.update(projectId, mainOne.id, {
      expectedRevision: mainOne.revision,
      title: '수정된 본편 1',
    });
    const refreshOrder = recordRefreshes();

    await episodesService.propose(projectId, {
      hint: '외전의 다음 전개',
      episodeId: target.id,
      expectedRevision: target.revision,
    });

    expect(refreshOrder).toEqual([mainOne.id, mainTwo.id, mainThree.id, predecessor.id]);
    expect(status(mainOne.id)).toBe('CONFIRMED');
    expect(status(mainTwo.id)).toBe('CONFIRMED');
    expect(status(mainThree.id)).toBe('CONFIRMED');
    expect(status(predecessor.id)).toBe('CONFIRMED');
    expect(episodesService.getScene(projectId, mainThree.id)).toMatchObject({
      location: `refreshed-scene:${mainThree.id}`,
    });
    const variables = directionVariables();
    expect(variables.recent_summaries).toContain(`refreshed-summary:${mainThree.id}`);
    expect(variables.recent_summaries).toContain(`refreshed-summary:${predecessor.id}`);
    expect(JSON.parse(variables.current_scene!)).toMatchObject({
      location: `refreshed-scene:${predecessor.id}`,
    });
  });

  it.each([
    { operation: 'propose', change: 'group predecessor' },
    { operation: 'propose', change: 'main anchor' },
    { operation: 'generate', change: 'group predecessor' },
    { operation: 'generate', change: 'main anchor' },
  ] as const)('rejects an in-flight side $operation after a $change change', async ({ operation, change }) => {
    const anchor = await createMain('분기점');
    const group = createGroup(anchor.id, '동시성 그룹');
    const predecessor = await createSide('선행 외전', { groupId: group.id });
    const target = await createSide('작성 대상', { groupId: group.id, content: '' });
    const events: StreamEvent[] = [];

    let finishProposal!: (value: { value: typeof proposal }) => void;
    let finishDraft!: (value: ReturnType<typeof draftCompletion>) => void;
    if (operation === 'propose') {
      ai.completeJson.mockImplementationOnce(() => new Promise((resolve) => {
        finishProposal = resolve;
      }));
    } else {
      ai.streamText.mockImplementationOnce(() => new Promise((resolve) => {
        finishDraft = resolve;
      }));
    }

    const pending = operation === 'propose'
      ? episodesService.propose(projectId, {
          hint: '다음 전개',
          episodeId: target.id,
          expectedRevision: target.revision,
        })
      : episodesService.generate(projectId, {
          title: target.title,
          direction: target.direction,
          episodeId: target.id,
          expectedRevision: target.revision,
        }, (event) => events.push(event));

    if (operation === 'propose') {
      await vi.waitFor(() => expect(ai.completeJson).toHaveBeenCalledTimes(1));
    } else {
      await vi.waitFor(() => expect(ai.streamText).toHaveBeenCalledTimes(1));
    }

    const changedEpisode = change === 'group predecessor' ? predecessor : anchor;
    await episodesService.update(projectId, changedEpisode.id, {
      expectedRevision: changedEpisode.revision,
      title: `수정된 ${changedEpisode.title}`,
    });

    const rejected = expect(pending).rejects.toBeInstanceOf(ConflictException);
    if (operation === 'propose') finishProposal({ value: proposal });
    else finishDraft(draftCompletion());
    await rejected;
    expect(events.some((event) => event.type === 'done')).toBe(false);
  });

  it.each(['shared canon', 'active improvement'] as const)(
    'rejects an in-flight canon-only side proposal after an accessible %s changes',
    async (contextKind) => {
      const target = await createSide('독립 외전', { content: '' });
      const stamp = '2026-09-07T00:00:00.000Z';
      if (contextKind === 'shared canon') {
        database.orm.insert(canonEntries).values({
          id: 'shared-canon',
          projectId,
          sideStoryGroupId: null,
          category: 'RULE',
          name: '공유 규칙',
          aliasesJson: '[]',
          content: '처음 규칙',
          metadataJson: '{}',
          status: 'ACTIVE',
          revision: 1,
          sourceEpisodeId: null,
          createdAt: stamp,
          updatedAt: stamp,
        }).run();
      } else {
        database.orm.insert(improvements).values({
          id: 'project-improvement',
          scope: 'PROJECT',
          projectId,
          title: '문장 규칙',
          rule: '처음 규칙',
          rationale: '',
          category: 'STYLE',
          tagsJson: '[]',
          beforeExample: null,
          afterExample: null,
          source: 'MANUAL',
          confidence: 1,
          duplicateOfId: null,
          conflictsWithIdsJson: '[]',
          active: true,
          revision: 1,
          createdAt: stamp,
          updatedAt: stamp,
        }).run();
      }

      let finishProposal!: (value: { value: typeof proposal }) => void;
      ai.completeJson.mockImplementationOnce(() => new Promise((resolve) => {
        finishProposal = resolve;
      }));
      const pending = episodesService.propose(projectId, {
        hint: '독립된 다음 전개',
        episodeId: target.id,
        expectedRevision: target.revision,
      });
      await vi.waitFor(() => expect(ai.completeJson).toHaveBeenCalledTimes(1));

      if (contextKind === 'shared canon') {
        database.orm.update(canonEntries).set({
          content: '바뀐 규칙',
          revision: 2,
          updatedAt: '2026-09-07T00:01:00.000Z',
        }).where(eq(canonEntries.id, 'shared-canon')).run();
      } else {
        database.orm.update(improvements).set({
          rule: '바뀐 규칙',
          revision: 2,
          updatedAt: '2026-09-07T00:01:00.000Z',
        }).where(eq(improvements.id, 'project-improvement')).run();
      }

      const rejected = expect(pending).rejects.toBeInstanceOf(ConflictException);
      finishProposal({ value: proposal });
      await rejected;
    },
  );
});
