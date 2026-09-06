import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { schema } from './schema';

const INITIAL_SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  logline TEXT NOT NULL,
  genre_tags_json TEXT NOT NULL DEFAULT '[]',
  details_json TEXT NOT NULL DEFAULT '{}',
  default_target_chars INTEGER NOT NULL DEFAULT 5000,
  next_episode_number INTEGER NOT NULL DEFAULT 1,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE project_creation_sessions (
  id TEXT PRIMARY KEY,
  logline TEXT NOT NULL,
  genre_tags_json TEXT NOT NULL,
  answers_json TEXT NOT NULL DEFAULT '{}',
  transcript_json TEXT NOT NULL DEFAULT '[]',
  pending_question_json TEXT,
  blueprint_json TEXT,
  title_asked INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'READY', 'COMMITTED')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE episodes (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  direction TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('INCOMPLETE','DRAFT','CONFIRMED','MEMORY_STALE','NEEDS_REVIEW')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  UNIQUE(project_id, number)
);
CREATE INDEX idx_episodes_project ON episodes(project_id, number);

CREATE TABLE episode_idempotency (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  request_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(project_id, idempotency_key)
);

CREATE TABLE episode_summaries (
  episode_id TEXT PRIMARY KEY REFERENCES episodes(id) ON DELETE CASCADE,
  synopsis TEXT NOT NULL,
  events_json TEXT NOT NULL DEFAULT '[]',
  emotional_changes_json TEXT NOT NULL DEFAULT '[]',
  foreshadowing_introduced_json TEXT NOT NULL DEFAULT '[]',
  foreshadowing_resolved_json TEXT NOT NULL DEFAULT '[]',
  source_revision INTEGER NOT NULL,
  source_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE scene_states (
  episode_id TEXT PRIMARY KEY REFERENCES episodes(id) ON DELETE CASCADE,
  location TEXT NOT NULL DEFAULT '',
  story_time TEXT NOT NULL DEFAULT '',
  point_of_view TEXT NOT NULL DEFAULT '',
  character_names_json TEXT NOT NULL DEFAULT '[]',
  goal TEXT NOT NULL DEFAULT '',
  source_revision INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE arcs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  start_episode_number INTEGER NOT NULL,
  end_episode_number INTEGER NOT NULL,
  goal TEXT NOT NULL,
  conflict TEXT NOT NULL,
  twist_plan TEXT NOT NULL,
  reversal_plan_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL CHECK (status IN ('PLANNED', 'ACTIVE', 'COMPLETE', 'ARCHIVED')),
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_arcs_project_status ON arcs(project_id, status);

CREATE TABLE canon_entries (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  category TEXT NOT NULL CHECK (category IN ('CHARACTER','LOCATION','ORGANIZATION','ABILITY','RULE','TIMELINE','OTHER')),
  name TEXT NOT NULL,
  aliases_json TEXT NOT NULL DEFAULT '[]',
  content TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','PENDING','ACCEPTED','REJECTED')),
  revision INTEGER NOT NULL DEFAULT 1,
  source_episode_id TEXT REFERENCES episodes(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_canon_project_category ON canon_entries(project_id, category, status);

CREATE TABLE improvements (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('GLOBAL','PROJECT')),
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  rule TEXT NOT NULL,
  rationale TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'STYLE',
  tags_json TEXT NOT NULL DEFAULT '[]',
  before_example TEXT,
  after_example TEXT,
  source TEXT NOT NULL CHECK (source IN ('MANUAL','EDITOR','COMPARISON')),
  confidence REAL NOT NULL DEFAULT 0.5,
  duplicate_of_id TEXT,
  conflicts_with_ids_json TEXT NOT NULL DEFAULT '[]',
  active INTEGER NOT NULL DEFAULT 1,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((scope = 'GLOBAL' AND project_id IS NULL) OR (scope = 'PROJECT' AND project_id IS NOT NULL))
);
CREATE INDEX idx_improvements_scope_project ON improvements(scope, project_id);

CREATE TABLE memory_chunks (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  embedding_model TEXT,
  embedding_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(source_type, source_id, ordinal)
);
CREATE INDEX idx_memory_project_source ON memory_chunks(project_id, source_type, source_id);

CREATE VIRTUAL TABLE memory_chunks_fts USING fts5(
  chunk_id UNINDEXED,
  project_id UNINDEXED,
  content,
  tokenize='trigram'
);

CREATE TABLE ai_runs (
  id TEXT PRIMARY KEY,
  task TEXT NOT NULL,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  episode_id TEXT REFERENCES episodes(id) ON DELETE SET NULL,
  model TEXT NOT NULL,
  prompt_refs_json TEXT NOT NULL DEFAULT '[]',
  context_hash TEXT NOT NULL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  status TEXT NOT NULL CHECK (status IN ('RUNNING','SUCCEEDED','FAILED','CANCELLED')),
  error TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX idx_ai_runs_project_created ON ai_runs(project_id, created_at);
`;

const SESSION_PROJECT_MIGRATION = `
ALTER TABLE project_creation_sessions
ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE SET NULL;
CREATE INDEX idx_project_creation_sessions_project ON project_creation_sessions(project_id);
`;

const IMPROVEMENT_BATCH_MIGRATION = `
CREATE TABLE improvement_batch_idempotency (
  idempotency_key TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

const AI_RUN_OBSERVABILITY_MIGRATION = `
ALTER TABLE ai_runs ADD COLUMN latency_ms INTEGER;
ALTER TABLE ai_runs ADD COLUMN memory_revision_hash TEXT NOT NULL DEFAULT '';
`;

const PROJECT_CHAT_MIGRATION = `
CREATE TABLE chat_messages (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  client_message_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING','COMPLETE','FAILED')),
  error TEXT,
  run_id TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(project_id, client_message_id, role)
);
CREATE INDEX idx_chat_messages_project_created ON chat_messages(project_id, created_at);
CREATE TABLE chat_proposals (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('PROJECT','CANON','ARC','IMPROVEMENT')),
  operation TEXT NOT NULL CHECK (operation IN ('CREATE','UPDATE','DELETE')),
  title TEXT NOT NULL,
  target_id TEXT,
  before_json TEXT NOT NULL,
  after_json TEXT NOT NULL,
  effects_json TEXT NOT NULL DEFAULT '[]',
  active_arcs_json TEXT,
  status TEXT NOT NULL CHECK (status IN ('PENDING','APPLIED')),
  result_json TEXT,
  index_targets_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  applied_at TEXT
);
CREATE INDEX idx_chat_proposals_message ON chat_proposals(message_id);
`;

const CHARACTER_APPEARANCE_MIGRATION = `
CREATE TABLE canon_entries_with_appearance (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  category TEXT NOT NULL CHECK (category IN ('CHARACTER','CHARACTER_APPEARANCE','LOCATION','ORGANIZATION','ABILITY','RULE','TIMELINE','OTHER')),
  name TEXT NOT NULL,
  aliases_json TEXT NOT NULL DEFAULT '[]',
  content TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','PENDING','ACCEPTED','REJECTED')),
  revision INTEGER NOT NULL DEFAULT 1,
  source_episode_id TEXT REFERENCES episodes(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO canon_entries_with_appearance (
  id, project_id, category, name, aliases_json, content, metadata_json,
  status, revision, source_episode_id, created_at, updated_at
)
SELECT id, project_id, category, name, aliases_json, content, metadata_json,
       status, revision, source_episode_id, created_at, updated_at
FROM canon_entries;
DROP TABLE canon_entries;
ALTER TABLE canon_entries_with_appearance RENAME TO canon_entries;
CREATE INDEX idx_canon_project_category ON canon_entries(project_id, category, status);
`;

const CHAT_THREADS_MIGRATION = `
CREATE TABLE chat_threads (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_chat_threads_project_updated ON chat_threads(project_id, updated_at);
ALTER TABLE chat_messages ADD COLUMN thread_id TEXT REFERENCES chat_threads(id) ON DELETE CASCADE;
INSERT INTO chat_threads (id, project_id, title, created_at, updated_at)
SELECT 'legacy-' || project_id, project_id,
  COALESCE((SELECT substr(content, 1, 80) FROM chat_messages first_message
    WHERE first_message.project_id = messages.project_id AND role = 'user' ORDER BY rowid LIMIT 1), '이전 대화'),
  MIN(created_at), MAX(created_at)
FROM chat_messages messages GROUP BY project_id;
UPDATE chat_messages SET thread_id = 'legacy-' || project_id;
CREATE INDEX idx_chat_messages_thread ON chat_messages(thread_id);
`;

// Historical counters included deleted trailing episodes. From this migration
// onward the counter also preserves deliberately retained placeholder slots.
const EPISODE_SLOT_COUNTER_MIGRATION = `
UPDATE projects SET next_episode_number = COALESCE((
  SELECT MAX(number) FROM episodes
  WHERE episodes.project_id = projects.id AND episodes.deleted_at IS NULL
), 0) + 1;
`;

const EDITOR_AI_MIGRATION = `
CREATE TABLE editor_ai_messages (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  client_message_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING','COMPLETE','FAILED')),
  request_json TEXT,
  edit_json TEXT,
  applied_at TEXT,
  error TEXT,
  run_id TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(episode_id, client_message_id, role)
);
CREATE INDEX idx_editor_ai_episode ON editor_ai_messages(episode_id);
CREATE UNIQUE INDEX idx_editor_ai_pending ON editor_ai_messages(episode_id) WHERE status = 'PENDING';
`;

const INCOMPLETE_EPISODE_MIGRATION = `
CREATE TABLE episodes_with_incomplete (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  direction TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('INCOMPLETE','DRAFT','CONFIRMED','MEMORY_STALE','NEEDS_REVIEW')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  UNIQUE(project_id, number)
);
INSERT INTO episodes_with_incomplete SELECT * FROM episodes;
DROP TABLE episodes;
ALTER TABLE episodes_with_incomplete RENAME TO episodes;
CREATE INDEX idx_episodes_project ON episodes(project_id, number);
`;

const PROJECT_TARGET_EPISODE_MIGRATION = `
ALTER TABLE projects ADD COLUMN target_episode INTEGER
  CHECK (target_episode IS NULL OR (typeof(target_episode) = 'integer' AND target_episode BETWEEN 5 AND 2000));
ALTER TABLE projects ADD COLUMN target_episode_source TEXT
  CHECK (
    (target_episode IS NULL AND target_episode_source IS NULL)
    OR (
      target_episode IS NOT NULL
      AND target_episode_source IS NOT NULL
      AND target_episode_source IN ('USER','AI')
    )
  );
`;

const SIDE_STORIES_MIGRATION = `
CREATE TABLE side_story_groups (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  branch_from_episode_id TEXT REFERENCES episodes(id) ON DELETE SET NULL,
  next_episode_number INTEGER NOT NULL DEFAULT 1,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_side_story_groups_project
  ON side_story_groups(project_id, created_at);

CREATE TABLE side_story_group_idempotency (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  group_id TEXT NOT NULL REFERENCES side_story_groups(id) ON DELETE CASCADE,
  request_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(project_id, idempotency_key)
);

CREATE TABLE episodes_with_side_stories (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'MAIN' CHECK (kind IN ('MAIN','SIDE_STORY')),
  number INTEGER,
  side_story_group_id TEXT REFERENCES side_story_groups(id) ON DELETE CASCADE,
  branch_from_episode_id TEXT REFERENCES episodes_with_side_stories(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  direction TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('INCOMPLETE','DRAFT','CONFIRMED','MEMORY_STALE','NEEDS_REVIEW')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  CHECK (
    (kind = 'MAIN' AND number IS NOT NULL AND side_story_group_id IS NULL AND branch_from_episode_id IS NULL)
    OR
    (kind = 'SIDE_STORY' AND side_story_group_id IS NULL AND number IS NULL)
    OR
    (kind = 'SIDE_STORY' AND side_story_group_id IS NOT NULL AND number IS NOT NULL AND branch_from_episode_id IS NULL)
  )
);
INSERT INTO episodes_with_side_stories (
  id, project_id, kind, number, side_story_group_id, branch_from_episode_id,
  title, direction, content, revision, status, created_at, updated_at, deleted_at
)
SELECT id, project_id, 'MAIN', number, NULL, NULL,
       title, direction, content, revision, status, created_at, updated_at, deleted_at
FROM episodes;
DROP TABLE episodes;
ALTER TABLE episodes_with_side_stories RENAME TO episodes;
CREATE UNIQUE INDEX episodes_main_project_number
  ON episodes(project_id, number) WHERE kind = 'MAIN';
CREATE UNIQUE INDEX episodes_side_story_group_number
  ON episodes(side_story_group_id, number)
  WHERE kind = 'SIDE_STORY' AND side_story_group_id IS NOT NULL;
CREATE INDEX idx_episodes_project_kind ON episodes(project_id, kind, number);
CREATE INDEX idx_episodes_side_story_group ON episodes(side_story_group_id, number);

CREATE TABLE episode_idempotency_scoped (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  scope TEXT NOT NULL DEFAULT 'MAIN' CHECK (scope IN ('MAIN','SIDE_STORY')),
  idempotency_key TEXT NOT NULL,
  episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  request_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(project_id, scope, idempotency_key)
);
INSERT INTO episode_idempotency_scoped (
  project_id, scope, idempotency_key, episode_id, request_hash, created_at
)
SELECT project_id, 'MAIN', idempotency_key, episode_id, request_hash, created_at
FROM episode_idempotency;
DROP TABLE episode_idempotency;
ALTER TABLE episode_idempotency_scoped RENAME TO episode_idempotency;

ALTER TABLE canon_entries
  ADD COLUMN side_story_group_id TEXT REFERENCES side_story_groups(id) ON DELETE CASCADE;
CREATE INDEX idx_canon_side_story_group
  ON canon_entries(side_story_group_id, category, status);

ALTER TABLE arcs
  ADD COLUMN side_story_group_id TEXT REFERENCES side_story_groups(id) ON DELETE CASCADE;
CREATE INDEX idx_arcs_side_story_group
  ON arcs(side_story_group_id, status, start_episode_number);

ALTER TABLE memory_chunks
  ADD COLUMN flow_key TEXT NOT NULL DEFAULT 'SHARED';
ALTER TABLE memory_chunks
  ADD COLUMN flow_position INTEGER;
UPDATE memory_chunks
SET flow_key = CASE
      WHEN source_type IN ('EPISODE', 'EPISODE_SUMMARY', 'ARC') THEN 'MAIN'
      ELSE 'SHARED'
    END,
    flow_position = CASE
      WHEN source_type IN ('EPISODE', 'EPISODE_SUMMARY')
        THEN (SELECT number FROM episodes WHERE episodes.id = memory_chunks.source_id)
      ELSE NULL
    END;
CREATE INDEX idx_memory_project_flow
  ON memory_chunks(project_id, flow_key, flow_position, source_type);
`;

@Injectable()
export class DatabaseService implements OnApplicationShutdown {
  readonly connection: Database.Database;
  readonly orm: BetterSQLite3Database<typeof schema>;
  readonly vectorAvailable: boolean;
  readonly embeddingDimensions: number;

  constructor() {
    const configured = process.env.DB_PATH ?? './data/paranovel.sqlite';
    const dbPath = configured === ':memory:' ? configured : resolve(configured);
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    this.connection = new Database(dbPath);
    this.orm = drizzle(this.connection, { schema });
    this.connection.pragma('journal_mode = WAL');
    this.connection.pragma('foreign_keys = ON');
    this.connection.pragma('busy_timeout = 5000');
    this.embeddingDimensions = Number.parseInt(
      process.env.OPENROUTER_EMBEDDING_DIMENSIONS ?? '1536',
      10,
    );
    this.migrate();
    this.vectorAvailable = this.initializeVectorIndex();
  }

  private migrate(): void {
    const migrations = [
      { version: 1, sql: INITIAL_SCHEMA },
      { version: 2, sql: SESSION_PROJECT_MIGRATION },
      { version: 3, sql: IMPROVEMENT_BATCH_MIGRATION },
      { version: 4, sql: AI_RUN_OBSERVABILITY_MIGRATION },
      { version: 5, sql: PROJECT_CHAT_MIGRATION },
      { version: 6, sql: CHARACTER_APPEARANCE_MIGRATION },
      // Versions 7 and 8 remain reserved in existing database histories.
      // The retired feature's stored tables and data are left untouched.
      { version: 9, sql: CHAT_THREADS_MIGRATION },
      { version: 10, sql: EPISODE_SLOT_COUNTER_MIGRATION },
      { version: 11, sql: EDITOR_AI_MIGRATION },
      { version: 12, sql: INCOMPLETE_EPISODE_MIGRATION, rebuildsReferencedTable: true },
      { version: 13, sql: PROJECT_TARGET_EPISODE_MIGRATION },
      { version: 14, sql: SIDE_STORIES_MIGRATION, rebuildsReferencedTable: true },
    ];
    this.connection.exec(
      'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)',
    );
    const applied = new Set(
      this.connection
        .prepare('SELECT version FROM schema_migrations')
        .all()
        .map((row) => Number((row as { version: number }).version)),
    );
    for (const migration of migrations) {
      if (applied.has(migration.version)) continue;
      // Rebuilding episodes must preserve its dependent summaries, scenes and
      // application receipts instead of firing their ON DELETE actions.
      if (migration.rebuildsReferencedTable) this.connection.pragma('foreign_keys = OFF');
      try {
        this.connection.transaction(() => {
          this.connection.exec(migration.sql);
          if (migration.rebuildsReferencedTable && this.connection.prepare('PRAGMA foreign_key_check').all().length > 0) {
            throw new Error('Episode migration would leave invalid foreign keys');
          }
          this.connection
            .prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)')
            .run(migration.version, new Date().toISOString());
        })();
      } finally {
        if (migration.rebuildsReferencedTable) this.connection.pragma('foreign_keys = ON');
      }
    }
  }

  private initializeVectorIndex(): boolean {
    if (!Number.isInteger(this.embeddingDimensions) || this.embeddingDimensions <= 0) {
      return false;
    }
    try {
      sqliteVec.load(this.connection);
      const existingColumns = this.connection
        .prepare("SELECT name FROM pragma_table_info('memory_chunks_vec')")
        .all() as Array<{ name: string }>;
      const legacySchema =
        existingColumns.length > 0 &&
        (!existingColumns.some((column) => column.name === 'project_key') ||
          !existingColumns.some((column) => column.name === 'flow_key') ||
          !existingColumns.some((column) => column.name === 'flow_position'));
      const needsBackfill = existingColumns.length === 0 || legacySchema;
      if (legacySchema) {
        this.connection.exec('DROP TABLE memory_chunks_vec');
      }
      this.connection.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS memory_chunks_vec USING vec0(
          chunk_id TEXT PRIMARY KEY,
          project_key TEXT PARTITION KEY,
          flow_key TEXT,
          flow_position INTEGER,
          embedding FLOAT[${this.embeddingDimensions}] distance_metric=cosine
        );
      `);
      const stored = needsBackfill
        ? this.connection
        .prepare(
          `SELECT m.id, m.project_id, m.source_type, m.source_id, m.embedding_json,
                  m.flow_key, m.flow_position
           FROM memory_chunks m
           WHERE m.embedding_json IS NOT NULL`,
        )
        .all() as Array<{
        id: string;
        project_id: string | null;
        source_type: string;
        source_id: string;
        embedding_json: string;
        flow_key: string;
        flow_position: number | null;
      }>
        : [];
      const insert = this.connection.prepare(
          `INSERT OR REPLACE INTO memory_chunks_vec(
           chunk_id, project_key, flow_key, flow_position, embedding
         ) VALUES (?, ?, ?, ?, ?)`,
      );
      for (const row of stored) {
        try {
          const vector = JSON.parse(row.embedding_json) as number[];
          if (vector.length !== this.embeddingDimensions) continue;
          insert.run(
            row.id,
            row.project_id ?? '__GLOBAL__',
            row.flow_key,
            BigInt(row.flow_position ?? 0),
            Buffer.from(new Float32Array(vector).buffer),
          );
        } catch {
          // A malformed or dimension-stale stored embedding remains available
          // to keyword search and can be repaired through the reindex endpoint.
        }
      }
      return true;
    } catch {
      // Keyword retrieval remains available when the optional native extension
      // cannot load on a particular platform.
      return false;
    }
  }

  onApplicationShutdown(): void {
    if (this.connection.open) this.connection.close();
  }
}
