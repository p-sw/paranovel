import { BadRequestException, ConflictException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContinuityIssue } from '../src/ai/ai.types';
import { DatabaseService } from '../src/database/database.service';
import { EpisodesController } from '../src/episodes/episodes.controller';
import { EpisodesService, type StreamEvent } from '../src/episodes/episodes.service';
import { ProjectsService } from '../src/projects/projects.service';
import { SideStoriesService } from '../src/side-stories/side-stories.service';

const blockingIssue: ContinuityIssue = {
  category: 'CANON',
  severity: 'BLOCKING',
  excerpt: '오른손으로 검을 들었다.',
  explanation: '확정 설정에서는 오른손을 움직일 수 없다.',
  evidenceRefs: ['canon:injury'],
  repairInstruction: '왼손으로 검을 들게 고친다.',
};

describe('saved episode continuity review', () => {
  let database: DatabaseService;
  let projects: ProjectsService;
  let projectId: string;
  let memory: {
    assemble: ReturnType<typeof vi.fn>;
    removeSource: ReturnType<typeof vi.fn>;
  };
  let ai: {
    completeJson: ReturnType<typeof vi.fn>;
    streamText: ReturnType<typeof vi.fn>;
  };
  let service: EpisodesService;

  beforeEach(() => {
    vi.stubEnv('DB_PATH', ':memory:');
    vi.stubEnv('OPENROUTER_EMBEDDING_DIMENSIONS', '4');
    database = new DatabaseService();
    projects = new ProjectsService(database);
    projectId = projects.createInternal({
      title: '검의 기록',
      logline: '다친 기사가 진실을 찾는다.',
      genreTags: ['판타지'],
    }).id;
    memory = {
      assemble: vi.fn(async () => ({
        projectContext: '{"title":"검의 기록"}',
        writingDirection: '3인칭 제한 시점',
        canon: '[{"ref":"canon:injury","content":"오른손을 움직일 수 없다."}]',
        currentArc: 'null',
        currentScene: '{"location":"성문"}',
        recentSummaries: '[{"episode_id":"previous"}]',
        openForeshadowing: '[]',
        retrievedMemories: '[]',
        improvements: '[]',
      })),
      removeSource: vi.fn(),
    };
    ai = {
      completeJson: vi.fn(async () => ({ value: { issues: [] as ContinuityIssue[] } })),
      streamText: vi.fn(),
    };
    service = new EpisodesService(database, projects, memory as never, ai as never);
  });

  afterEach(() => {
    database.onApplicationShutdown();
    vi.unstubAllEnvs();
  });

  async function savedEpisode() {
    return service.create(projectId, {
      title: '부러진 검',
      direction: '성문 앞에서 검을 든다.',
      content: '\n  오른손으로 검을 들었다.  \n',
    });
  }

  it('reviews the exact saved manuscript with draft memory and emits the standard result', async () => {
    const episode = await savedEpisode();
    const before = service.get(projectId, episode.id);
    const controller = new AbortController();
    const events: StreamEvent[] = [];
    ai.completeJson.mockResolvedValue({ value: { issues: [blockingIssue] } });

    await service.reviewContinuity(
      projectId,
      episode.id,
      { expectedRevision: episode.revision },
      (event) => events.push(event),
      controller.signal,
    );

    expect(memory.assemble).toHaveBeenCalledExactlyOnceWith(
      projectId,
      `${episode.title}\n${episode.direction}`,
      episode.id,
      { previousEpisodeScene: true },
    );
    expect(ai.completeJson).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      task: 'continuity_review',
      promptId: 'continuity-review',
      includeCore: false,
      projectId,
      episodeId: episode.id,
      signal: controller.signal,
      variables: expect.objectContaining({
        episode_title: episode.title,
        episode_direction: episode.direction,
        boundary_context: '저장된 회차 전체 원고',
        candidate_text: episode.content,
        draft_text: episode.content,
        recent_episode_memories: '[{"episode_id":"previous"}]',
      }),
    }));
    expect(events).toEqual([
      { type: 'stage', stage: 'MEMORY' },
      { type: 'stage', stage: 'CHECKING' },
      {
        type: 'done',
        content: episode.content,
        issues: [blockingIssue],
        blocked: true,
        baseRevision: episode.revision,
      },
    ]);
    expect(service.get(projectId, episode.id)).toEqual(before);
  });

  it('exposes the saved review as an NDJSON episode endpoint', async () => {
    const episode = await savedEpisode();
    Reflect.defineMetadata('design:paramtypes', [EpisodesService], EpisodesController);
    const module = await Test.createTestingModule({
      controllers: [EpisodesController],
      providers: [{ provide: EpisodesService, useValue: service }],
    }).compile();
    const app = module.createNestApplication();
    await app.init();
    try {
      const response = await request(app.getHttpServer())
        .post(`/projects/${projectId}/episodes/${episode.id}/continuity-review`)
        .send({ expectedRevision: episode.revision })
        .expect(200)
        .expect('Content-Type', /application\/x-ndjson/);

      expect(response.text.trim().split('\n').map((line) => JSON.parse(line))).toEqual([
        { type: 'stage', stage: 'MEMORY' },
        { type: 'stage', stage: 'CHECKING' },
        {
          type: 'done', content: episode.content, issues: [], blocked: false,
          baseRevision: episode.revision,
        },
      ]);
    } finally {
      await app.close();
    }
  });

  it('rejects an empty manuscript or stale revision before loading memory', async () => {
    const empty = await service.create(projectId, { title: '빈 회차', direction: '아직 쓰지 않는다.' });
    const events: StreamEvent[] = [];

    await expect(service.reviewContinuity(
      projectId,
      empty.id,
      { expectedRevision: empty.revision + 1 },
      (event) => events.push(event),
    )).rejects.toBeInstanceOf(ConflictException);
    await expect(service.reviewContinuity(
      projectId,
      empty.id,
      { expectedRevision: empty.revision },
      (event) => events.push(event),
    )).rejects.toBeInstanceOf(BadRequestException);

    expect(events).toEqual([]);
    expect(memory.assemble).not.toHaveBeenCalled();
    expect(ai.completeJson).not.toHaveBeenCalled();
  });

  it('does not publish a result if the episode changes while the AI is reviewing it', async () => {
    const episode = await savedEpisode();
    const events: StreamEvent[] = [];
    ai.completeJson.mockImplementation(async () => {
      service.update(projectId, episode.id, {
        expectedRevision: episode.revision,
        content: '검토 중 바뀐 원고',
      });
      return { value: { issues: [] } };
    });

    await expect(service.reviewContinuity(
      projectId,
      episode.id,
      { expectedRevision: episode.revision },
      (event) => events.push(event),
    )).rejects.toThrow('Episode revision changed during continuity review');

    expect(events.at(-1)).toEqual({ type: 'stage', stage: 'CHECKING' });
    expect(events.some((event) => event.type === 'done')).toBe(false);
  });

  it('does not publish a result if the main episode order changes during review', async () => {
    const episode = await savedEpisode();
    const events: StreamEvent[] = [];
    ai.completeJson.mockImplementation(async () => {
      await service.create(projectId, {
        title: '새 회차',
        direction: '검토 중 회차가 추가된다.',
        content: '새 원고',
      });
      return { value: { issues: [] } };
    });

    await expect(service.reviewContinuity(
      projectId,
      episode.id,
      { expectedRevision: episode.revision },
      (event) => events.push(event),
    )).rejects.toThrow('회차 목록이 변경되었습니다');

    expect(events.at(-1)).toEqual({ type: 'stage', stage: 'CHECKING' });
    expect(events.some((event) => event.type === 'done')).toBe(false);
  });

  it('does not publish a result if the scoped side-story flow changes during review', async () => {
    const sideStories = new SideStoriesService(database, memory as never);
    const episode = await sideStories.create(projectId, {
      title: '갈라진 검',
      direction: '다른 시간선에서 검을 든다.',
      content: '왼손으로 검을 들었다.',
      groupId: null,
      branchFromEpisodeId: null,
    });
    const events: StreamEvent[] = [];
    ai.completeJson.mockImplementation(async () => {
      const project = projects.get(projectId);
      projects.update(projectId, {
        expectedRevision: project.revision,
        logline: '검토 중 달라진 프로젝트 문맥',
      });
      return { value: { issues: [] } };
    });

    await expect(service.reviewContinuity(
      projectId,
      episode.id,
      { expectedRevision: episode.revision },
      (event) => events.push(event),
    )).rejects.toThrow('외전 흐름이 변경되었습니다');

    expect(events.at(-1)).toEqual({ type: 'stage', stage: 'CHECKING' });
    expect(events.some((event) => event.type === 'done')).toBe(false);
  });
});
