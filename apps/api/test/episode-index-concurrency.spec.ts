import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseService } from '../src/database/database.service';
import { episodes } from '../src/database/schema';
import { MemoryService } from '../src/memory/memory.service';
import { ProjectsService } from '../src/projects/projects.service';

describe('episode indexing during order changes', () => {
  let database: DatabaseService;
  let memory: MemoryService;
  let projectId: string;
  const embeddings = vi.fn(async (texts: string[]) => texts.map(() => [1, 0, 0, 0]));

  beforeEach(() => {
    vi.stubEnv('DB_PATH', ':memory:');
    vi.stubEnv('OPENROUTER_EMBEDDING_DIMENSIONS', '4');
    embeddings.mockReset().mockImplementation(async (texts) => texts.map(() => [1, 0, 0, 0]));
    database = new DatabaseService();
    memory = new MemoryService(database, { embeddings } as never);
    projectId = new ProjectsService(database).createInternal({
      title: '순서 검증', logline: '회차 순서가 바뀐다.', genreTags: ['판타지'],
    }).id;
    const stamp = new Date().toISOString();
    database.orm.insert(episodes).values({
      id: 'episode-one', projectId, number: 1, title: '첫 이야기', direction: '',
      content: '이야기', revision: 1, status: 'CONFIRMED', createdAt: stamp, updatedAt: stamp,
    }).run();
  });

  afterEach(() => {
    database.onApplicationShutdown();
    vi.unstubAllEnvs();
  });

  it.each(['EPISODE', 'EPISODE_SUMMARY'])('does not overwrite a newer %s index when old embeddings finish late', async (sourceType) => {
    let finish!: (vectors: number[][]) => void;
    embeddings.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const pending = memory.indexSource({ projectId, sourceType, sourceId: 'episode-one', text: '이전 순서의 기억' });

    database.connection.prepare('UPDATE episodes SET number = 2, revision = 2 WHERE id = ?').run('episode-one');
    await memory.indexSource({
      projectId, sourceType, sourceId: 'episode-one', text: '새 순서의 기억',
      expectedEpisode: { number: 2, revision: 2 },
    });
    const current = database.connection.prepare('SELECT * FROM memory_chunks').all();
    const currentFts = database.connection.prepare('SELECT * FROM memory_chunks_fts').all();
    finish([[0, 1, 0, 0]]);
    await pending;

    expect(database.connection.prepare('SELECT * FROM memory_chunks').all()).toEqual(current);
    expect(database.connection.prepare('SELECT * FROM memory_chunks_fts').all()).toEqual(currentFts);
    expect(current).toHaveLength(1);
    expect(current[0]).toMatchObject({ content: '새 순서의 기억' });
    if (database.vectorAvailable) {
      expect(database.connection.prepare('SELECT episode_number FROM memory_chunks_vec').all()).toEqual([{ episode_number: 2 }]);
    }
  });

  it.each(['number', 'revision', 'delete'] as const)('discards pending chunks after a %s change', async (change) => {
    let finish!: (vectors: number[][]) => void;
    embeddings.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const pending = memory.indexSource({ projectId, sourceType: 'EPISODE', sourceId: 'episode-one', text: '오래된 기억' });
    if (change === 'delete') database.connection.prepare('DELETE FROM episodes WHERE id = ?').run('episode-one');
    else if (change === 'number') database.connection.prepare('UPDATE episodes SET number = 2 WHERE id = ?').run('episode-one');
    else database.connection.prepare('UPDATE episodes SET revision = 2 WHERE id = ?').run('episode-one');
    finish([[1, 0, 0, 0]]);
    await pending;

    expect(database.connection.prepare('SELECT * FROM memory_chunks').all()).toEqual([]);
    expect(database.connection.prepare('SELECT * FROM memory_chunks_fts').all()).toEqual([]);
    if (database.vectorAvailable) expect(database.connection.prepare('SELECT chunk_id FROM memory_chunks_vec').all()).toEqual([]);
  });

  it('skips an old source snapshot queued before indexing began', async () => {
    database.connection.prepare('UPDATE episodes SET number = 2, revision = 2 WHERE id = ?').run('episode-one');
    await memory.indexSource({
      projectId, sourceType: 'EPISODE', sourceId: 'episode-one', text: '1화의 오래된 기억',
      expectedEpisode: { number: 1, revision: 1 },
    });
    expect(embeddings).not.toHaveBeenCalled();
    expect(database.connection.prepare('SELECT * FROM memory_chunks').all()).toEqual([]);
  });

  it('keeps keyword indexing when embeddings fail for a current episode', async () => {
    embeddings.mockRejectedValueOnce(new Error('Offline'));
    await memory.indexSource({ projectId, sourceType: 'EPISODE', sourceId: 'episode-one', text: '키워드 기억' });
    expect(database.connection.prepare('SELECT content FROM memory_chunks_fts').all()).toEqual([{ content: '키워드 기억' }]);
  });
});
