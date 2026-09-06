import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArcsService } from '../src/arcs/arcs.service';
import { DatabaseService } from '../src/database/database.service';
import { MemoryService } from '../src/memory/memory.service';
import { ProjectsService } from '../src/projects/projects.service';

const commonFields = {
  goal: '월광기록의 비밀을 밝힌다.',
  conflict: '왕실의 추격을 피한다.',
  reversalPlan: [],
};

describe('arc lifecycle memory', () => {
  let database: DatabaseService;
  let memory: MemoryService;
  let arcs: ArcsService;
  let projectId: string;

  beforeEach(() => {
    vi.stubEnv('DB_PATH', ':memory:');
    vi.stubEnv('OPENROUTER_EMBEDDING_DIMENSIONS', '4');
    database = new DatabaseService();
    memory = new MemoryService(database, {
      embeddings: vi.fn(async () => []),
    } as never);
    arcs = new ArcsService(database, memory, {} as never);
    projectId = new ProjectsService(database).createInternal({
      title: '달의 기록',
      logline: '기록관이 사라진 달을 추적한다.',
      genreTags: ['판타지'],
    }).id;
  });

  afterEach(() => {
    database.onApplicationShutdown();
    vi.unstubAllEnvs();
  });

  it('keeps the current active arc searchable after many direct active replacements', async () => {
    let current = await arcs.create(projectId, {
      ...commonFields,
      title: '첫 달의 비밀',
      startEpisodeNumber: 1,
      endEpisodeNumber: 5,
      status: 'ACTIVE',
    });

    // More than the search candidate limit makes stale archived chunks capable
    // of crowding the current source out before lifecycle filtering runs.
    for (let index = 1; index <= 24; index += 1) {
      const planned = await arcs.create(projectId, {
        ...commonFields,
        title: `달의 비밀 ${index + 1}`,
        startEpisodeNumber: index * 5 + 1,
        endEpisodeNumber: index * 5 + 5,
      });
      current = await arcs.update(projectId, planned.id, {
        expectedRevision: planned.revision,
        status: 'ACTIVE',
        confirmProtected: true,
      });
    }

    expect(arcs.list(projectId).filter((arc) => arc.status === 'ARCHIVED')).toHaveLength(24);
    const results = await memory.search(projectId, '월광기록', 12);
    expect(results.map((result) => result.sourceId)).toContain(current.id);
    expect(results.every((result) => arcs.get(projectId, result.sourceId).status === 'ACTIVE')).toBe(true);
  });

  it('physically excludes planned and archived arc chunks when reindexing', async () => {
    const active = await arcs.create(projectId, {
      ...commonFields,
      title: '현재 아크',
      startEpisodeNumber: 1,
      endEpisodeNumber: 5,
      status: 'ACTIVE',
    });
    const completeSeed = await arcs.create(projectId, {
      ...commonFields,
      title: '완료 아크',
      startEpisodeNumber: 6,
      endEpisodeNumber: 10,
    });
    const planned = await arcs.create(projectId, {
      ...commonFields,
      title: '대기 아크',
      startEpisodeNumber: 11,
      endEpisodeNumber: 15,
    });
    const archivedSeed = await arcs.create(projectId, {
      ...commonFields,
      title: '폐기 아크',
      startEpisodeNumber: 16,
      endEpisodeNumber: 20,
    });
    database.connection.prepare('UPDATE arcs SET status = ? WHERE id = ?')
      .run('COMPLETE', completeSeed.id);
    database.connection.prepare('UPDATE arcs SET status = ? WHERE id = ?')
      .run('ARCHIVED', archivedSeed.id);
    const complete = arcs.get(projectId, completeSeed.id);
    const archived = arcs.get(projectId, archivedSeed.id);

    // Simulate stale chunks written by an older version that indexed every arc.
    database.connection.prepare('UPDATE arcs SET status = ? WHERE id = ?').run('COMPLETE', planned.id);
    await memory.indexSource({
      projectId,
      sourceType: 'ARC',
      sourceId: planned.id,
      text: '레거시 대기 아크 청크',
    });
    database.connection.prepare('UPDATE arcs SET status = ? WHERE id = ?').run('PLANNED', planned.id);
    database.connection.prepare('UPDATE arcs SET status = ? WHERE id = ?').run('COMPLETE', archived.id);
    await memory.indexSource({
      projectId,
      sourceType: 'ARC',
      sourceId: archived.id,
      text: '레거시 폐기 아크 청크',
    });
    database.connection.prepare('UPDATE arcs SET status = ? WHERE id = ?').run('ARCHIVED', archived.id);
    expect(arcChunkSourceIds(database)).toEqual(expect.arrayContaining([planned.id, archived.id]));

    await memory.reindexProject(projectId);

    expect(arcChunkSourceIds(database)).toEqual([active.id, complete.id].sort());
  });
});

function arcChunkSourceIds(database: DatabaseService): string[] {
  return (database.connection
    .prepare("SELECT DISTINCT source_id AS sourceId FROM memory_chunks WHERE source_type = 'ARC'")
    .all() as Array<{ sourceId: string }>)
    .map((row) => row.sourceId)
    .sort();
}
