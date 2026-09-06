import { BadRequestException, ConflictException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArcsService } from '../src/arcs/arcs.service';
import { DatabaseService } from '../src/database/database.service';
import { episodes } from '../src/database/schema';
import { ProjectsService } from '../src/projects/projects.service';

const currentFields = {
  title: '첫 관문', startEpisodeNumber: 1, endEpisodeNumber: 5,
  goal: '관문을 연다.', conflict: '수문장이 막는다.', reversalPlan: [],
};
const futureFields = {
  title: '왕도의 그림자', startEpisodeNumber: 6, endEpisodeNumber: 10,
  goal: '왕도에 들어간다.', conflict: '왕실이 추적한다.', reversalPlan: [],
};

describe('arc lifecycle protection', () => {
  let database: DatabaseService;
  let arcs: ArcsService;
  let projectId: string;

  beforeEach(() => {
    vi.stubEnv('DB_PATH', ':memory:');
    vi.stubEnv('OPENROUTER_EMBEDDING_DIMENSIONS', '4');
    database = new DatabaseService();
    projectId = new ProjectsService(database).createInternal({
      title: '기억의 문', logline: '기록관이 문을 연다.', genreTags: ['판타지'],
    }).id;
    arcs = new ArcsService(database, {
      indexSource: vi.fn(), removeSource: vi.fn(), assemble: vi.fn(),
    } as never, {} as never);
  });

  afterEach(() => {
    database.onApplicationShutdown();
    vi.unstubAllEnvs();
  });

  it('allows ordinary future edits while protecting current and previous plans', async () => {
    const current = await arcs.create(projectId, { ...currentFields, status: 'ACTIVE' });
    const future = await arcs.create(projectId, futureFields);
    expect(future.status).toBe('PLANNED');

    const edited = await arcs.update(projectId, future.id, {
      expectedRevision: future.revision, goal: '동료와 함께 왕도에 들어간다.',
    });
    expect(edited).toMatchObject({ status: 'PLANNED', revision: 2, goal: '동료와 함께 왕도에 들어간다.' });
    await expect(arcs.update(projectId, current.id, {
      expectedRevision: current.revision, goal: '현재 계획을 몰래 바꾼다.',
    })).rejects.toBeInstanceOf(ConflictException);
    const confirmed = await arcs.update(projectId, current.id, {
      expectedRevision: current.revision, goal: '확인하고 현재 계획을 바꾼다.', confirmProtected: true,
    });
    expect(confirmed.goal).toBe('확인하고 현재 계획을 바꾼다.');
  });

  it('moves a finished current arc to previous when its future arc is activated', async () => {
    const current = await arcs.create(projectId, { ...currentFields, status: 'ACTIVE' });
    const future = await arcs.create(projectId, futureFields);
    const stamp = new Date().toISOString();
    database.orm.insert(episodes).values({
      id: 'episode-5', projectId, number: 5, title: '관문', direction: '관문을 연다.', content: '관문이 열렸다.',
      revision: 1, status: 'DRAFT', createdAt: stamp, updatedAt: stamp, deletedAt: null,
    }).run();

    const activated = await arcs.update(projectId, future.id, {
      expectedRevision: future.revision, status: 'ACTIVE',
    });
    expect(activated.status).toBe('ACTIVE');
    expect(arcs.get(projectId, current.id)).toMatchObject({ status: 'COMPLETE', revision: 2 });
  });

  it('requires confirmation for an early replacement and archives the abandoned current plan', async () => {
    const current = await arcs.create(projectId, { ...currentFields, status: 'ACTIVE' });
    const future = await arcs.create(projectId, futureFields);
    await expect(arcs.update(projectId, future.id, {
      expectedRevision: future.revision, status: 'ACTIVE',
    })).rejects.toBeInstanceOf(ConflictException);

    await arcs.update(projectId, future.id, {
      expectedRevision: future.revision, status: 'ACTIVE', confirmProtected: true,
    });
    expect(arcs.get(projectId, current.id).status).toBe('ARCHIVED');
  });

  it('deletes only future plans and lists every group in episode order', async () => {
    const current = await arcs.create(projectId, { ...currentFields, status: 'ACTIVE' });
    const late = await arcs.create(projectId, { ...futureFields, title: '두 번째 미래', startEpisodeNumber: 11, endEpisodeNumber: 15 });
    const early = await arcs.create(projectId, futureFields);
    expect(arcs.list(projectId).map((arc) => arc.startEpisode)).toEqual([1, 6, 11]);
    expect(() => arcs.remove(projectId, current.id, { expectedRevision: current.revision })).toThrow(ConflictException);
    expect(() => arcs.remove(projectId, early.id, { expectedRevision: early.revision - 1 })).toThrow(ConflictException);
    arcs.remove(projectId, early.id, { expectedRevision: early.revision });
    expect(arcs.list(projectId).map((arc) => arc.id)).toEqual([current.id, late.id]);
  });

  it('keeps side-story arcs and episodes outside the main arc lifecycle', async () => {
    const current = await arcs.create(projectId, { ...currentFields, status: 'ACTIVE' });
    const stamp = new Date().toISOString();
    database.connection.prepare(`
      INSERT INTO side_story_groups (
        id, project_id, title, description, next_episode_number, revision, created_at, updated_at
      ) VALUES ('side-group', ?, '외전', '', 100, 1, ?, ?)
    `).run(projectId, stamp, stamp);
    const insertSideArc = database.connection.prepare(`
      INSERT INTO arcs (
        id, project_id, side_story_group_id, title, start_episode_number, end_episode_number,
        goal, conflict, twist_plan, reversal_plan_json, status, revision, created_at, updated_at
      ) VALUES (?, ?, 'side-group', ?, ?, ?, '외전 목표', '외전 갈등', '', '[]', ?, 1, ?, ?)
    `);
    insertSideArc.run('side-active', projectId, '외전 현재', 1, 5, 'ACTIVE', stamp, stamp);
    insertSideArc.run('side-planned', projectId, '외전 미래', 6, 10, 'PLANNED', stamp, stamp);
    database.connection.prepare(`
      INSERT INTO episodes (
        id, project_id, kind, number, side_story_group_id, title, direction, content,
        revision, status, created_at, updated_at
      ) VALUES ('side-episode', ?, 'SIDE_STORY', 99, 'side-group', '외전 99화', '외전 결말',
        '외전만 완결됐다.', 1, 'DRAFT', ?, ?)
    `).run(projectId, stamp, stamp);

    const future = await arcs.create(projectId, futureFields);
    expect(arcs.list(projectId).map((arc) => arc.id)).toEqual([current.id, future.id]);
    await expect(arcs.update(projectId, future.id, {
      expectedRevision: future.revision,
      status: 'ACTIVE',
    })).rejects.toBeInstanceOf(ConflictException);

    await arcs.update(projectId, future.id, {
      expectedRevision: future.revision,
      status: 'ACTIVE',
      confirmProtected: true,
    });
    expect(arcs.get(projectId, current.id).status).toBe('ARCHIVED');
    expect(database.connection.prepare('SELECT status FROM arcs WHERE id = ?').get('side-active'))
      .toEqual({ status: 'ACTIVE' });
    expect(database.connection.prepare('SELECT status FROM arcs WHERE id = ?').get('side-planned'))
      .toEqual({ status: 'PLANNED' });
  });

  it('allows only deliberate lifecycle transitions and keeps past arcs read-only', async () => {
    await expect(arcs.create(projectId, {
      ...futureFields,
      reversalPlan: [{ episode: 99, description: '범위 밖 반전' }],
    })).rejects.toBeInstanceOf(BadRequestException);
    await expect(arcs.create(projectId, { ...currentFields, status: 'COMPLETE' }))
      .rejects.toBeInstanceOf(BadRequestException);
    const current = await arcs.create(projectId, { ...currentFields, status: 'ACTIVE' });
    const future = await arcs.create(projectId, futureFields);
    await expect(arcs.update(projectId, current.id, {
      expectedRevision: current.revision,
      status: 'PLANNED',
      confirmProtected: true,
    })).rejects.toBeInstanceOf(BadRequestException);
    await expect(arcs.update(projectId, future.id, {
      expectedRevision: future.revision,
      status: 'COMPLETE',
    })).rejects.toBeInstanceOf(BadRequestException);

    await arcs.update(projectId, future.id, {
      expectedRevision: future.revision,
      status: 'ACTIVE',
      confirmProtected: true,
    });
    const archived = arcs.get(projectId, current.id);
    await expect(arcs.update(projectId, archived.id, {
      expectedRevision: archived.revision,
      title: '다시 쓰는 아크',
      confirmProtected: true,
    })).rejects.toBeInstanceOf(ConflictException);
  });

  it('does not let a directly created current arc skip an earlier future plan', async () => {
    const current = await arcs.create(projectId, { ...currentFields, status: 'ACTIVE' });
    await arcs.create(projectId, futureFields);

    await expect(arcs.create(projectId, {
      ...futureFields,
      title: '너무 앞선 현재',
      startEpisodeNumber: 11,
      endEpisodeNumber: 15,
      status: 'ACTIVE',
      confirmProtected: true,
    })).rejects.toBeInstanceOf(BadRequestException);
    expect(arcs.current(projectId)?.id).toBe(current.id);

    const replacement = await arcs.create(projectId, {
      ...currentFields,
      title: '확인하고 교체한 현재',
      status: 'ACTIVE',
      confirmProtected: true,
    });
    expect(replacement.status).toBe('ACTIVE');
    expect(arcs.get(projectId, current.id).status).toBe('ARCHIVED');
  });

  it('revises the next planned arc in place and validates its exact range', async () => {
    const completeJson = vi.fn(async (request) => {
      const value = {
        title: '수정된 왕도의 그림자',
        startEpisodeNumber: 6,
        endEpisodeNumber: 10,
        goal: '왕도의 음모를 밝힌다.',
        conflict: '왕실의 추격을 피한다.',
        reversalPlan: [{ episode: 9, description: '조력자가 왕실의 며느리였다.' }],
        episodeDirections: [{ episode: 6, title: '성문', direction: '왕도에 잠입한다.' }],
        conflicts: [],
      };
      return { value: request.validator.parse(value) };
    });
    const assembled = {
      projectContext: '{}', improvements: '[]', canon: '[]', currentArc: 'null',
      currentScene: 'null', recentSummaries: '[]', openForeshadowing: '[]', retrievedMemories: '[]',
    };
    arcs = new ArcsService(database, {
      indexSource: vi.fn(), removeSource: vi.fn(), assemble: vi.fn().mockResolvedValue(assembled),
    } as never, { completeJson } as never);
    await arcs.create(projectId, { ...currentFields, status: 'ACTIVE' });
    const future = await arcs.create(projectId, futureFields);

    const proposal = await arcs.plan(projectId, { request: '조력자의 비밀을 강화해 줘' });
    expect(proposal).toMatchObject({
      startEpisodeNumber: 6,
      endEpisodeNumber: 10,
      replaceArcId: future.id,
      replaceArcRevision: future.revision,
    });
    expect(completeJson.mock.calls[0]![0].variables).toMatchObject({
      start_episode_number: 6,
      end_episode_number: 10,
    });

    completeJson.mockImplementationOnce(async (request) => ({
      value: request.validator.parse({
        ...proposal,
        startEpisodeNumber: 5,
      }),
    }));
    await expect(arcs.plan(projectId, {})).rejects.toThrow();
  });

  it('never leaves an unplannable one-to-four episode tail before the ending target', async () => {
    database.connection.prepare(`
      UPDATE projects
      SET target_episode = 30, target_episode_source = 'USER'
      WHERE id = ?
    `).run(projectId);
    const completeJson = vi.fn(async (request) => ({
      value: request.validator.parse({
        title: '결말 전야',
        startEpisodeNumber: 21,
        endEpisodeNumber: 27,
        goal: '달을 되찾을 실마리를 모은다.',
        conflict: '왕실이 마지막 문을 봉쇄한다.',
        reversalPlan: [],
        episodeDirections: [],
        conflicts: [],
      }),
    }));
    const assembled = {
      projectContext: '{}', improvements: '[]', canon: '[]', currentArc: 'null',
      currentScene: 'null', recentSummaries: '[]', openForeshadowing: '[]', retrievedMemories: '[]',
    };
    arcs = new ArcsService(database, {
      indexSource: vi.fn(), removeSource: vi.fn(), assemble: vi.fn().mockResolvedValue(assembled),
    } as never, { completeJson } as never);
    await arcs.create(projectId, {
      ...currentFields,
      endEpisodeNumber: 20,
      status: 'ACTIVE',
    });

    await expect(arcs.plan(projectId, {})).rejects.toThrow();

    completeJson.mockImplementationOnce(async (request) => ({
      value: request.validator.parse({
        title: '결말 전야',
        startEpisodeNumber: 21,
        endEpisodeNumber: 25,
        goal: '달을 되찾을 실마리를 모은다.',
        conflict: '왕실이 마지막 문을 봉쇄한다.',
        reversalPlan: [],
        episodeDirections: [],
        conflicts: [],
      }),
    }));
    await expect(arcs.plan(projectId, {})).resolves.toMatchObject({
      startEpisodeNumber: 21,
      endEpisodeNumber: 25,
    });
  });

  it('keeps manual future ranges inside the ending target, non-overlapping, and refillable', async () => {
    database.connection.prepare(`
      UPDATE projects
      SET target_episode = 15, target_episode_source = 'USER'
      WHERE id = ?
    `).run(projectId);
    await arcs.create(projectId, { ...currentFields, status: 'ACTIVE' });
    const middle = await arcs.create(projectId, futureFields);
    const ending = await arcs.create(projectId, {
      ...futureFields,
      title: '마지막 문',
      startEpisodeNumber: 11,
      endEpisodeNumber: 15,
    });

    await expect(arcs.update(projectId, ending.id, {
      expectedRevision: ending.revision,
      status: 'ACTIVE',
      confirmProtected: true,
    })).rejects.toBeInstanceOf(BadRequestException);
    expect(arcs.get(projectId, ending.id).status).toBe('PLANNED');

    await expect(arcs.create(projectId, {
      ...futureFields,
      title: '완결 밖 계획',
      startEpisodeNumber: 16,
      endEpisodeNumber: 20,
    })).rejects.toBeInstanceOf(BadRequestException);
    await expect(arcs.update(projectId, middle.id, {
      expectedRevision: middle.revision,
      startEpisodeNumber: 5,
      endEpisodeNumber: 9,
    })).rejects.toBeInstanceOf(BadRequestException);

    arcs.remove(projectId, middle.id, { expectedRevision: middle.revision });
    await expect(arcs.update(projectId, ending.id, {
      expectedRevision: ending.revision,
      status: 'ACTIVE',
      confirmProtected: true,
    })).rejects.toBeInstanceOf(BadRequestException);
    await expect(arcs.update(projectId, ending.id, {
      expectedRevision: ending.revision,
      startEpisodeNumber: 10,
      endEpisodeNumber: 15,
    })).rejects.toBeInstanceOf(BadRequestException);
    await expect(arcs.create(projectId, futureFields)).resolves.toMatchObject({
      startEpisodeNumber: 6,
      endEpisodeNumber: 10,
      status: 'PLANNED',
    });
  });

  it('proposes a new arc for the earliest deleted future gap before revising later plans', async () => {
    database.connection.prepare(`
      UPDATE projects
      SET target_episode = 15, target_episode_source = 'USER'
      WHERE id = ?
    `).run(projectId);
    const completeJson = vi.fn(async (request) => ({
      value: request.validator.parse({
        title: '복원된 중간 아크',
        startEpisodeNumber: 6,
        endEpisodeNumber: 10,
        goal: '왕도로 향할 단서를 찾는다.',
        conflict: '추격대가 길을 막는다.',
        reversalPlan: [],
        episodeDirections: [],
        conflicts: [],
      }),
    }));
    const assembled = {
      projectContext: '{}', improvements: '[]', canon: '[]', currentArc: 'null',
      currentScene: 'null', recentSummaries: '[]', openForeshadowing: '[]', retrievedMemories: '[]',
    };
    arcs = new ArcsService(database, {
      indexSource: vi.fn(), removeSource: vi.fn(), assemble: vi.fn().mockResolvedValue(assembled),
    } as never, { completeJson } as never);
    await arcs.create(projectId, { ...currentFields, status: 'ACTIVE' });
    const deleted = await arcs.create(projectId, futureFields);
    await arcs.create(projectId, {
      ...futureFields,
      title: '마지막 문',
      startEpisodeNumber: 11,
      endEpisodeNumber: 15,
    });
    arcs.remove(projectId, deleted.id, { expectedRevision: deleted.revision });

    const proposal = await arcs.plan(projectId, {});

    expect(proposal).toMatchObject({ startEpisodeNumber: 6, endEpisodeNumber: 10 });
    expect(proposal).not.toHaveProperty('replaceArcId');
    expect(completeJson.mock.calls[0]![0].variables).toMatchObject({
      start_episode_number: 6,
      end_episode_number: 10,
      arc_to_revise: 'null',
    });
  });
});
