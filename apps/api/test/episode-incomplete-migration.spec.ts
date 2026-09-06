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
    legacy = new Database(dbPath);
    legacy.pragma('foreign_keys = ON');
    legacy.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      WITH RECURSIVE versions(version) AS (
        SELECT 1 UNION ALL SELECT version + 1 FROM versions WHERE version < 11
      ) INSERT INTO schema_migrations SELECT version, '2026-09-01' FROM versions;

      CREATE TABLE projects (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, logline TEXT NOT NULL,
        genre_tags_json TEXT NOT NULL DEFAULT '[]', details_json TEXT NOT NULL DEFAULT '{}',
        default_target_chars INTEGER NOT NULL DEFAULT 5000,
        next_episode_number INTEGER NOT NULL DEFAULT 1, revision INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
      );
      CREATE TABLE episodes (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        number INTEGER NOT NULL, title TEXT NOT NULL, direction TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '', revision INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'DRAFT'
          CHECK (status IN ('DRAFT','CONFIRMED','MEMORY_STALE','NEEDS_REVIEW')),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT,
        UNIQUE(project_id, number)
      );
      CREATE INDEX idx_episodes_project ON episodes(project_id, number);
      CREATE TABLE episode_idempotency (
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        idempotency_key TEXT NOT NULL,
        episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
        request_hash TEXT NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY(project_id, idempotency_key)
      );
      CREATE TABLE episode_summaries (
        episode_id TEXT PRIMARY KEY REFERENCES episodes(id) ON DELETE CASCADE,
        synopsis TEXT NOT NULL, events_json TEXT NOT NULL DEFAULT '[]',
        emotional_changes_json TEXT NOT NULL DEFAULT '[]',
        foreshadowing_introduced_json TEXT NOT NULL DEFAULT '[]',
        foreshadowing_resolved_json TEXT NOT NULL DEFAULT '[]',
        source_revision INTEGER NOT NULL, source_hash TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE scene_states (
        episode_id TEXT PRIMARY KEY REFERENCES episodes(id) ON DELETE CASCADE,
        location TEXT NOT NULL DEFAULT '', story_time TEXT NOT NULL DEFAULT '',
        point_of_view TEXT NOT NULL DEFAULT '', character_names_json TEXT NOT NULL DEFAULT '[]',
        goal TEXT NOT NULL DEFAULT '', source_revision INTEGER NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE canon_entries (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        category TEXT NOT NULL CHECK (category IN ('CHARACTER','CHARACTER_APPEARANCE','LOCATION','ORGANIZATION','ABILITY','RULE','TIMELINE','OTHER')),
        name TEXT NOT NULL, aliases_json TEXT NOT NULL DEFAULT '[]', content TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','PENDING','ACCEPTED','REJECTED')),
        revision INTEGER NOT NULL DEFAULT 1,
        source_episode_id TEXT REFERENCES episodes(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE arcs (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title TEXT NOT NULL, start_episode_number INTEGER NOT NULL, end_episode_number INTEGER NOT NULL,
        goal TEXT NOT NULL, conflict TEXT NOT NULL, twist_plan TEXT NOT NULL DEFAULT '',
        reversal_plan_json TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE memory_chunks (
        id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
        source_type TEXT NOT NULL, source_id TEXT NOT NULL, ordinal INTEGER NOT NULL,
        content TEXT NOT NULL, content_hash TEXT NOT NULL, embedding_model TEXT, embedding_json TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(source_type, source_id, ordinal)
      );
      CREATE TABLE ai_runs (
        id TEXT PRIMARY KEY, task TEXT NOT NULL,
        project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        episode_id TEXT REFERENCES episodes(id) ON DELETE SET NULL,
        model TEXT NOT NULL, prompt_refs_json TEXT NOT NULL DEFAULT '[]', context_hash TEXT NOT NULL,
        memory_revision_hash TEXT NOT NULL DEFAULT '', input_tokens INTEGER, output_tokens INTEGER,
        latency_ms INTEGER, status TEXT NOT NULL, error TEXT,
        created_at TEXT NOT NULL, completed_at TEXT
      );
      CREATE TABLE editor_ai_messages (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
        client_message_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL,
        status TEXT NOT NULL, request_json TEXT, edit_json TEXT, applied_at TEXT,
        error TEXT, run_id TEXT, created_at TEXT NOT NULL
      );

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
    const preservedQueries = [
      `SELECT id, project_id, number, title, direction, content, revision, status,
              created_at, updated_at, deleted_at FROM episodes ORDER BY number`,
      `SELECT project_id, idempotency_key, episode_id, request_hash, created_at
       FROM episode_idempotency`,
      'SELECT * FROM episode_summaries',
      'SELECT * FROM scene_states',
      `SELECT id, project_id, category, name, aliases_json, content, metadata_json,
              status, revision, source_episode_id, created_at, updated_at FROM canon_entries`,
      'SELECT * FROM ai_runs',
      'SELECT * FROM editor_ai_messages',
    ];
    const before = preservedQueries.map((query) => legacy!.prepare(query).all());
    legacy.close();

    database = new DatabaseService();
    preservedQueries.forEach((query, index) => {
      expect(database!.connection.prepare(query).all()).toEqual(before[index]);
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
