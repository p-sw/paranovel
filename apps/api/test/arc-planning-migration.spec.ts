import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { DatabaseService } from '../src/database/database.service';

afterEach(() => {
  vi.unstubAllEnvs();
});

it('migrates legacy reversals and backfills every arc episode without changing reversal storage', () => {
  const directory = mkdtempSync(join(tmpdir(), 'paranovel-arc-plan-migration-'));
  const dbPath = join(directory, 'legacy.sqlite');
  const legacyReversalJson = '[ { "episode": 4, "description": "  문은 안에서 잠겼다\\n달빛  ", "id": "legacy-beat" } ]';
  const invalidReversalJson = '[{"episode":99,"description":"범위 밖"},{"episode":9,"description":"   "},null]';
  let database: DatabaseService | undefined;
  let legacy: Database.Database | undefined;

  try {
    vi.stubEnv('DB_PATH', dbPath);
    vi.stubEnv('OPENROUTER_EMBEDDING_DIMENSIONS', '4');
    database = new DatabaseService();
    database.onApplicationShutdown();
    database = undefined;

    legacy = new Database(dbPath);
    legacy.pragma('foreign_keys = ON');
    legacy.exec(`
      ALTER TABLE arcs DROP COLUMN episode_directions_json;
      ALTER TABLE arcs DROP COLUMN milestone_plan_json;
      DELETE FROM schema_migrations WHERE version = 16;

      INSERT INTO projects (
        id, title, logline, genre_tags_json, details_json, default_target_chars,
        target_episode, target_episode_source, next_episode_number, revision,
        created_at, updated_at
      ) VALUES (
        'project', '경계의 기록', '문을 여는 이야기', '["판타지"]', '""', 5000,
        10, 'USER', 3, 1, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z'
      );
      INSERT INTO side_story_groups (
        id, project_id, title, description, next_episode_number, revision,
        created_at, updated_at
      ) VALUES (
        'side-group', 'project', '외전', '', 2, 1,
        '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z'
      );
    `);
    const insertArc = legacy.prepare(`
      INSERT INTO arcs (
        id, project_id, side_story_group_id, title, start_episode_number,
        end_episode_number, goal, conflict, twist_plan, reversal_plan_json,
        status, revision, created_at, updated_at
      ) VALUES (?, 'project', ?, ?, ?, ?, ?, ?, '', ?, ?, 1,
        '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')
    `);
    insertArc.run(
      'main-one',
      null,
      '문의 비밀',
      1,
      5,
      '문을 연다',
      '도시가 막는다',
      legacyReversalJson,
      'ACTIVE',
    );
    insertArc.run(
      'main-two',
      null,
      '도시의 중심',
      6,
      10,
      '도시를 되찾는다',
      '왕실이 막는다',
      invalidReversalJson,
      'PLANNED',
    );
    insertArc.run(
      'side-arc',
      'side-group',
      '외전의 문',
      1,
      5,
      '고향으로 돌아간다',
      '추적자가 막는다',
      '[{"episode":3,"description":"추적자가 형제였다"}]',
      'ACTIVE',
    );
    insertArc.run(
      'malformed-legacy',
      null,
      '깨진 옛 계획',
      1,
      5,
      '기록을 복구한다',
      '손상된 문서가 막는다',
      'not-json-at-all',
      'ARCHIVED',
    );
    legacy.exec(`
      INSERT INTO episodes (
        id, project_id, kind, number, side_story_group_id, title, direction,
        content, revision, status, created_at, updated_at
      ) VALUES (
        'main-episode', 'project', 'MAIN', 2, NULL, '실제 2화', '실제로 저장된 전개',
        '', 1, 'DRAFT', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z'
      );
      INSERT INTO episodes (
        id, project_id, kind, number, side_story_group_id, title, direction,
        content, revision, status, created_at, updated_at
      ) VALUES (
        'side-episode', 'project', 'SIDE_STORY', 1, 'side-group', '외전 실제 1화', '외전에 저장된 전개',
        '', 1, 'DRAFT', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z'
      );
    `);
    legacy.close();
    legacy = undefined;

    database = new DatabaseService();
    const columns = database.connection
      .prepare("SELECT name FROM pragma_table_info('arcs') WHERE name IN ('milestone_plan_json', 'episode_directions_json') ORDER BY name")
      .all();
    expect(columns).toEqual([
      { name: 'episode_directions_json' },
      { name: 'milestone_plan_json' },
    ]);
    expect(database.connection.prepare(
      "SELECT reversal_plan_json FROM arcs WHERE id = 'main-one'",
    ).get()).toEqual({ reversal_plan_json: legacyReversalJson });
    expect(database.connection.prepare(
      "SELECT reversal_plan_json FROM arcs WHERE id = 'main-two'",
    ).get()).toEqual({ reversal_plan_json: invalidReversalJson });
    const malformed = database.connection.prepare(
      "SELECT reversal_plan_json, milestone_plan_json, episode_directions_json FROM arcs WHERE id = 'malformed-legacy'",
    ).get() as {
      reversal_plan_json: string;
      milestone_plan_json: string;
      episode_directions_json: string;
    };
    expect(malformed.reversal_plan_json).toBe('not-json-at-all');
    expect(JSON.parse(malformed.milestone_plan_json)).toEqual([{
      episode: 5,
      type: 'GOAL',
      description: '기록을 복구한다',
    }]);
    expect((JSON.parse(malformed.episode_directions_json) as Array<{ episode: number }>)
      .map((item) => item.episode)).toEqual([1, 2, 3, 4, 5]);

    const mainOne = database.connection.prepare(
      "SELECT milestone_plan_json, episode_directions_json FROM arcs WHERE id = 'main-one'",
    ).get() as { milestone_plan_json: string; episode_directions_json: string };
    expect(JSON.parse(mainOne.milestone_plan_json)).toEqual([{
      id: 'legacy-beat',
      episode: 4,
      type: 'REVERSAL',
      description: '  문은 안에서 잠겼다\n달빛  ',
    }]);
    const mainDirections = JSON.parse(mainOne.episode_directions_json) as Array<{
      episode: number;
      title: string;
      direction: string;
    }>;
    expect(mainDirections.map((item) => item.episode)).toEqual([1, 2, 3, 4, 5]);
    expect(mainDirections[1]).toMatchObject({
      episode: 2,
      title: '실제 2화',
      direction: '실제로 저장된 전개',
    });
    expect(mainDirections[3]?.direction).toBe('  문은 안에서 잠겼다\n달빛  ');

    const mainTwo = database.connection.prepare(
      "SELECT milestone_plan_json, episode_directions_json FROM arcs WHERE id = 'main-two'",
    ).get() as { milestone_plan_json: string; episode_directions_json: string };
    expect(JSON.parse(mainTwo.milestone_plan_json)).toEqual([{
      episode: 10,
      type: 'GOAL',
      description: '도시를 되찾는다',
    }]);
    expect((JSON.parse(mainTwo.episode_directions_json) as Array<{ episode: number }>)
      .map((item) => item.episode)).toEqual([6, 7, 8, 9, 10]);

    const sideDirections = JSON.parse((database.connection.prepare(
      "SELECT episode_directions_json FROM arcs WHERE id = 'side-arc'",
    ).get() as { episode_directions_json: string }).episode_directions_json) as Array<{
      episode: number;
      direction: string;
    }>;
    expect(sideDirections.map((item) => item.episode)).toEqual([1, 2, 3, 4, 5]);
    expect(sideDirections[0]?.direction).toBe('외전에 저장된 전개');
    expect(sideDirections[0]?.direction).not.toBe('실제로 저장된 전개');
    expect(database.connection.prepare(
      'SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 16',
    ).get()).toEqual({ count: 1 });

    const rowsAfterMigration = database.connection.prepare(
      'SELECT id, reversal_plan_json, milestone_plan_json, episode_directions_json FROM arcs ORDER BY id',
    ).all();
    database.onApplicationShutdown();
    database = new DatabaseService();
    expect(database.connection.prepare(
      'SELECT id, reversal_plan_json, milestone_plan_json, episode_directions_json FROM arcs ORDER BY id',
    ).all()).toEqual(rowsAfterMigration);
    expect(database.connection.prepare(
      'SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 16',
    ).get()).toEqual({ count: 1 });
  } finally {
    database?.onApplicationShutdown();
    if (legacy?.open) legacy.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
