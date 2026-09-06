import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArcsService } from '../src/arcs/arcs.service';
import { DatabaseService } from '../src/database/database.service';
import { MemoryService } from '../src/memory/memory.service';
import { ProjectsService } from '../src/projects/projects.service';

describe('episode-specific arc reversals', () => {
  let database: DatabaseService;
  let memory: MemoryService;
  let arcs: ArcsService;
  let projectId: string;
  const fields = {
    title: '왕도의 그림자', startEpisodeNumber: 1, endEpisodeNumber: 10,
    goal: '왕도의 비밀을 밝힌다', conflict: '왕실의 추격', status: 'ACTIVE',
  };
  const reversalPlan = [{ episode: 8, description: '조력자의 정체가 드러난다' }];

  beforeEach(() => {
    vi.stubEnv('DB_PATH', ':memory:');
    vi.stubEnv('OPENROUTER_EMBEDDING_DIMENSIONS', '4');
    database = new DatabaseService();
    memory = new MemoryService(database, {
      embeddings: async (texts: string[]) => texts.map(() => [0, 1, 0, 1]),
    } as never);
    arcs = new ArcsService(database, memory, {} as never);
    projectId = new ProjectsService(database).createInternal({
      title: '왕도의 비밀', logline: '왕실의 음모를 밝힌다', genreTags: ['판타지'],
    }).id;
  });

  afterEach(() => { database.onApplicationShutdown(); vi.unstubAllEnvs(); });

  it('persists, revises and clears reversals without a separate summary', async () => {
    const created = await arcs.create(projectId, { ...fields, reversalPlan });
    expect(created.reversalPlan).toEqual(reversalPlan);
    expect(created).not.toHaveProperty('twistPlan');
    const updatedPlan = [{ episode: 10, description: '적의 목적이 복수였음이 밝혀진다' }];
    const updated = await arcs.update(projectId, created.id, {
      expectedRevision: created.revision, reversalPlan: updatedPlan,
    });
    expect(arcs.current(projectId)?.reversalPlan).toEqual(updatedPlan);
    const assembled = await memory.assemble(projectId, '복수');
    expect(JSON.parse(assembled.currentArc).reversalPlan).toEqual(updatedPlan);
    expect(assembled.retrievedMemories).toContain('10화 — 적의 목적이 복수였음이 밝혀진다');
    expect(assembled.retrievedMemories).not.toContain(reversalPlan[0]!.description);

    await arcs.update(projectId, updated.id, { expectedRevision: updated.revision, reversalPlan: [] });
    expect(arcs.current(projectId)?.reversalPlan).toEqual([]);
    expect((await memory.assemble(projectId, '복수')).retrievedMemories).not.toContain(updatedPlan[0]!.description);
  });

  it('keeps legacy summaries stored but excludes them from arc views and retrieved memory', async () => {
    const arc = await arcs.create(projectId, { ...fields, reversalPlan });
    const legacySummary = '예전 개요에만 있던 내용';
    database.connection.prepare('UPDATE arcs SET twist_plan = ? WHERE id = ?').run(legacySummary, arc.id);
    await memory.indexSource({ projectId, sourceType: 'ARC', sourceId: arc.id, text: legacySummary });

    expect(arcs.list(projectId)[0]).not.toHaveProperty('twistPlan');
    const assembled = await memory.assemble(projectId, '예전');
    expect(assembled.currentArc).not.toContain(legacySummary);
    expect(assembled.retrievedMemories).not.toContain(legacySummary);
    expect(assembled.retrievedMemories).toContain('8화 — 조력자의 정체가 드러난다');

    await memory.reindexProject(projectId);
    const chunks = database.connection.prepare("SELECT content FROM memory_chunks WHERE source_type = 'ARC' AND source_id = ?")
      .all(arc.id) as Array<{ content: string }>;
    expect(chunks.map((chunk) => chunk.content).join('\n')).toContain('8화 — 조력자의 정체가 드러난다');
    expect(chunks.map((chunk) => chunk.content).join('\n')).not.toContain(legacySummary);
    expect(database.connection.prepare('SELECT twist_plan FROM arcs WHERE id = ?').get(arc.id))
      .toEqual({ twist_plan: legacySummary });
  });

  it('keeps long arc search results bounded to excerpts', async () => {
    await arcs.create(projectId, { ...fields, goal: '왕도의 비밀을 밝힌다. '.repeat(500), reversalPlan });
    const results = await memory.search(projectId, '조력자');
    expect(results.length).toBeGreaterThan(1);
    expect(results.every((result) => result.content.length <= 1_200)).toBe(true);
    expect(results.some((result) => result.content.includes(reversalPlan[0]!.description))).toBe(true);
  });

  it('can reindex legacy arrays containing malformed entries', async () => {
    const arc = await arcs.create(projectId, { ...fields, reversalPlan });
    database.connection.prepare('UPDATE arcs SET reversal_plan_json = ? WHERE id = ?')
      .run(JSON.stringify([null, {}, 'old entry', ...reversalPlan]), arc.id);
    await memory.reindexProject(projectId);
    const results = await memory.search(projectId, '조력자');
    expect(results[0]?.content).toContain('8화 — 조력자의 정체가 드러난다');
    expect(results[0]?.content).not.toContain('undefined');
  });
});
