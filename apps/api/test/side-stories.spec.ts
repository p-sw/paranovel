import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSideStoryGroupSchema, sideStoryGroupSchema } from '@paranovel/contracts';
import { DatabaseService } from '../src/database/database.service';
import { EpisodesService } from '../src/episodes/episodes.service';
import { MemoryService } from '../src/memory/memory.service';
import { ProjectsService } from '../src/projects/projects.service';
import { SideStoriesController } from '../src/side-stories/side-stories.controller';
import { SideStoriesService } from '../src/side-stories/side-stories.service';

describe('side-story API', () => {
  let database: DatabaseService;
  let projects: ProjectsService;
  let episodes: EpisodesService;
  let memory: MemoryService;
  let sideStories: SideStoriesService;
  let app: INestApplication;
  let projectId: string;

  beforeEach(async () => {
    vi.stubEnv('DB_PATH', ':memory:');
    vi.stubEnv('OPENROUTER_EMBEDDING_DIMENSIONS', '4');
    database = new DatabaseService();
    projects = new ProjectsService(database);
    memory = new MemoryService(database, {
      embeddings: vi.fn(async (texts: string[]) => texts.map(() => [1, 0.5, 0.25, 0.125])),
    } as never);
    episodes = new EpisodesService(database, projects, memory, {} as never);
    sideStories = new SideStoriesService(database, memory);
    projectId = projects.createInternal({
      title: '기록관',
      logline: '갈라진 시간선의 기록을 모은다.',
      genreTags: ['판타지'],
    }).id;
    Reflect.defineMetadata('design:paramtypes', [SideStoriesService], SideStoriesController);
    const module = await Test.createTestingModule({
      controllers: [SideStoriesController],
      providers: [{ provide: SideStoriesService, useValue: sideStories }],
    }).compile();
    app = module.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
    database.onApplicationShutdown();
    vi.unstubAllEnvs();
  });

  const groupBody = (branchFromEpisodeId: string | null, title = '겨울 궁전') => ({
    title,
    description: '본편과 독립된 겨울의 사건',
    branchFromEpisodeId,
    canon: '겨울 궁전 안에서는 시간이 절반의 속도로 흐른다.',
    arc: {
      title: `${title}의 봉인`,
      goal: '궁전의 봉인을 푼다.',
      conflict: '시간을 지키는 파수꾼이 막아선다.',
      endEpisodeNumber: 3,
      reversalPlan: [{ episode: 2, description: '파수꾼이 과거의 동료였음이 드러난다.' }],
    },
  });

  it('keeps main, standalone and each group numbering isolated and creates group canon plus arc', async () => {
    const mainOne = await episodes.create(projectId, {
      title: '첫 회차', direction: '기록관이 문을 연다.', content: '문이 열렸다.',
    }, 'standalone-request');
    const groupA = (await request(app.getHttpServer())
      .post(`/projects/${projectId}/side-story-groups`)
      .set('Idempotency-Key', 'group-a-request')
      .send(groupBody(mainOne.id))
      .expect(201)).body;
    const groupAReplay = (await request(app.getHttpServer())
      .post(`/projects/${projectId}/side-story-groups`)
      .set('Idempotency-Key', 'group-a-request')
      .send({
        arc: groupBody(mainOne.id).arc,
        canon: groupBody(mainOne.id).canon,
        branchFromEpisodeId: mainOne.id,
        description: groupBody(mainOne.id).description,
        title: groupBody(mainOne.id).title,
      })
      .expect(201)).body;
    const groupB = (await request(app.getHttpServer())
      .post(`/projects/${projectId}/side-story-groups`)
      .send(groupBody(null, '유리 정원'))
      .expect(201)).body;

    expect(groupA).toMatchObject({
      title: '겨울 궁전',
      branchFromEpisodeId: mainOne.id,
      nextEpisodeNumber: 1,
      revision: 1,
      canon: [{
        category: 'OTHER',
        status: 'ACTIVE',
        content: '겨울 궁전 안에서는 시간이 절반의 속도로 흐른다.',
      }],
      arc: {
        title: '겨울 궁전의 봉인',
        startEpisodeNumber: 1,
        endEpisodeNumber: 3,
        status: 'ACTIVE',
        milestones: [{
          episode: 2,
          type: 'REVERSAL',
          description: '파수꾼이 과거의 동료였음이 드러난다.',
        }],
        episodeDirections: [
          { episode: 1, title: '겨울 궁전의 봉인 1화', direction: '궁전의 봉인을 푼다.' },
          {
            episode: 2,
            title: '겨울 궁전의 봉인 2화',
            direction: '파수꾼이 과거의 동료였음이 드러난다.',
          },
          { episode: 3, title: '겨울 궁전의 봉인 3화', direction: '궁전의 봉인을 푼다.' },
        ],
      },
    });
    expect(groupAReplay.id).toBe(groupA.id);
    expect(groupA.canon[0].sideStoryGroupId).toBe(groupA.id);
    expect(groupA.arc.sideStoryGroupId).toBe(groupA.id);

    const standalone = (await request(app.getHttpServer())
      .post(`/projects/${projectId}/side-stories`)
      .set('Idempotency-Key', 'standalone-request')
      .send({
        branchFromEpisodeId: mainOne.id, groupId: null,
        forceNeedsReview: false, incomplete: false, content: '',
        direction: '첫 회차 직후의 하루를 다룬다.', title: '문 너머의 하루',
      })
      .expect(201)).body;
    const replay = (await request(app.getHttpServer())
      .post(`/projects/${projectId}/side-stories`)
      .set('Idempotency-Key', 'standalone-request')
      .send({
        title: '문 너머의 하루', direction: '첫 회차 직후의 하루를 다룬다.',
        groupId: null, branchFromEpisodeId: mainOne.id,
      })
      .expect(201)).body;
    const groupAOne = (await request(app.getHttpServer())
      .post(`/projects/${projectId}/side-stories`)
      .send({ title: '얼어붙은 문', groupId: groupA.id, branchFromEpisodeId: null })
      .expect(201)).body;
    const groupATwo = (await request(app.getHttpServer())
      .post(`/projects/${projectId}/side-stories`)
      .send({ title: '파수꾼', groupId: groupA.id, branchFromEpisodeId: null })
      .expect(201)).body;
    const groupBOne = (await request(app.getHttpServer())
      .post(`/projects/${projectId}/side-stories`)
      .send({ title: '유리 씨앗', groupId: groupB.id, branchFromEpisodeId: null })
      .expect(201)).body;

    expect(replay.id).toBe(standalone.id);
    expect(standalone).toMatchObject({
      kind: 'SIDE_STORY', number: null, sideStoryGroupId: null,
      branchFromEpisodeId: mainOne.id,
    });
    expect(groupAOne).toMatchObject({
      kind: 'SIDE_STORY', number: 1, sideStoryGroupId: groupA.id,
      branchFromEpisodeId: null,
    });
    expect(groupATwo.number).toBe(2);
    expect(groupBOne.number).toBe(1);
    expect(projects.get(projectId)).toMatchObject({ nextEpisodeNumber: 2, episodeCount: 1 });

    const mainTwo = await episodes.create(projectId, { title: '둘째 회차' });
    expect(mainTwo).toMatchObject({ kind: 'MAIN', number: 2 });
    expect(episodes.list(projectId).map((episode) => episode.id)).toEqual([mainOne.id, mainTwo.id]);

    const collection = (await request(app.getHttpServer())
      .get(`/projects/${projectId}/side-stories`)
      .expect(200)).body;
    expect(collection.standalone.map((episode: { id: string }) => episode.id)).toEqual([standalone.id]);
    expect(collection.groups.find((group: { id: string }) => group.id === groupA.id)
      .episodes.map((episode: { number: number }) => episode.number)).toEqual([1, 2]);
    expect(collection.groups.find((group: { id: string }) => group.id === groupB.id)
      .episodes.map((episode: { number: number }) => episode.number)).toEqual([1]);
  });

  it('prefers explicit milestones and validates exact directions while retaining legacy input', async () => {
    const legacyReversal = {
      episode: 2,
      description: '호환용 반전 문장',
    };
    const body = {
      title: '두 계획의 정원',
      description: '새 계획과 레거시 입력이 함께 온다.',
      branchFromEpisodeId: null,
      canon: '정원에서는 거짓말을 할 수 없다.',
      arc: {
        title: '진실의 정원',
        goal: '정원의 문을 연다.',
        conflict: '수호자가 문을 봉인한다.',
        endEpisodeNumber: 3,
        reversalPlan: [legacyReversal],
        milestones: [{
          episode: 3,
          type: 'CLIMAX' as const,
          description: '수호자의 봉인을 깨뜨린다.',
        }],
        episodeDirections: [
          { episode: 1, title: '정원 입구', direction: '봉인의 흔적을 찾는다.' },
          { episode: 2, title: '수호자', direction: '수호자와 협상한다.' },
          { episode: 3, title: '열린 문', direction: '수호자의 봉인을 깨뜨린다.' },
        ],
      },
    };
    expect(createSideStoryGroupSchema.safeParse(body).success).toBe(true);
    expect(createSideStoryGroupSchema.safeParse({
      ...body,
      arc: { ...body.arc, episodeDirections: body.arc.episodeDirections.slice(0, -1) },
    }).success).toBe(false);

    const created = (await request(app.getHttpServer())
      .post(`/projects/${projectId}/side-story-groups`)
      .send(body)
      .expect(201)).body;

    expect(created.arc.milestones).toEqual(body.arc.milestones);
    expect(created.arc.episodeDirections).toEqual(body.arc.episodeDirections);
    expect(created.arc).not.toHaveProperty('reversalPlan');
    expect(sideStoryGroupSchema.safeParse(created).success).toBe(true);
    expect(database.connection.prepare(
      'SELECT reversal_plan_json FROM arcs WHERE id = ?',
    ).get(created.arc.id)).toEqual({ reversal_plan_json: JSON.stringify([legacyReversal]) });
  });

  it('accepts only a live main episode in the same project as a branch', async () => {
    const main = await episodes.create(projectId, { title: '분기점' });
    const side = (await request(app.getHttpServer())
      .post(`/projects/${projectId}/side-stories`)
      .send({ title: '단편', groupId: null, branchFromEpisodeId: main.id })
      .expect(201)).body;
    const otherProject = projects.createInternal({
      title: '다른 작품', logline: '다른 흐름', genreTags: ['판타지'],
    });
    const foreignMain = await episodes.create(otherProject.id, { title: '다른 분기점' });

    for (const branchFromEpisodeId of ['missing-episode', foreignMain.id, side.id]) {
      await request(app.getHttpServer())
        .post(`/projects/${projectId}/side-story-groups`)
        .send(groupBody(branchFromEpisodeId))
        .expect(400);
      await request(app.getHttpServer())
        .post(`/projects/${projectId}/side-stories`)
        .send({ title: '잘못된 분기', groupId: null, branchFromEpisodeId })
        .expect(400);
    }

    const group = (await request(app.getHttpServer())
      .post(`/projects/${projectId}/side-story-groups`)
      .send(groupBody(main.id))
      .expect(201)).body;
    await request(app.getHttpServer())
      .post(`/projects/${projectId}/side-stories`)
      .send({ title: '이중 분기', groupId: group.id, branchFromEpisodeId: main.id })
      .expect(400);
  });

  it('rejects fields and value types outside the shared side-story contracts', async () => {
    const main = await episodes.create(projectId, { title: '분기점' });
    await request(app.getHttpServer())
      .post(`/projects/${projectId}/side-stories`)
      .send({
        title: '잘못된 단편',
        groupId: null,
        branchFromEpisodeId: main.id,
        forceNeedsReview: 'true',
      })
      .expect(400);
    await request(app.getHttpServer())
      .post(`/projects/${projectId}/side-stories`)
      .send({
        title: '알 수 없는 필드',
        groupId: null,
        branchFromEpisodeId: null,
        unexpected: true,
      })
      .expect(400);
    await request(app.getHttpServer())
      .post(`/projects/${projectId}/side-story-groups`)
      .send({ ...groupBody(main.id), unexpected: true })
      .expect(400);
    await request(app.getHttpServer())
      .post(`/projects/${projectId}/side-story-groups`)
      .send({
        ...groupBody(main.id),
        arc: { ...groupBody(main.id).arc, unexpected: true },
      })
      .expect(400);

    const group = sideStories.createGroup(projectId, groupBody(main.id));
    await request(app.getHttpServer())
      .patch(`/projects/${projectId}/side-story-groups/${group.id}`)
      .send({
        expectedRevision: group.revision,
        title: '허용된 수정처럼 보이지만',
        branchFromEpisodeId: null,
      })
      .expect(400);
  });

  it('keeps the derived group canon label synchronized when the group is renamed', async () => {
    const group = sideStories.createGroup(projectId, groupBody(null));
    const originalCanon = group.canon[0]!;
    await memory.indexSource({
      projectId,
      sourceType: 'CANON',
      sourceId: originalCanon.id,
      text: `${originalCanon.name}\n${originalCanon.content}`,
    });
    expect(database.connection.prepare(
      "SELECT COUNT(*) AS count FROM memory_chunks WHERE source_type = 'CANON' AND source_id = ?",
    ).get(originalCanon.id)).toEqual({ count: 1 });

    const renamed = (await request(app.getHttpServer())
      .patch(`/projects/${projectId}/side-story-groups/${group.id}`)
      .send({ expectedRevision: group.revision, title: '한여름 궁전' })
      .expect(200)).body;

    expect(renamed).toMatchObject({ title: '한여름 궁전', revision: group.revision + 1 });
    expect(renamed.canon[0]).toMatchObject({
      id: originalCanon.id,
      name: '한여름 궁전 정사',
      revision: originalCanon.revision + 1,
    });
    expect(database.connection.prepare(
      "SELECT COUNT(*) AS count FROM memory_chunks WHERE source_type = 'CANON' AND source_id = ?",
    ).get(originalCanon.id)).toEqual({ count: 0 });
  });
});

