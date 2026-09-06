import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { DatabaseService } from '../src/database/database.service';
import { EpisodesService } from '../src/episodes/episodes.service';
import { ProjectsService } from '../src/projects/projects.service';

it('normalizes legacy counters once and preserves deliberately retained trailing and empty slots on restart', () => {
  const directory = mkdtempSync(join(tmpdir(), 'paranovel-episode-order-'));
  const dbPath = join(directory, 'legacy.sqlite');
  let database: DatabaseService | undefined;
  let legacy: Database.Database | undefined;
  try {
    vi.stubEnv('DB_PATH', dbPath);
    vi.stubEnv('OPENROUTER_EMBEDDING_DIMENSIONS', '4');
    database = new DatabaseService();
    database.onApplicationShutdown();
    legacy = new Database(dbPath);
    legacy.exec(`
      DELETE FROM schema_migrations WHERE version = 10;
      INSERT INTO projects (id, title, logline, next_episode_number, created_at, updated_at) VALUES
        ('gaps', '빈 회차', '중간 회차가 삭제된 작품', 9, '2026-01-01', '2026-01-01'),
        ('empty', '빈 작품', '회차를 모두 삭제한 작품', 7, '2026-01-01', '2026-01-01');
      INSERT INTO episodes (id, project_id, number, title, direction, content, created_at, updated_at) VALUES
        ('second', 'gaps', 2, '둘째', '방향', '원고', '2026-01-01', '2026-01-01'),
        ('fourth', 'gaps', 4, '넷째', '방향', '다른 원고', '2026-01-01', '2026-01-01');
    `);
    const rowsBefore = legacy.prepare('SELECT * FROM episodes ORDER BY number').all();
    legacy.close();

    database = new DatabaseService();
    let projects = new ProjectsService(database);
    let service = new EpisodesService(database, projects, { removeSource: vi.fn() } as never, {} as never);
    expect(projects.get('empty').nextEpisodeNumber).toBe(1);
    expect(service.order('empty').slots).toEqual([]);
    expect(projects.get('gaps').nextEpisodeNumber).toBe(5);
    expect(service.order('gaps').slots).toEqual([null, 'second', null, 'fourth']);
    expect(database.connection.prepare('SELECT * FROM episodes ORDER BY number').all()).toEqual(rowsBefore);
    const saved = service.updateOrder('gaps', { slots: ['second', 'fourth', null, null], expectedRevision: service.order('gaps').revision });
    database.onApplicationShutdown();

    database = new DatabaseService();
    projects = new ProjectsService(database);
    service = new EpisodesService(database, projects, { removeSource: vi.fn() } as never, {} as never);
    expect(service.order('gaps')).toEqual(saved);
    expect(projects.get('gaps').nextEpisodeNumber).toBe(5);
    service.remove('gaps', 'second', { expectedRevision: service.get('gaps', 'second').revision });
    service.remove('gaps', 'fourth', { expectedRevision: service.get('gaps', 'fourth').revision });
    const emptySlots = service.order('gaps');
    expect(emptySlots).toMatchObject({ episodes: [], slots: [null, null, null, null] });
    database.onApplicationShutdown();

    database = new DatabaseService();
    service = new EpisodesService(database, new ProjectsService(database), {} as never, {} as never);
    expect(service.order('gaps')).toEqual(emptySlots);
    expect(database.connection.pragma('foreign_key_check')).toEqual([]);
  } finally {
    database?.onApplicationShutdown();
    if (legacy?.open) legacy.close();
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  }
});
