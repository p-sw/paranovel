import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { DatabaseService } from '../src/database/database.service';

it('migrates legacy conversations into one room per project while preserving message order, proposals, and foreign keys', () => {
  const directory = mkdtempSync(join(tmpdir(), 'paranovel-chat-migration-'));
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
      DROP INDEX idx_chat_messages_thread;
      ALTER TABLE chat_messages DROP COLUMN thread_id;
      DROP TABLE chat_threads;
      DELETE FROM schema_migrations WHERE version = 9;
      INSERT INTO schema_migrations VALUES (7, '2026-01-01T00:00:00.000Z'), (8, '2026-01-01T00:00:00.000Z');
      INSERT INTO projects (id, title, logline, created_at, updated_at) VALUES
        ('one', '첫 작품', '첫 이야기', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
        ('two', '둘째 작품', '다른 이야기', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
        ('empty', '빈 작품', '새 이야기', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      INSERT INTO chat_messages (id, project_id, client_message_id, role, content, status, created_at) VALUES
        ('z-user', 'one', 'first', 'user', '기존 설정을 정리해 줘', 'COMPLETE', '2026-01-01T00:00:00.000Z'),
        ('a-assistant', 'one', 'first', 'assistant', '기존 설정 제안', 'COMPLETE', '2026-01-01T00:00:00.000Z'),
        ('b-user', 'one', 'second', 'user', '이어서 설명해 줘', 'COMPLETE', '2026-01-02T00:00:00.000Z'),
        ('c-pending', 'one', 'second', 'assistant', '', 'PENDING', '2026-01-02T00:00:00.000Z'),
        ('other-user', 'two', 'first', 'user', '다른 작품의 대화', 'COMPLETE', '2026-01-03T00:00:00.000Z');
      INSERT INTO chat_proposals (id, project_id, message_id, kind, operation, title, before_json, after_json, status, created_at, applied_at) VALUES
        ('saved-proposal', 'one', 'a-assistant', 'CANON', 'CREATE', '저장된 변경안', 'null', '{"name":"하린"}', 'APPLIED', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z');
    `);
    const beforeMessages = legacy.prepare('SELECT rowid, * FROM chat_messages ORDER BY rowid').all();
    const beforeProposals = legacy.prepare('SELECT * FROM chat_proposals').all();
    legacy.close();

    database = new DatabaseService();
    const rooms = database.connection.prepare('SELECT * FROM chat_threads ORDER BY project_id').all();
    expect(rooms).toEqual([
      { id: 'legacy-one', project_id: 'one', title: '기존 설정을 정리해 줘', created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-02T00:00:00.000Z' },
      { id: 'legacy-two', project_id: 'two', title: '다른 작품의 대화', created_at: '2026-01-03T00:00:00.000Z', updated_at: '2026-01-03T00:00:00.000Z' },
    ]);
    const migrated = database.connection.prepare('SELECT rowid, * FROM chat_messages ORDER BY rowid').all() as Array<Record<string, unknown>>;
    expect(migrated.map(({ thread_id, ...message }) => message)).toEqual(beforeMessages);
    expect(migrated.map((message) => message.thread_id)).toEqual(['legacy-one', 'legacy-one', 'legacy-one', 'legacy-one', 'legacy-two']);
    expect(database.connection.prepare('SELECT * FROM chat_proposals').all()).toEqual(beforeProposals);
    expect(database.connection.pragma('foreign_key_check')).toEqual([]);
    database.onApplicationShutdown();

    database = new DatabaseService();
    expect(database.connection.prepare('SELECT * FROM chat_threads ORDER BY project_id').all()).toEqual(rooms);
    database.connection.prepare('DELETE FROM projects WHERE id = ?').run('one');
    expect(database.connection.prepare('SELECT project_id FROM chat_threads').all()).toEqual([{ project_id: 'two' }]);
    expect(database.connection.prepare('SELECT id FROM chat_messages').all()).toEqual([{ id: 'other-user' }]);
    expect(database.connection.prepare('SELECT * FROM chat_proposals').all()).toEqual([]);
    expect(database.connection.pragma('foreign_key_check')).toEqual([]);
  } finally {
    database?.onApplicationShutdown();
    if (legacy?.open) legacy.close();
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  }
});
