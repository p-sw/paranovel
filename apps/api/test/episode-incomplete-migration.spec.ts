import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { DatabaseService } from '../src/database/database.service';
import { EpisodesService } from '../src/episodes/episodes.service';
import { ProjectsService } from '../src/projects/projects.service';

it('upgrades the old episode status constraint without losing dependent records and preserves incomplete plans on restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'paranovel-incomplete-'));
  const dbPath = join(directory, 'legacy.sqlite');
  let database: DatabaseService | undefined;
  let legacy: Database.Database | undefined;
  try {
    vi.stubEnv('DB_PATH', dbPath);
    vi.stubEnv('OPENROUTER_EMBEDDING_DIMENSIONS', '4');
    database = new DatabaseService();
    database.onApplicationShutdown();
    legacy = new Database(dbPath);
    const schema = (legacy.prepare("SELECT sql FROM sqlite_master WHERE name = 'episodes'").get() as { sql: string }).sql;
    legacy.exec(`
      ${schema.replace('CREATE TABLE "episodes"', 'CREATE TABLE legacy_episodes').replace('CREATE TABLE episodes', 'CREATE TABLE legacy_episodes').replace("'INCOMPLETE',", '')};
      DROP TABLE episodes;
      ALTER TABLE legacy_episodes RENAME TO episodes;
      CREATE INDEX idx_episodes_project ON episodes(project_id, number);
      DELETE FROM schema_migrations WHERE version = 12;
      INSERT INTO projects (id, title, logline, next_episode_number, created_at, updated_at)
        VALUES ('project', '문', '문을 여는 이야기', 5, '2026-09-01', '2026-09-01');
      INSERT INTO episodes (id, project_id, number, title, direction, content, status, created_at, updated_at) VALUES
        ('first', 'project', 1, '첫 회차', '첫 방향', '첫 원고', 'CONFIRMED', '2026-09-01', '2026-09-01'),
        ('draft', 'project', 3, '수동 초안', '', '', 'DRAFT', '2026-09-01', '2026-09-01');
      INSERT INTO episode_idempotency (project_id, idempotency_key, episode_id, request_hash, created_at)
        VALUES ('project', 'first-request', 'first', 'hash', '2026-09-01');
      INSERT INTO episode_summaries (episode_id, synopsis, source_revision, source_hash, updated_at)
        VALUES ('first', '문에 도착했다.', 1, 'hash', '2026-09-01');
      INSERT INTO scene_states (episode_id, location, source_revision, updated_at)
        VALUES ('first', '문 앞', 1, '2026-09-01');
      INSERT INTO canon_entries (id, project_id, category, name, content, source_episode_id, created_at, updated_at)
        VALUES ('canon', 'project', 'LOCATION', '문', '닫힌 문', 'first', '2026-09-01', '2026-09-01');
      INSERT INTO ai_runs (id, task, project_id, episode_id, model, context_hash, status, created_at)
        VALUES ('run', 'episode_draft', 'project', 'first', 'test', 'hash', 'SUCCEEDED', '2026-09-01');
      INSERT INTO editor_ai_messages (id, project_id, episode_id, client_message_id, role, content, status, created_at)
        VALUES ('message', 'project', 'first', 'client-request', 'assistant', '수정 제안', 'COMPLETE', '2026-09-01');
    `);
    expect(() => legacy!.prepare("UPDATE episodes SET status = 'INCOMPLETE' WHERE id = 'draft'").run()).toThrow();
    const preservedTables = ['episodes', 'episode_idempotency', 'episode_summaries', 'scene_states', 'canon_entries', 'ai_runs', 'editor_ai_messages'];
    const before = preservedTables.map((table) => legacy!.prepare(`SELECT * FROM ${table}`).all());
    legacy.close();

    database = new DatabaseService();
    preservedTables.forEach((table, index) => {
      expect(database!.connection.prepare(`SELECT * FROM ${table}`).all()).toEqual(before[index]);
    });
    expect(database.connection.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(database.connection.pragma('foreign_key_check')).toEqual([]);
    const projects = new ProjectsService(database);
    let service = new EpisodesService(database, projects, { removeSource: vi.fn() } as never, {} as never);
    expect(service.order('project').slots).toEqual(['first', null, 'draft', null]);
    const reserved = await service.create('project', { title: 'AI 제목', direction: 'AI 전개 방향', incomplete: true });
    expect(reserved).toMatchObject({ number: 5, status: 'INCOMPLETE', content: '' });
    database.onApplicationShutdown();

    database = new DatabaseService();
    service = new EpisodesService(database, new ProjectsService(database), { removeSource: vi.fn() } as never, {} as never);
    expect(service.get('project', reserved.id)).toEqual(reserved);
    expect(service.get('project', 'draft').status).toBe('DRAFT');
    expect(database.connection.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 12').get()).toEqual({ count: 1 });
    expect(() => database!.connection.prepare("UPDATE episodes SET status = 'INVALID' WHERE id = ?").run(reserved.id)).toThrow();
    expect(() => database!.connection.prepare("UPDATE episodes SET number = 1 WHERE id = ?").run(reserved.id)).toThrow();
    service.remove('project', 'first', { expectedRevision: 1 });
    expect(database.connection.prepare('SELECT * FROM episode_summaries').all()).toEqual([]);
    expect(database.connection.prepare('SELECT * FROM editor_ai_messages').all()).toEqual([]);
    expect(database.connection.prepare("SELECT source_episode_id FROM canon_entries WHERE id = 'canon'").get()).toEqual({ source_episode_id: null });
    expect(database.connection.pragma('foreign_key_check')).toEqual([]);
  } finally {
    database?.onApplicationShutdown();
    if (legacy?.open) legacy.close();
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  }
});
