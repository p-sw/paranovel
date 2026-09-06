import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseService } from '../src/database/database.service';
import {
  arcs,
  canonEntries,
  episodeSummaries,
  episodes,
  improvements,
  memoryChunks,
  sceneStates,
  sideStoryGroups,
} from '../src/database/schema';
import { EpisodesService } from '../src/episodes/episodes.service';
import { MemoryService } from '../src/memory/memory.service';
import { ProjectsService } from '../src/projects/projects.service';

describe('side-story memory isolation', () => {
  let database: DatabaseService;
  let memory: MemoryService;
  let episodeService: EpisodesService;
  let projectId: string;
  let embeddingGateway: { embeddings: ReturnType<typeof vi.fn> };
  const stamp = '2026-09-07T00:00:00.000Z';

  const episode = (
    id: string,
    kind: 'MAIN' | 'SIDE_STORY',
    number: number | null,
    options: { groupId?: string; branchId?: string } = {},
  ) => ({
    id,
    projectId,
    kind,
    number,
    sideStoryGroupId: options.groupId ?? null,
    branchFromEpisodeId: options.branchId ?? null,
    title: `${id} title`,
    direction: `${id} direction`,
    content: `timelineproof ${id} content`,
    revision: 1,
    status: 'CONFIRMED',
    createdAt: stamp,
    updatedAt: stamp,
    deletedAt: null,
  });

  const addSummaryAndScene = (episodeId: string, location: string) => {
    database.orm.insert(episodeSummaries).values({
      episodeId,
      synopsis: `${episodeId} synopsis`,
      eventsJson: JSON.stringify([`timelineproof ${episodeId} event`]),
      emotionalChangesJson: '[]',
      foreshadowingIntroducedJson: JSON.stringify([`${episodeId} clue`]),
      foreshadowingResolvedJson: '[]',
      sourceRevision: 1,
      sourceHash: `${episodeId}-hash`,
      updatedAt: stamp,
    }).run();
    database.orm.insert(sceneStates).values({
      episodeId,
      location,
      storyTime: `${episodeId} time`,
      pointOfView: `${episodeId} pov`,
      characterNamesJson: '[]',
      goal: `${episodeId} goal`,
      sourceRevision: 1,
      updatedAt: stamp,
    }).run();
  };

  beforeEach(async () => {
    vi.stubEnv('DB_PATH', ':memory:');
    vi.stubEnv('OPENROUTER_EMBEDDING_DIMENSIONS', '4');
    database = new DatabaseService();
    embeddingGateway = {
      embeddings: vi.fn(async (texts: string[]) => texts.map((text) => {
        if (text.includes('boundaryvector') || text.includes('futurevector')) return [1, 0, 0, 0];
        if (text.includes('eligiblevector')) return [0.9, 0.1, 0, 0];
        return [0, 0, 1, 0];
      })),
    };
    memory = new MemoryService(database, embeddingGateway as never);
    const projects = new ProjectsService(database);
    episodeService = new EpisodesService(database, projects, memory, {} as never);
    projectId = projects.createInternal({
      title: '흐름 기록관',
      logline: '서로 섞이지 않는 이야기들',
      genreTags: ['판타지'],
    }).id;

    database.orm.insert(episodes).values([
      episode('main-1', 'MAIN', 1),
      episode('main-2', 'MAIN', 2),
      episode('main-3', 'MAIN', 3),
    ]).run();
    database.orm.insert(sideStoryGroups).values([
      {
        id: 'group-a', projectId, title: 'A 외전', description: '',
        branchFromEpisodeId: 'main-1', nextEpisodeNumber: 3, revision: 1,
        createdAt: stamp, updatedAt: stamp,
      },
      {
        id: 'group-b', projectId, title: 'B 외전', description: '',
        branchFromEpisodeId: 'main-2', nextEpisodeNumber: 2, revision: 1,
        createdAt: stamp, updatedAt: stamp,
      },
    ]).run();
    database.orm.insert(episodes).values([
      episode('group-a-1', 'SIDE_STORY', 1, { groupId: 'group-a' }),
      episode('group-a-2', 'SIDE_STORY', 2, { groupId: 'group-a' }),
      episode('group-b-1', 'SIDE_STORY', 1, { groupId: 'group-b' }),
      episode('standalone-empty', 'SIDE_STORY', null),
      episode('standalone-branch', 'SIDE_STORY', null, { branchId: 'main-1' }),
    ]).run();

    for (const [id, location] of [
      ['main-1', 'main one room'], ['main-2', 'main two room'], ['main-3', 'main three room'],
      ['group-a-1', 'group a one room'], ['group-a-2', 'group a two room'],
      ['group-b-1', 'group b one room'], ['standalone-empty', 'standalone room'],
      ['standalone-branch', 'standalone branch room'],
    ] as const) addSummaryAndScene(id, location);

    database.orm.insert(canonEntries).values([
      {
        id: 'canon-main', projectId, sideStoryGroupId: null, category: 'OTHER',
        name: '공통 정사', aliasesJson: '[]', content: 'timelineproof shared canon',
        metadataJson: '{}', status: 'ACTIVE', revision: 1, sourceEpisodeId: null,
        createdAt: stamp, updatedAt: stamp,
      },
      {
        id: 'canon-a', projectId, sideStoryGroupId: 'group-a', category: 'OTHER',
        name: 'A 정사', aliasesJson: '[]', content: 'timelineproof group a canon',
        metadataJson: '{}', status: 'ACTIVE', revision: 1, sourceEpisodeId: null,
        createdAt: stamp, updatedAt: stamp,
      },
      {
        id: 'canon-b', projectId, sideStoryGroupId: 'group-b', category: 'OTHER',
        name: 'B 정사', aliasesJson: '[]', content: 'timelineproof group b canon',
        metadataJson: '{}', status: 'ACTIVE', revision: 1, sourceEpisodeId: null,
        createdAt: stamp, updatedAt: stamp,
      },
    ]).run();
    database.orm.insert(arcs).values([
      {
        id: 'arc-main', projectId, sideStoryGroupId: null, title: '본편 아크',
        startEpisodeNumber: 1, endEpisodeNumber: 10, goal: 'timelineproof main arc',
        conflict: '', twistPlan: '', reversalPlanJson: '[]', status: 'ACTIVE', revision: 1,
        createdAt: stamp, updatedAt: stamp,
      },
      {
        id: 'arc-a', projectId, sideStoryGroupId: 'group-a', title: 'A 아크',
        startEpisodeNumber: 1, endEpisodeNumber: 3, goal: 'timelineproof group a arc',
        conflict: '', twistPlan: '', reversalPlanJson: '[]', status: 'ACTIVE', revision: 1,
        createdAt: stamp, updatedAt: stamp,
      },
      {
        id: 'arc-b', projectId, sideStoryGroupId: 'group-b', title: 'B 아크',
        startEpisodeNumber: 1, endEpisodeNumber: 3, goal: 'timelineproof group b arc',
        conflict: '', twistPlan: '', reversalPlanJson: '[]', status: 'ACTIVE', revision: 1,
        createdAt: stamp, updatedAt: stamp,
      },
    ]).run();
    database.orm.insert(improvements).values({
      id: 'improvement', scope: 'PROJECT', projectId, title: '공통 개선점',
      rule: 'timelineproof concise prose', rationale: '', category: 'STYLE', tagsJson: '[]',
      beforeExample: null, afterExample: null, source: 'MANUAL', confidence: 1,
      duplicateOfId: null, conflictsWithIdsJson: '[]', active: true, revision: 1,
      createdAt: stamp, updatedAt: stamp,
    }).run();
    await memory.reindexProject(projectId);
  });

  afterEach(() => {
    database.onApplicationShutdown();
    vi.unstubAllEnvs();
  });

  it('indexes every source with flow metadata and keeps default search on the main flow', async () => {
    const indexed = database.orm.select({
      sourceType: memoryChunks.sourceType,
      sourceId: memoryChunks.sourceId,
      flowKey: memoryChunks.flowKey,
      flowPosition: memoryChunks.flowPosition,
    }).from(memoryChunks).all();
    const source = (sourceType: string, sourceId: string) =>
      indexed.find((row) => row.sourceType === sourceType && row.sourceId === sourceId);

    expect(source('EPISODE', 'main-1')).toMatchObject({ flowKey: 'MAIN', flowPosition: 1 });
    expect(source('EPISODE', 'group-a-1')).toMatchObject({ flowKey: 'GROUP:group-a', flowPosition: 1 });
    expect(source('EPISODE', 'standalone-empty')).toMatchObject({
      flowKey: 'STANDALONE:standalone-empty', flowPosition: null,
    });
    expect(source('CANON', 'canon-main')).toMatchObject({ flowKey: 'SHARED', flowPosition: null });
    expect(source('CANON', 'canon-a')).toMatchObject({ flowKey: 'GROUP:group-a', flowPosition: null });
    expect(source('ARC', 'arc-main')).toMatchObject({ flowKey: 'MAIN', flowPosition: null });
    expect(source('ARC', 'arc-a')).toMatchObject({ flowKey: 'GROUP:group-a', flowPosition: null });

    const results = await memory.search(projectId, 'timelineproof', 100);
    const ids = new Set(results.map((result) => result.sourceId));
    expect(ids).toEqual(new Set(['canon-main', 'arc-main', 'improvement', 'main-1', 'main-2', 'main-3']));
  });

  it('applies the main future boundary inside vector KNN before its candidate limit', async () => {
    await memory.indexSource({
      projectId,
      sourceType: 'EPISODE',
      sourceId: 'main-1',
      text: 'eligiblevector past memory',
    });
    for (let number = 4; number <= 124; number += 1) {
      const sourceId = `main-future-${number}`;
      database.orm.insert(episodes).values(episode(sourceId, 'MAIN', number)).run();
      await memory.indexSource({
        projectId,
        sourceType: 'EPISODE',
        sourceId,
        text: `futurevector ${sourceId}`,
      });
    }

    const [result] = await memory.search(projectId, 'boundaryvector query', 1, 2);
    expect(result).toMatchObject({ sourceType: 'EPISODE', sourceId: 'main-1' });
  });

  it('does not restore an episode index after its flow was invalidated during embedding', async () => {
    let finishEmbedding!: (vectors: number[][]) => void;
    embeddingGateway.embeddings.mockImplementationOnce(
      () => new Promise<number[][]>((resolve) => { finishEmbedding = resolve; }),
    );
    const pending = memory.indexSource({
      projectId,
      sourceType: 'EPISODE',
      sourceId: 'group-a-1',
      text: 'replacement memory awaiting an embedding',
    });
    await vi.waitFor(() => expect(finishEmbedding).toBeTypeOf('function'));

    database.orm.update(episodes).set({ status: 'MEMORY_STALE' })
      .where(eq(episodes.id, 'group-a-1')).run();
    memory.removeSource('EPISODE', 'group-a-1');
    memory.removeSource('EPISODE_SUMMARY', 'group-a-1');
    finishEmbedding([[1, 0, 0, 0]]);
    await pending;

    expect(database.orm.select().from(memoryChunks)
      .where(eq(memoryChunks.sourceId, 'group-a-1')).all()).toEqual([]);
  });

  it('preserves draft review states while invalidating every side flow anchored after a main edit', async () => {
    const expectedStatuses = new Map([
      ['group-a-1', 'DRAFT'],
      ['group-a-2', 'NEEDS_REVIEW'],
      ['group-b-1', 'MEMORY_STALE'],
      ['standalone-branch', 'INCOMPLETE'],
    ]);
    for (const [sourceId, status] of expectedStatuses) {
      database.orm.update(episodes).set({
        status,
        ...(status === 'INCOMPLETE' ? { content: '' } : {}),
      }).where(eq(episodes.id, sourceId)).run();
    }

    await episodeService.update(projectId, 'main-1', {
      expectedRevision: 1,
      title: 'changed anchor title',
    });

    for (const [sourceId, status] of expectedStatuses) {
      expect(database.orm.select({ status: episodes.status }).from(episodes)
        .where(eq(episodes.id, sourceId)).get()).toEqual({ status });
    }
    const affectedIds = new Set(expectedStatuses.keys());
    expect(database.orm.select({ sourceId: memoryChunks.sourceId }).from(memoryChunks).all()
      .filter((row) => affectedIds.has(row.sourceId))).toEqual([]);
    expect(database.orm.select({ sourceId: memoryChunks.sourceId }).from(memoryChunks)
      .where(eq(memoryChunks.sourceId, 'standalone-empty')).all().length).toBeGreaterThan(0);
  });

  it('preserves draft review states while invalidating later episodes in the same group', async () => {
    const expectedStatuses = new Map([
      ['group-a-3', 'DRAFT'],
      ['group-a-4', 'NEEDS_REVIEW'],
      ['group-a-5', 'MEMORY_STALE'],
      ['group-a-6', 'INCOMPLETE'],
    ]);
    for (const [sourceId, status] of expectedStatuses) {
      const number = Number(sourceId.slice(sourceId.lastIndexOf('-') + 1));
      database.orm.insert(episodes).values({
        ...episode(sourceId, 'SIDE_STORY', number, { groupId: 'group-a' }),
        status,
        ...(status === 'INCOMPLETE' ? { content: '' } : {}),
      }).run();
      for (const sourceType of ['EPISODE', 'EPISODE_SUMMARY']) {
        await memory.indexSource({ projectId, sourceType, sourceId, text: `${sourceId} indexed memory` });
      }
    }

    await episodeService.update(projectId, 'group-a-2', {
      expectedRevision: 1,
      title: 'changed group predecessor',
    });

    for (const [sourceId, status] of expectedStatuses) {
      expect(database.orm.select({ status: episodes.status }).from(episodes)
        .where(eq(episodes.id, sourceId)).get()).toEqual({ status });
    }
    const affectedIds = new Set(expectedStatuses.keys());
    expect(database.orm.select({ sourceId: memoryChunks.sourceId }).from(memoryChunks).all()
      .filter((row) => affectedIds.has(row.sourceId))).toEqual([]);
    expect(database.orm.select({ sourceId: memoryChunks.sourceId }).from(memoryChunks)
      .where(eq(memoryChunks.sourceId, 'group-b-1')).all().length).toBeGreaterThan(0);
  });

  it('assembles main, standalone, branched and grouped timelines without cross-flow leaks', async () => {
    const main = await memory.assemble(projectId, 'timelineproof', 'main-2', {
      previousEpisodeScene: true,
    });
    expect(JSON.parse(main.canon).map((item: { ref: string }) => item.ref)).toEqual(['canon:canon-main']);
    expect(JSON.parse(main.currentArc)).toMatchObject({ ref: 'arc:arc-main' });
    expect(JSON.parse(main.currentScene)).toMatchObject({ location: 'main one room' });
    expect(JSON.parse(main.recentSummaries).map((item: { episode_id: string }) => item.episode_id))
      .toEqual(['main-1']);
    expect(new Set(JSON.parse(main.retrievedMemories).map((item: { ref: string }) => item.ref)))
      .toEqual(new Set(['CANON:canon-main', 'ARC:arc-main', 'IMPROVEMENT:improvement',
        'EPISODE:main-1', 'EPISODE_SUMMARY:main-1']));

    const standalone = await memory.assemble(projectId, 'timelineproof', 'standalone-empty', {
      previousEpisodeScene: true,
    });
    expect(JSON.parse(standalone.canon).map((item: { ref: string }) => item.ref)).toEqual(['canon:canon-main']);
    expect(JSON.parse(standalone.currentArc)).toBeNull();
    expect(JSON.parse(standalone.currentScene)).toBeNull();
    expect(JSON.parse(standalone.recentSummaries)).toEqual([]);
    expect(JSON.parse(standalone.openForeshadowing)).toEqual([]);
    expect(JSON.parse(standalone.retrievedMemories).map((item: { ref: string }) => item.ref))
      .toEqual(expect.arrayContaining(['CANON:canon-main', 'IMPROVEMENT:improvement']));
    expect(JSON.parse(standalone.retrievedMemories)
      .some((item: { ref: string }) => /^(EPISODE|EPISODE_SUMMARY|ARC):/.test(item.ref))).toBe(false);
    expect(JSON.parse((await memory.assemble(
      projectId, 'timelineproof', 'standalone-empty',
    )).currentScene)).toMatchObject({ location: 'standalone room' });

    const branched = await memory.assemble(projectId, 'timelineproof', 'standalone-branch', {
      previousEpisodeScene: true,
    });
    expect(JSON.parse(branched.currentScene)).toMatchObject({ location: 'main one room' });
    expect(JSON.parse(branched.recentSummaries).map((item: { episode_id: string }) => item.episode_id))
      .toEqual(['main-1']);
    const branchRefs = new Set(JSON.parse(branched.retrievedMemories).map((item: { ref: string }) => item.ref));
    expect(branchRefs).toEqual(new Set(['CANON:canon-main', 'IMPROVEMENT:improvement',
      'EPISODE:main-1', 'EPISODE_SUMMARY:main-1']));
    expect(JSON.parse((await memory.assemble(
      projectId, 'timelineproof', 'standalone-branch',
    )).currentScene)).toMatchObject({ location: 'standalone branch room' });

    const grouped = await memory.assemble(projectId, 'timelineproof', 'group-a-2', {
      previousEpisodeScene: true,
    });
    expect(JSON.parse(grouped.canon).map((item: { ref: string }) => item.ref).sort())
      .toEqual(['canon:canon-a', 'canon:canon-main']);
    expect(JSON.parse(grouped.currentArc)).toMatchObject({ ref: 'arc:arc-a' });
    expect(JSON.parse(grouped.currentScene)).toMatchObject({ location: 'group a one room' });
    expect(JSON.parse(grouped.recentSummaries).map((item: { episode_id: string }) => item.episode_id))
      .toEqual(['group-a-1', 'main-1']);
    const groupRefs = new Set(JSON.parse(grouped.retrievedMemories).map((item: { ref: string }) => item.ref));
    expect(groupRefs).toEqual(new Set([
      'CANON:canon-main', 'CANON:canon-a', 'ARC:arc-a', 'IMPROVEMENT:improvement',
      'EPISODE:main-1', 'EPISODE_SUMMARY:main-1',
      'EPISODE:group-a-1', 'EPISODE_SUMMARY:group-a-1',
    ]));
  });

  it('uses a group next-number boundary for virtual drafts and rejects foreign branch ownership', async () => {
    const virtual = await memory.assemble(projectId, 'timelineproof', undefined, {
      previousEpisodeScene: true,
      narrativeContext: {
        kind: 'SIDE_STORY', sideStoryGroupId: 'group-a', branchFromEpisodeId: 'main-1',
      },
    });
    expect(JSON.parse(virtual.currentScene)).toMatchObject({ location: 'group a two room' });
    const refs = new Set(JSON.parse(virtual.retrievedMemories).map((item: { ref: string }) => item.ref));
    expect(refs).toEqual(new Set([
      'CANON:canon-main', 'CANON:canon-a', 'ARC:arc-a', 'IMPROVEMENT:improvement',
      'EPISODE:main-1', 'EPISODE_SUMMARY:main-1',
      'EPISODE:group-a-1', 'EPISODE_SUMMARY:group-a-1',
      'EPISODE:group-a-2', 'EPISODE_SUMMARY:group-a-2',
    ]));

    await expect(memory.assemble(projectId, '', undefined, {
      narrativeContext: {
        kind: 'SIDE_STORY', sideStoryGroupId: 'group-a', branchFromEpisodeId: 'main-2',
      },
    })).rejects.toThrow('Side-story branch does not belong to the group');

    const otherProject = new ProjectsService(database).createInternal({
      title: '다른 작품', logline: '다른 흐름', genreTags: ['판타지'],
    });
    database.orm.insert(episodes).values({
      ...episode('foreign-main', 'MAIN', 1), projectId: otherProject.id,
    }).run();
    await expect(memory.assemble(projectId, '', undefined, {
      narrativeContext: {
        kind: 'SIDE_STORY', sideStoryGroupId: null, branchFromEpisodeId: 'foreign-main',
      },
    })).rejects.toThrow('Branch episode not found');
  });
});
