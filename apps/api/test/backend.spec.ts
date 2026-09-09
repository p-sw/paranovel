import { BadRequestException, ConflictException, UnprocessableEntityException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArcEpisodeDirectionsService } from '../src/ai/arc-episode-directions.service';
import type { AiRunnerService } from '../src/ai/ai-runner.service';
import { AiRunnerService as ConcreteAiRunnerService } from '../src/ai/ai-runner.service';
import { episodeDirectionSchema, episodeDirectionValidator } from '../src/ai/ai.schemas';
import { DatabaseService } from '../src/database/database.service';
import { canonEntries, episodes, sceneStates } from '../src/database/schema';
import { EpisodesService } from '../src/episodes/episodes.service';
import { ImprovementsService } from '../src/improvements/improvements.service';
import { MemoryService } from '../src/memory/memory.service';
import { PromptRegistryService } from '../src/prompts/prompt-registry.service';
import { ProjectWizardService } from '../src/projects/project-wizard.service';
import { ProjectsService } from '../src/projects/projects.service';

describe('backend core', () => {
  let database: DatabaseService;
  let memory: MemoryService;
  let projects: ProjectsService;
  const embeddingGateway = {
    embeddings: vi.fn(async (texts: string[]) =>
      texts.map((text) => [text.length % 7, 1, 0.5, 0.25]),
    ),
  };

  beforeEach(() => {
    process.env.DB_PATH = ':memory:';
    process.env.OPENROUTER_EMBEDDING_DIMENSIONS = '4';
    database = new DatabaseService();
    memory = new MemoryService(database, embeddingGateway as never);
    projects = new ProjectsService(database);
  });

  const insertCanonSource = (projectId: string, sourceId: string, content: string): void => {
    const stamp = new Date().toISOString();
    database.orm.insert(canonEntries).values({
      id: sourceId,
      projectId,
      sideStoryGroupId: null,
      category: 'OTHER',
      name: sourceId,
      aliasesJson: '[]',
      content,
      metadataJson: '{}',
      status: 'ACTIVE',
      revision: 1,
      sourceEpisodeId: null,
      createdAt: stamp,
      updatedAt: stamp,
    }).run();
  };

  afterEach(() => {
    database.onApplicationShutdown();
    vi.clearAllMocks();
  });

  it('preserves an existing details_json value and accepts the legacy details PATCH alias', async () => {
    const project = projects.createInternal({
      title: '시점의 문',
      logline: '기록관이 잃어버린 문장을 찾는다.',
      genreTags: ['판타지'],
      writingDirection: '하린의 1인칭 현재 시점으로 간결하게 쓴다.',
    });

    expect(project.writingDirection).toBe('하린의 1인칭 현재 시점으로 간결하게 쓴다.');
    expect(
      database.connection.prepare('SELECT details_json FROM projects WHERE id = ?').get(project.id),
    ).toEqual({ details_json: JSON.stringify(project.writingDirection) });
    expect((await memory.assemble(project.id, '')).writingDirection).toBe(project.writingDirection);

    const legacyStoredDetails = '3인칭 관찰자 시점과 긴 문장 호흡을 유지한다.';
    database.connection.prepare('UPDATE projects SET details_json = ? WHERE id = ?')
      .run(JSON.stringify(legacyStoredDetails), project.id);
    expect(projects.get(project.id).writingDirection).toBe(legacyStoredDetails);
    expect((await memory.assemble(project.id, '')).writingDirection).toBe(legacyStoredDetails);

    const updated = projects.update(project.id, {
      expectedRevision: project.revision,
      details: '3인칭 제한 시점. 짧은 문장과 건조한 문체를 유지한다.',
    });
    expect(updated).toMatchObject({
      writingDirection: '3인칭 제한 시점. 짧은 문장과 건조한 문체를 유지한다.',
      revision: project.revision + 1,
    });
    expect((await memory.assemble(project.id, '')).writingDirection).toBe(updated.writingDirection);

    const cleared = projects.update(project.id, {
      expectedRevision: updated.revision,
      writingDirection: '',
    });
    expect(cleared.writingDirection).toBe('');
    expect(() => projects.update(project.id, {
      expectedRevision: cleared.revision,
      writingDirection: '가'.repeat(20_001),
    })).toThrow(BadRequestException);
  });

  it('enforces the writing-direction length limit during internal project creation', () => {
    const boundary = '가'.repeat(20_000);
    expect(projects.createInternal({
      title: '경계의 문',
      logline: '집필 지침의 경계를 시험한다.',
      genreTags: ['판타지'],
      writingDirection: boundary,
    }).writingDirection).toBe(boundary);

    expect(() => projects.createInternal({
      title: '넘친 문',
      logline: '집필 지침의 초과를 시험한다.',
      genreTags: ['판타지'],
      writingDirection: `${boundary}가`,
    })).toThrow(BadRequestException);
  });

  it('loads all runtime prompt files and renders task plus shared prompts', () => {
    const registry = new PromptRegistryService();
    registry.validateAll();
    const prompt = registry.render('episode-direction', {
      project_context: '{}',
      writing_direction: '',
      canon: '[]',
      current_arc: 'null',
      current_scene: 'null',
      recent_summaries: '[]',
      open_foreshadowing: '[]',
      retrieved_memories: '[]',
      improvements: '[]',
      user_request: '다음 회차',
    });
    expect(prompt.refs.map((ref) => ref.id)).toEqual([
      'novelist-core',
      'memory-contract',
      'episode-direction',
    ]);
    expect(prompt.system).toContain('Canon');
  });

  it('rejects JSON that passes parsing but violates the Zod output contract', async () => {
    const registry = new PromptRegistryService();
    registry.validateAll();
    const gateway = {
      complete: vi.fn(async () => ({
        content: JSON.stringify({ title: '제목만 있음' }),
        toolCalls: [],
        usage: {},
        model: 'test',
      })),
    };
    const runner = new ConcreteAiRunnerService(database, registry, gateway as never, { isConfigured: () => false } as never);
    await expect(
      runner.completeJson({
        task: 'episode_direction',
        promptId: 'episode-direction',
        variables: {
          project_context: '{}', writing_direction: '', canon: '[]', current_arc: 'null', current_scene: 'null', recent_summaries: '[]',
          open_foreshadowing: '[]', retrieved_memories: '[]', improvements: '[]', user_request: '다음 회차',
        },
        schema: { name: 'episode_direction', value: episodeDirectionSchema },
        validator: episodeDirectionValidator,
      }),
    ).rejects.toThrow('invalid structured output');
    const run = database.connection
      .prepare('SELECT status, latency_ms, memory_revision_hash FROM ai_runs')
      .get() as { status: string; latency_ms: number; memory_revision_hash: string };
    expect(run.status).toBe('FAILED');
    expect(run.latency_ms).toBeGreaterThanOrEqual(0);
    expect(run.memory_revision_hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('retries strict structured output once before accepting valid Zod data', async () => {
    const registry = new PromptRegistryService();
    registry.validateAll();
    let calls = 0;
    const gateway = {
      complete: vi.fn(async () => {
        calls += 1;
        return {
          content:
            calls === 1
              ? JSON.stringify({ title: '불완전' })
              : JSON.stringify({ title: '완전', direction: '주인공이 단서를 좇는다.', conflicts: [] }),
          toolCalls: [],
          usage: {},
          model: 'test',
        };
      }),
    };
    const runner = new ConcreteAiRunnerService(database, registry, gateway as never, { isConfigured: () => false } as never);
    const result = await runner.completeJson({
      task: 'episode_direction',
      promptId: 'episode-direction',
      variables: {
        project_context: '{}', writing_direction: '', canon: '[]', current_arc: 'null', current_scene: 'null', recent_summaries: '[]',
        open_foreshadowing: '[]', retrieved_memories: '[]', improvements: '[]', user_request: '다음 회차',
      },
      schema: { name: 'episode_direction', value: episodeDirectionSchema },
      validator: episodeDirectionValidator,
    });
    expect(result.value.direction).toContain('단서');
    expect(gateway.complete).toHaveBeenCalledTimes(2);
  });

  it('creates a complete episode plan from project context with no user request', async () => {
    const project = projects.createInternal({
      title: '밤의 기록',
      logline: '기억을 잃는 탐정이 황궁의 비밀을 추적한다.',
      genreTags: ['판타지'],
      writingDirection: '주인공의 1인칭 과거 시점을 유지한다.',
    });
    const proposal = { title: '첫 단서', direction: '탐정이 황궁에서 사라진 기록을 발견한다.', conflicts: [] };
    const completeJson = vi.fn().mockResolvedValue({ value: proposal });
    const service = new EpisodesService(database, projects, memory, { completeJson } as unknown as AiRunnerService);

    expect(await service.propose(project.id, {})).toEqual(proposal);
    expect(completeJson).toHaveBeenCalledWith(expect.objectContaining({
      task: 'episode_direction',
      projectId: project.id,
      variables: expect.objectContaining({
        user_request: '',
        project_context: expect.stringContaining(project.logline),
        writing_direction: project.writingDirection,
      }),
    }));
    expect(service.list(project.id)).toEqual([]);
  });

  it('reuses a deleted final episode number, hard deletes, and protects revisions', async () => {
    const project = projects.createInternal({
      title: '밤의 기록',
      logline: '기억을 잃는 탐정이 황궁의 비밀을 추적한다.',
      genreTags: ['판타지'],
    });
    const ai = {} as AiRunnerService;
    const service = new EpisodesService(database, projects, memory, ai);
    const first = await service.create(project.id, {
      title: '첫 단서',
      direction: '황궁에서 단서를 찾는다.',
      content: '첫 문단.\n\n둘째 문단.',
    });
    const second = await service.create(project.id, {
      title: '두 번째 단서',
      direction: '',
    });
    expect([first.number, second.number]).toEqual([1, 2]);

    await expect(
      service.update(project.id, first.id, {
        expectedRevision: 0,
        content: '충돌',
      }),
    ).rejects.toBeInstanceOf(ConflictException);

    const replaced = await service.replaceSelection(project.id, first.id, {
      expectedRevision: first.revision,
      start: 0,
      end: 4,
      selectedText: '첫 문단',
      replacement: '새 문단',
    });
    expect(replaced.episode.content).toBe('새 문단.\n\n둘째 문단.');
    expect(replaced.episode.revision).toBe(2);

    const forced = await service.update(project.id, first.id, {
      expectedRevision: replaced.episode.revision,
      content: replaced.episode.content,
      forceNeedsReview: true,
    });
    expect(forced.status).toBe('NEEDS_REVIEW');

    service.remove(project.id, second.id, { expectedRevision: second.revision });
    const third = await service.create(project.id, { title: '세 번째 단서', direction: '' });
    expect(third.number).toBe(2);
    const idempotent = await service.create(
      project.id,
      { title: '중복 방지', direction: '' },
      'generation-run-1',
    );
    const repeated = await service.create(
      project.id,
      { title: '중복 방지', direction: '' },
      'generation-run-1',
    );
    expect(repeated.id).toBe(idempotent.id);
    await expect(
      service.create(project.id, { title: '다른 요청', direction: '' }, 'generation-run-1'),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(database.orm.select().from(episodes).all().map((row) => row.number)).toEqual([1, 2, 3]);
  });

  it('blocks NEEDS_REVIEW finalization without changing the manuscript or memory', async () => {
    const project = projects.createInternal({
      title: '확정 차단',
      logline: '확정 설정과 모순되는 초안을 검사한다.',
      genreTags: ['판타지'],
    });
    const issue = {
      category: 'CANON',
      severity: 'BLOCKING',
      excerpt: '태양이 떠올랐다.',
      explanation: '해가 뜨지 않는 세계 규칙과 모순됩니다.',
      evidenceRefs: ['canon:night'],
      repairInstruction: '태양 묘사를 제거합니다.',
    } as const;
    const fakeAi = {
      completeJson: vi.fn(async () => ({ runId: 'review', value: { issues: [issue] } })),
      completeText: vi.fn(),
    };
    const service = new EpisodesService(database, projects, memory, fakeAi as never);
    const episode = await service.create(project.id, {
      title: '해 없는 날',
      direction: '영원한 밤을 건너간다.',
      content: '태양이 떠올랐다.',
      forceNeedsReview: true,
    });

    let caught: unknown;
    try {
      await service.finalize(project.id, episode.id, { expectedRevision: episode.revision });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(UnprocessableEntityException);
    expect((caught as UnprocessableEntityException).getResponse()).toMatchObject({
      code: 'CONTINUITY_BLOCKED',
      details: { issues: [issue] },
    });
    expect(service.get(project.id, episode.id)).toMatchObject({
      content: '태양이 떠올랐다.',
      revision: episode.revision,
      status: 'NEEDS_REVIEW',
      summary: null,
    });
    expect(fakeAi.completeJson).toHaveBeenCalledTimes(1);
    expect(fakeAi.completeText).not.toHaveBeenCalled();
    expect(
      (database.connection.prepare('SELECT count(*) AS count FROM scene_states').get() as { count: number }).count,
    ).toBe(0);
    expect(
      (database.connection.prepare('SELECT count(*) AS count FROM memory_chunks').get() as { count: number }).count,
    ).toBe(0);
  });

  it('allows warning-only review and makes same-revision CONFIRMED finalize idempotent', async () => {
    const project = projects.createInternal({
      title: '멱등 확정',
      logline: '반복 확정이 기억을 바꾸지 않는다.',
      genreTags: ['미스터리'],
    });
    const fakeAi = {
      completeJson: vi.fn(async (input: { task: string }) => {
        if (input.task === 'continuity_review') {
          return {
            runId: 'warning-review',
            value: {
              issues: [{
                category: 'SCENE', severity: 'WARNING', excerpt: '서쪽 성문',
                explanation: '성문 위치가 앞 문단의 동쪽과 다릅니다.', evidenceRefs: [],
                repairInstruction: '성문 위치를 동쪽으로 맞춥니다.',
              }],
            },
          };
        }
        return {
          runId: 'extract',
          value: {
            events: ['주인공이 문을 열었다.'],
            emotionalChanges: [{ character: '유나', from: '두려움', to: '결심', cause: '문을 열었다.' }],
            newForeshadowing: ['파란 열쇠'],
            resolvedForeshadowing: [],
            endScene: {
              location: '지하 성문', time: '새벽', pointOfView: '유나',
              characters: ['유나'], goal: '문 너머를 확인한다.',
            },
            canonCandidates: [],
          },
        };
      }),
    };
    const service = new EpisodesService(database, projects, memory, fakeAi as never);
    const episode = await service.create(project.id, {
      title: '파란 문',
      direction: '유나가 문을 연다.',
      content: '유나는 문을 열었다.',
      forceNeedsReview: true,
    });
    const confirmed = await service.finalize(project.id, episode.id, {
      expectedRevision: episode.revision,
    });
    expect(confirmed).toMatchObject({
      content: '유나는 문을 열었다.',
      status: 'CONFIRMED',
      summary: { sourceRevision: episode.revision },
    });
    const firstSummaryTimestamp = confirmed.summary?.updatedAt;
    const callsAfterFirstFinalize = fakeAi.completeJson.mock.calls.length;
    const replay = await service.finalize(project.id, episode.id, {
      expectedRevision: episode.revision,
    });
    expect(replay.summary?.updatedAt).toBe(firstSummaryTimestamp);
    expect(fakeAi.completeJson).toHaveBeenCalledTimes(callsAfterFirstFinalize);
    await memory.reindexProject(project.id);
    const summaryChunk = database.connection
      .prepare(
        "SELECT content FROM memory_chunks WHERE source_type = 'EPISODE_SUMMARY' AND source_id = ?",
      )
      .get(episode.id) as { content: string };
    expect(summaryChunk.content).toContain('유나: 두려움 → 결심');
  });

  it('indexes and returns hybrid memory without an external vector database', async () => {
    const project = projects.createInternal({
      title: '검색 테스트',
      logline: '황궁 암살 사건',
      genreTags: ['미스터리'],
    });
    insertCanonSource(project.id, 'canon-1', '윤서는 황궁 암살 사건의 유일한 목격자다.');
    await memory.indexSource({
      projectId: project.id,
      sourceType: 'CANON',
      sourceId: 'canon-1',
      text: '윤서는 황궁 암살 사건의 유일한 목격자다.',
    });
    const results = await memory.search(project.id, '황궁 암살');
    expect(results[0]).toMatchObject({ sourceType: 'CANON', sourceId: 'canon-1' });
    const semanticOnly = await memory.search(project.id, '전혀다른표현');
    expect(semanticOnly[0]).toMatchObject({ sourceType: 'CANON', sourceId: 'canon-1' });
  });

  it('filters later episode memories inside both retrieval queries', async () => {
    const project = projects.createInternal({
      title: '검색 경계',
      logline: '과거 시점에서 알 수 있는 사실만 쓴다.',
      genreTags: ['미스터리'],
    });
    const stamp = new Date().toISOString();
    for (const number of [1, 2, 3]) {
      database.orm.insert(episodes).values({
        id: `boundary-${number}`,
        projectId: project.id,
        number,
        title: `${number}화`,
        direction: '',
        content: '비밀 키워드',
        revision: 1,
        status: 'CONFIRMED',
        createdAt: stamp,
        updatedAt: stamp,
        deletedAt: null,
      }).run();
      await memory.indexSource({
        projectId: project.id,
        sourceType: 'EPISODE',
        sourceId: `boundary-${number}`,
        text: `${number}화에서 비밀 키워드를 발견했다.`,
      });
    }

    const results = await memory.search(project.id, '비밀 키워드', 12, 2);
    expect(results.map((item) => item.sourceId)).toEqual(['boundary-1']);
  });

  it('pre-filters vector KNN by project partition', async () => {
    const target = projects.createInternal({
      title: '대상', logline: '대상 기억', genreTags: ['판타지'],
    });
    const other = projects.createInternal({
      title: '다른 프로젝트', logline: '격리된 기억', genreTags: ['SF'],
    });
    for (let index = 0; index < 25; index += 1) {
      insertCanonSource(other.id, `other-${index}`, '서로다름');
      await memory.indexSource({
        projectId: other.id,
        sourceType: 'CANON',
        sourceId: `other-${index}`,
        text: '서로다름',
      });
    }
    insertCanonSource(target.id, 'target-only', '서로다름');
    await memory.indexSource({
      projectId: target.id,
      sourceType: 'CANON',
      sourceId: 'target-only',
      text: '서로다름',
    });

    const results = await memory.search(target.id, '의미질의');
    expect(results.map((item) => item.sourceId)).toContain('target-only');
    expect(results.some((item) => item.sourceId.startsWith('other-'))).toBe(false);
  });

  it('forces the title question and allows an optional AI question to be skipped', async () => {
    let turn = 0;
    const fakeAi = {
      completeText: vi.fn(async () => {
        turn += 1;
        if (turn === 1) {
          return {
            runId: 'run-1',
            result: {
              content: '',
              usage: {},
              model: 'test',
              toolCalls: [
                {
                  id: 'tool-1',
                  type: 'function',
                  function: {
                    name: 'ask_project_details',
                    arguments: JSON.stringify({
                      id: 'title',
                      field: 'title',
                      prompt: '작품의 제목을 알려주세요.',
                      inputType: 'text',
                      options: [],
                      required: true,
                      suggestedAnswer: '달 없는 밤',
                    }),
                  },
                },
              ],
            },
          };
        }
        if (turn === 2) {
          return {
            runId: 'run-2',
            result: {
              content: '', usage: {}, model: 'test',
              toolCalls: [{ id: 'tool-2', type: 'function', function: { name: 'ask_project_details', arguments: JSON.stringify({ id: 'tone', field: 'tone', prompt: '분위기는?', inputType: 'single', options: ['밝음', '어두움'], required: false, suggestedAnswer: '' }) } }],
            },
          };
        }
        return {
          runId: 'run-3',
          result: {
            content: '', usage: {}, model: 'test',
            toolCalls: [{ id: 'tool-3', type: 'function', function: { name: 'complete_project_interview', arguments: JSON.stringify({ confirmedFacts: [], assumptions: [] }) } }],
          },
        };
      }),
      completeJson: vi.fn(async (input) => input.task === 'arc_episode_directions' ? ({
        runId: 'directions',
        value: {
          episodeDirections: Array.from({ length: 5 }, (_, index) => ({
            episode: index + 1,
            title: `${index + 1}화`,
            direction: '달의 흔적을 향해 나아간다.',
          })),
        },
      }) : ({
        runId: 'blueprint',
        value: {
          title: '달 없는 밤',
          logline: '잃어버린 달을 찾는다.',
          genreTags: ['판타지'],
          writingDirection: '',
          defaultTargetChars: 5000,
          targetEpisode: 5,
          targetEpisodeSource: 'AI',
          canon: [],
          arcs: [{
            title: '달의 흔적',
            startEpisode: 1,
            endEpisode: 5,
            goal: '첫 흔적을 찾는다.',
            conflict: '추격자가 방해한다.',
            milestones: [{ episode: 5, type: 'GOAL', description: '첫 흔적을 찾는다.' }],
          }],
        },
      })),
    };
    const wizard = new ProjectWizardService(
      database,
      fakeAi as never,
      new ArcEpisodeDirectionsService(fakeAi as never),
      projects,
      memory,
    );
    const started = await wizard.start({
      logline: '잃어버린 달을 찾는다.',
      genreTags: ['판타지'],
    });
    expect(started.step).toMatchObject({
      type: 'question',
      question: { field: 'title', required: true },
    });
    const titleAnswered = await wizard.respond(started.session.id, {
      questionId: started.step.type === 'question' ? started.step.question.id : '',
      answer: '달 없는 밤',
    });
    expect(titleAnswered.step).toMatchObject({ type: 'question', question: { required: false } });
    const toneQuestion = await wizard.skip(started.session.id, {
      questionId: titleAnswered.step.type === 'question' ? titleAnswered.step.question.id : '',
    });
    const ready = await wizard.skip(started.session.id, {
      questionId: toneQuestion.step.type === 'question' ? toneQuestion.step.question.id : '',
    });
    expect(ready.step.type).toBe('ready');
    const committed = await wizard.commit(started.session.id);
    expect(committed.project.title).toBe('달 없는 밤');
    const replayed = await wizard.commit(started.session.id);
    expect(replayed.project.id).toBe(committed.project.id);
  });

  it('injects the latest fresh confirmed end scene into a new episode context', async () => {
    const project = projects.createInternal({
      title: '장면 기억',
      logline: '여정의 끝에서 새로운 문을 발견한다.',
      genreTags: ['판타지'],
    });
    const stamp = new Date().toISOString();
    database.orm.insert(episodes).values({
      id: 'episode-scene-1',
      projectId: project.id,
      number: 1,
      title: '문 앞에서',
      direction: '주인공이 문을 발견한다.',
      content: '소나기가 그쳐다.\n\n유나는 지하 성문의 손잡이를 붙잡았다.',
      revision: 1,
      status: 'CONFIRMED',
      createdAt: stamp,
      updatedAt: stamp,
      deletedAt: null,
    }).run();
    database.orm.insert(sceneStates).values({
      episodeId: 'episode-scene-1',
      location: '지하 성문',
      storyTime: '새벽',
      pointOfView: '유나',
      characterNamesJson: JSON.stringify(['유나']),
      goal: '문을 연다',
      sourceRevision: 1,
      updatedAt: stamp,
    }).run();

    const context = await memory.assemble(project.id, '');
    expect(JSON.parse(context.currentScene)).toMatchObject({
      location: '지하 성문',
      time: '새벽',
      previousParagraph: '유나는 지하 성문의 손잡이를 붙잡았다.',
    });
    expect(embeddingGateway.embeddings).toHaveBeenCalledWith([
      expect.stringContaining('여정의 끝에서 새로운 문을 발견한다.'),
    ]);
  });

  it('uses the cursor-relative previous paragraph for continuation scene context', async () => {
    const project = projects.createInternal({
      title: '커서 장면', logline: '원고 중간에 새 문장을 넣는다.', genreTags: ['판타지'],
    });
    const content = '첫 문단의 끝.\n\n원고 마지막 문단.';
    const fakeAi = {
      streamText: vi.fn(async (
        _input: unknown,
        onDelta: (text: string) => void,
        onRunStarted?: (runId: string) => void,
      ) => {
        onRunStarted?.('continue-run');
        onDelta('삽입 문장');
        return {
          runId: 'continue-run',
          result: { content: '삽입 문장', toolCalls: [], usage: {}, model: 'test' },
        };
      }),
      completeJson: vi.fn(async () => ({ runId: 'review', value: { issues: [] } })),
    };
    const service = new EpisodesService(database, projects, memory, fakeAi as never);
    const episode = await service.create(project.id, {
      title: '중간 삽입', direction: '첫 문단 뒤를 잇는다.', content,
    });
    const stamp = new Date().toISOString();
    database.orm.insert(sceneStates).values({
      episodeId: episode.id,
      location: '성문', storyTime: '밤', pointOfView: '유나',
      characterNamesJson: JSON.stringify(['유나']), goal: '성문을 지킨다.',
      sourceRevision: episode.revision, updatedAt: stamp,
    }).run();
    const cursorOffset = content.indexOf('\n\n');
    await service.continue(
      project.id,
      episode.id,
      { expectedRevision: episode.revision, cursorOffset },
      () => undefined,
    );
    const writingInput = fakeAi.streamText.mock.calls[0]?.[0] as {
      variables: { current_scene: string };
    };
    expect(JSON.parse(writingInput.variables.current_scene)).toMatchObject({
      previousParagraph: '첫 문단의 끝.',
    });
  });

  it('persists only accepted improvement candidates with deterministic scope', async () => {
    const fakeAi = {
      completeJson: vi.fn(async () => ({
        runId: 'candidate-run',
        value: {
          candidates: [
            {
              title: '감정을 행동으로 표현',
              rule: '감정을 직접 선언하지 말고 행동으로 보여준다.',
              rationale: '몰입도가 높아진다.',
              category: 'STYLE',
              tags: ['감정'],
              beforeExample: '그는 슬펐다.',
              afterExample: '그는 빈 의자를 오래 바라봤다.',
              confidence: 0.9,
              duplicateOfId: null,
              conflictsWithIds: [],
            },
          ],
        },
      })),
    };
    const service = new ImprovementsService(database, fakeAi as never, memory);
    const proposed = await service.candidates({
      source: 'COMPARISON',
      original: '그는 슬펐다.',
      revised: '그는 빈 의자를 오래 바라봤다.',
    });
    expect(service.list()).toHaveLength(0);
    await expect(
      service.batch({
        candidates: [
          ...proposed.candidates,
          { ...proposed.candidates[0], confidence: 2 },
        ],
      }),
    ).rejects.toThrow('confidence');
    expect(service.list()).toHaveLength(0);
    const accepted = await service.batch(
      { candidates: proposed.candidates },
      'accepted-candidates-1',
    );
    expect(accepted.improvements[0]).toMatchObject({ scope: 'GLOBAL', source: 'COMPARISON' });
    const replay = await service.batch(
      { candidates: proposed.candidates },
      'accepted-candidates-1',
    );
    expect(replay).toEqual(accepted);
    expect(service.list()).toHaveLength(1);
    await expect(memory.reindexGlobalImprovements()).resolves.toMatchObject({ indexed: 1 });
    await expect(
      service.batch(
        { candidates: [{ ...proposed.candidates[0], title: '다른 후보' }] },
        'accepted-candidates-1',
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});
