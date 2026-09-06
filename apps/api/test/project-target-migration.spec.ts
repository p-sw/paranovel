import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { DatabaseService } from '../src/database/database.service';

const PROJECT_COLUMNS_BEFORE_TARGETS = `
  id, title, logline, genre_tags_json, details_json, default_target_chars,
  next_episode_number, revision, created_at, updated_at, deleted_at
`;

it('adds project target metadata to a v12 database without losing data and only runs once', () => {
  const directory = mkdtempSync(join(tmpdir(), 'paranovel-project-target-migration-'));
  const dbPath = join(directory, 'legacy.sqlite');
  let database: DatabaseService | undefined;
  let legacy: Database.Database | undefined;

  try {
    vi.stubEnv('DB_PATH', dbPath);
    vi.stubEnv('OPENROUTER_EMBEDDING_DIMENSIONS', '4');
    database = new DatabaseService();
    database.onApplicationShutdown();

    legacy = new Database(dbPath);
    legacy.pragma('foreign_keys = ON');
    legacy.exec(`
      ALTER TABLE projects DROP COLUMN target_episode_source;
      ALTER TABLE projects DROP COLUMN target_episode;
      DELETE FROM schema_migrations WHERE version = 13;

      INSERT INTO projects (
        id, title, logline, genre_tags_json, details_json, default_target_chars,
        next_episode_number, revision, created_at, updated_at
      ) VALUES (
        'project', '경계의 기록', '문 너머의 도시를 되찾는 이야기', '["판타지","미스터리"]',
        '{"tone":"긴장감"}', 7200, 4, 7, '2026-09-01T00:00:00.000Z', '2026-09-02T00:00:00.000Z'
      );
      INSERT INTO project_creation_sessions (
        id, project_id, logline, genre_tags_json, answers_json, transcript_json,
        blueprint_json, title_asked, status, created_at, updated_at
      ) VALUES (
        'session', 'project', '문 너머의 도시를 되찾는 이야기', '["판타지"]',
        '{"hero":"해원"}', '[{"role":"user","content":"시작"}]', '{"title":"경계의 기록"}',
        1, 'COMMITTED', '2026-09-01T00:00:00.000Z', '2026-09-02T00:00:00.000Z'
      );
      INSERT INTO episodes (
        id, project_id, number, title, direction, content, revision, status, created_at, updated_at
      ) VALUES (
        'episode', 'project', 2, '닫힌 문', '문을 조사한다', '해원은 문 앞에 섰다.', 3, 'CONFIRMED',
        '2026-09-01T00:00:00.000Z', '2026-09-02T00:00:00.000Z'
      );
      INSERT INTO arcs (
        id, project_id, title, start_episode_number, end_episode_number, goal, conflict,
        twist_plan, reversal_plan_json, status, revision, created_at, updated_at
      ) VALUES (
        'arc', 'project', '문의 비밀', 1, 8, '문을 연다', '도시가 문을 막는다', '',
        '[{"episode":4,"description":"문은 안에서 잠겼다"}]', 'ACTIVE', 2,
        '2026-09-01T00:00:00.000Z', '2026-09-02T00:00:00.000Z'
      );
      INSERT INTO canon_entries (
        id, project_id, category, name, aliases_json, content, metadata_json, status,
        revision, source_episode_id, created_at, updated_at
      ) VALUES (
        'canon', 'project', 'LOCATION', '경계문', '["문"]', '두 도시를 잇는 문',
        '{"district":"북쪽"}', 'ACTIVE', 4, 'episode',
        '2026-09-01T00:00:00.000Z', '2026-09-02T00:00:00.000Z'
      );
    `);

    expect(
      legacy.prepare("SELECT name FROM pragma_table_info('projects') WHERE name LIKE 'target_episode%'").all(),
    ).toEqual([]);
    expect(legacy.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 13').get()).toEqual({
      count: 0,
    });
    const projectBefore = legacy
      .prepare(`SELECT ${PROJECT_COLUMNS_BEFORE_TARGETS} FROM projects WHERE id = 'project'`)
      .get();
    const relatedTables = ['project_creation_sessions', 'episodes', 'arcs', 'canon_entries'] as const;
    const relatedBefore = relatedTables.map((table) => legacy!.prepare(`SELECT * FROM ${table}`).all());
    legacy.close();

    database = new DatabaseService();
    const targetColumns = database.connection
      .prepare("SELECT name, type FROM pragma_table_info('projects') WHERE name LIKE 'target_episode%' ORDER BY cid")
      .all();
    expect(targetColumns).toEqual([
      { name: 'target_episode', type: 'INTEGER' },
      { name: 'target_episode_source', type: 'TEXT' },
    ]);
    expect(
      database.connection.prepare(`SELECT ${PROJECT_COLUMNS_BEFORE_TARGETS} FROM projects WHERE id = 'project'`).get(),
    ).toEqual(projectBefore);
    expect(
      database.connection
        .prepare('SELECT target_episode, target_episode_source FROM projects WHERE id = ?')
        .get('project'),
    ).toEqual({ target_episode: null, target_episode_source: null });
    relatedTables.forEach((table, index) => {
      expect(database!.connection.prepare(`SELECT * FROM ${table}`).all()).toEqual(relatedBefore[index]);
    });
    expect(database.connection.pragma('foreign_key_check')).toEqual([]);

    const migration = database.connection
      .prepare('SELECT * FROM schema_migrations WHERE version = 13')
      .get();
    expect(migration).toMatchObject({ version: 13 });
    expect(database.connection.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 13').get()).toEqual({
      count: 1,
    });
    const migratedSchema = (
      database.connection.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'projects'").get() as {
        sql: string;
      }
    ).sql;

    const updateTarget = database.connection.prepare(
      "UPDATE projects SET target_episode = ?, target_episode_source = ? WHERE id = 'project'",
    );
    expect(() => updateTarget.run(5, 'USER')).not.toThrow();
    expect(() => updateTarget.run(2000, 'AI')).not.toThrow();
    expect(() => updateTarget.run(4, 'USER')).toThrow();
    expect(() => updateTarget.run(2001, 'AI')).toThrow();
    expect(() => updateTarget.run(10.5, 'USER')).toThrow();
    expect(() => updateTarget.run(10, null)).toThrow();
    expect(() => updateTarget.run(null, 'USER')).toThrow();
    expect(() => updateTarget.run(10, 'SYSTEM')).toThrow();
    expect(() => updateTarget.run(null, null)).not.toThrow();

    database.onApplicationShutdown();
    database = new DatabaseService();

    expect(
      database.connection
        .prepare("SELECT name, type FROM pragma_table_info('projects') WHERE name LIKE 'target_episode%' ORDER BY cid")
        .all(),
    ).toEqual(targetColumns);
    expect(
      database.connection.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'projects'").get(),
    ).toEqual({ sql: migratedSchema });
    expect(database.connection.prepare('SELECT * FROM schema_migrations WHERE version = 13').get()).toEqual(migration);
    expect(database.connection.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 13').get()).toEqual({
      count: 1,
    });
    expect(
      database.connection.prepare(`SELECT ${PROJECT_COLUMNS_BEFORE_TARGETS} FROM projects WHERE id = 'project'`).get(),
    ).toEqual(projectBefore);
    expect(
      database.connection
        .prepare('SELECT target_episode, target_episode_source FROM projects WHERE id = ?')
        .get('project'),
    ).toEqual({ target_episode: null, target_episode_source: null });
    relatedTables.forEach((table, index) => {
      expect(database!.connection.prepare(`SELECT * FROM ${table}`).all()).toEqual(relatedBefore[index]);
    });
    expect(() =>
      database!.connection
        .prepare("UPDATE projects SET target_episode = 7, target_episode_source = NULL WHERE id = 'project'")
        .run(),
    ).toThrow();
    expect(database.connection.pragma('foreign_key_check')).toEqual([]);
  } finally {
    database?.onApplicationShutdown();
    if (legacy?.open) legacy.close();
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  }
});