it('migrates a v13 project-target database to v14 without losing episode dependents', () => {
  const directory = mkdtempSync(join(tmpdir(), 'paranovel-side-story-migration-'));
  const dbPath = join(directory, 'v13.sqlite');
  let legacy: Database.Database | undefined;
  let migrated: DatabaseService | undefined;
  try {
    legacy = new Database(dbPath);
    legacy.pragma('foreign_keys = ON');
    legacy.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      WITH RECURSIVE versions(version) AS (
        SELECT 1 UNION ALL SELECT version + 1 FROM versions WHERE version < 13
      ) INSERT INTO schema_migrations SELECT version, '2026-09-01' FROM versions;

      CREATE TABLE projects (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, logline TEXT NOT NULL,
        genre_tags_json TEXT NOT NULL DEFAULT '[]', details_json TEXT NOT NULL DEFAULT '{}',
        default_target_chars INTEGER NOT NULL DEFAULT 5000,
        target_episode INTEGER, target_episode_source TEXT,
        next_episode_number INTEGER NOT NULL DEFAULT 1, revision INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
      );
      CREATE TABLE episodes (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        number INTEGER NOT NULL, title TEXT NOT NULL, direction TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '', revision INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'DRAFT', created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL, deleted_at TEXT, UNIQUE(project_id, number)
      );
      CREATE TABLE episode_idempotency (
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        idempotency_key TEXT NOT NULL, episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
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
        category TEXT NOT NULL, name TEXT NOT NULL, aliases_json TEXT NOT NULL DEFAULT '[]',
        content TEXT NOT NULL, metadata_json TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'ACTIVE',
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

      INSERT INTO projects (
        id, title, logline, target_episode, target_episode_source,
        next_episode_number, created_at, updated_at
      ) VALUES ('project', '기록관', '문을 연다.', 20, 'USER', 2, '2026-09-01', '2026-09-01');
      INSERT INTO episodes (id, project_id, number, title, direction, content, status, created_at, updated_at)
        VALUES ('episode', 'project', 1, '첫 회차', '문을 연다.', '문이 열렸다.', 'CONFIRMED', '2026-09-01', '2026-09-01');
      INSERT INTO episode_idempotency VALUES ('project', 'request', 'episode', 'hash', '2026-09-01');
      INSERT INTO episode_summaries (episode_id, synopsis, source_revision, source_hash, updated_at)
        VALUES ('episode', '문이 열렸다.', 1, 'hash', '2026-09-01');
      INSERT INTO scene_states (episode_id, location, source_revision, updated_at)
        VALUES ('episode', '문 앞', 1, '2026-09-01');
      INSERT INTO canon_entries (id, project_id, category, name, content, source_episode_id, created_at, updated_at)
        VALUES ('canon', 'project', 'OTHER', '문', '닫힌 문', 'episode', '2026-09-01', '2026-09-01');
      INSERT INTO arcs (id, project_id, title, start_episode_number, end_episode_number, goal, conflict, status, created_at, updated_at)
        VALUES ('arc', 'project', '첫 아크', 1, 5, '문을 연다.', '문지기가 막는다.', 'ACTIVE', '2026-09-01', '2026-09-01');
      INSERT INTO memory_chunks (id, project_id, source_type, source_id, ordinal, content, content_hash, created_at, updated_at)
        VALUES
          ('episode-memory', 'project', 'EPISODE', 'episode', 0, '문이 열렸다.', 'hash', '2026-09-01', '2026-09-01'),
          ('canon-memory', 'project', 'CANON', 'canon', 0, '닫힌 문', 'hash', '2026-09-01', '2026-09-01');
      INSERT INTO ai_runs (id, task, project_id, episode_id, model, context_hash, status, created_at)
        VALUES ('run', 'episode_draft', 'project', 'episode', 'test', 'hash', 'SUCCEEDED', '2026-09-01');
      INSERT INTO editor_ai_messages (id, project_id, episode_id, client_message_id, role, content, status, created_at)
        VALUES ('message', 'project', 'episode', 'client', 'assistant', '제안', 'COMPLETE', '2026-09-01');
    `);
    legacy.close();
    legacy = undefined;

    vi.stubEnv('DB_PATH', dbPath);
    vi.stubEnv('OPENROUTER_EMBEDDING_DIMENSIONS', '4');
    migrated = new DatabaseService();

    expect(migrated.connection.prepare('SELECT kind, number, side_story_group_id, branch_from_episode_id FROM episodes').get())
      .toEqual({ kind: 'MAIN', number: 1, side_story_group_id: null, branch_from_episode_id: null });
    for (const [table, id] of [
      ['episode_idempotency', undefined], ['episode_summaries', undefined], ['scene_states', undefined],
      ['canon_entries', 'canon'], ['arcs', 'arc'], ['ai_runs', 'run'], ['editor_ai_messages', 'message'],
    ] as const) {
      const row = id
        ? migrated.connection.prepare(`SELECT id FROM ${table}`).get()
        : migrated.connection.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get();
      expect(row).toEqual(id ? { id } : { count: 1 });
    }
    expect(migrated.connection.prepare('SELECT side_story_group_id FROM canon_entries').get())
      .toEqual({ side_story_group_id: null });
    expect(migrated.connection.prepare('SELECT side_story_group_id FROM arcs').get())
      .toEqual({ side_story_group_id: null });
    expect(migrated.connection.prepare('SELECT target_episode, target_episode_source FROM projects').get())
      .toEqual({ target_episode: 20, target_episode_source: 'USER' });
    expect(migrated.connection.prepare('SELECT source_type, flow_key, flow_position FROM memory_chunks ORDER BY source_type').all())
      .toEqual([
        { source_type: 'CANON', flow_key: 'SHARED', flow_position: null },
        { source_type: 'EPISODE', flow_key: 'MAIN', flow_position: 1 },
      ]);
    expect(migrated.connection.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 14').get())
      .toEqual({ count: 1 });
    expect(migrated.connection.pragma('foreign_key_check')).toEqual([]);
  } finally {
    migrated?.onApplicationShutdown();
    if (legacy?.open) legacy.close();
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  }
});
