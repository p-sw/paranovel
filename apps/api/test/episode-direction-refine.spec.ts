import { BadRequestException, NotFoundException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AiRunnerService } from '../src/ai/ai-runner.service';
import { episodeDirectionSchema, episodeDirectionValidator } from '../src/ai/ai.schemas';
import { DatabaseService } from '../src/database/database.service';
import { EpisodesService } from '../src/episodes/episodes.service';
import { PromptRegistryService } from '../src/prompts/prompt-registry.service';
import { ProjectsService } from '../src/projects/projects.service';

const input = {
  title: '문 앞에서',
  direction: '\n  기록관이 닫힌 문을 연다.\n\n문 너머의 동료와 마주한다.\n',
  instruction: '동료와 마주하는 마지막 장면만 더 긴장되게 고쳐줘.',
};
const refined = {
  title: input.title,
  direction: '\n  기록관이 닫힌 문을 연다.\n\n문 너머의 동료가 검을 겨눈다.\n',
  conflicts: [] as string[],
};

describe('iterative episode direction refinement', () => {
  let database: DatabaseService;
  let projects: ProjectsService;
  let projectId: string;

  beforeEach(() => {
    vi.stubEnv('DB_PATH', ':memory:');
    vi.stubEnv('OPENROUTER_EMBEDDING_DIMENSIONS', '4');
    database = new DatabaseService();
    projects = new ProjectsService(database);
    projectId = projects.createInternal({ title: '기록관', logline: '잊힌 문을 찾는 기록관', genreTags: ['판타지'] }).id;
  });

  afterEach(() => {
    database.onApplicationShutdown();
    vi.unstubAllEnvs();
  });

  function fixture() {
    const memory = {
      assemble: vi.fn(async () => ({
        projectContext: '{"title":"기록관"}', canon: '["오른손 부상"]',
        currentArc: '{"goal":"닫힌 문의 비밀을 밝힌다."}',
        currentScene: '{"location":"문 앞"}', recentSummaries: '["닫힌 문에 도착했다."]',
        openForeshadowing: '["문의 문양"]', retrievedMemories: '["오랜 동료"]',
        improvements: '["짧은 문장"]',
      })),
    };
    const ai = { completeJson: vi.fn(async (_input: unknown) => ({ value: refined })) };
    const service = new EpisodesService(database, projects, memory as never, ai as never);
    return { service, memory, ai };
  }

  it('refines the exact current plan with the instruction and complete project memory without saving an episode', async () => {
    const { service, memory, ai } = fixture();
    const existing = await service.create(projectId, { title: '기존 회차', direction: '이미 쓴 회차', content: '문 앞에 도착했다.' });
    const projectBefore = projects.get(projectId);

    expect(await service.refine(projectId, input)).toEqual(refined);

    expect(memory.assemble).toHaveBeenCalledWith(projectId, `${input.instruction}\n${input.title}\n${input.direction}`);
    expect(ai.completeJson).toHaveBeenCalledWith(expect.objectContaining({
      task: 'episode_direction_refine', promptId: 'episode-direction-refine', projectId,
      variables: {
        project_context: '{"title":"기록관"}', canon: '["오른손 부상"]',
        current_arc: '{"goal":"닫힌 문의 비밀을 밝힌다."}',
        current_scene: '{"location":"문 앞"}', recent_summaries: '["닫힌 문에 도착했다."]',
        open_foreshadowing: '["문의 문양"]', retrieved_memories: '["오랜 동료"]',
        improvements: '["짧은 문장"]', episode_title: input.title,
        episode_direction: input.direction, refinement_instruction: input.instruction,
      },
      schema: { name: 'episode_direction', value: episodeDirectionSchema },
      validator: episodeDirectionValidator,
    }));
    expect(service.list(projectId)).toEqual([existing]);
    expect(projects.get(projectId)).toEqual(projectBefore);
  });

  it('uses the latest refinement and manual edits on each successive request', async () => {
    const { service, memory, ai } = fixture();
    const first = await service.refine(projectId, input);
    const nextInput = {
      title: '  사용자가 고친 제목  ',
      direction: `${first.direction}\n  동료의 손에 오래된 상처가 있다.\n`,
      instruction: '  제목만 더 짧게 다듬어줘.  ',
    };
    const nextResult = { title: '오래된 상처', direction: nextInput.direction, conflicts: ['기존 상처의 위치는 Canon을 확인해야 합니다.'] };
    ai.completeJson.mockResolvedValueOnce({ value: nextResult });

    expect(await service.refine(projectId, nextInput)).toEqual(nextResult);

    expect(ai.completeJson).toHaveBeenLastCalledWith(expect.objectContaining({
      variables: expect.objectContaining({
        episode_title: nextInput.title, episode_direction: nextInput.direction,
        refinement_instruction: nextInput.instruction.trim(),
      }),
    }));
    expect(memory.assemble).toHaveBeenLastCalledWith(projectId, `${nextInput.instruction.trim()}\n${nextInput.title}\n${nextInput.direction}`);
    expect(service.list(projectId)).toEqual([]);
  });

  const fields = [
    { field: 'title', max: 200 },
    { field: 'direction', max: 20_000 },
    { field: 'instruction', max: 5_000 },
  ];
  const invalidInputs = fields.flatMap(({ field, max }) => [
    { field, kind: 'missing', value: undefined },
    { field, kind: 'null', value: null },
    { field, kind: 'not a string', value: 42 },
    { field, kind: 'empty', value: '' },
    { field, kind: 'whitespace', value: ' \n ' },
    { field, kind: 'too long', value: '가'.repeat(max + 1) },
    { field, kind: 'too long including whitespace', value: `${'가'.repeat(max)} ` },
  ]);

  it.each(invalidInputs)('rejects $field that is $kind before memory or AI work', async ({ field, value }) => {
    const { service, memory, ai } = fixture();

    await expect(service.refine(projectId, { ...input, [field]: value })).rejects.toBeInstanceOf(BadRequestException);

    expect(memory.assemble).not.toHaveBeenCalled();
    expect(ai.completeJson).not.toHaveBeenCalled();
  });

  it('requires an existing project before memory or AI work', async () => {
    const { service, memory, ai } = fixture();

    await expect(service.refine('missing-project', input)).rejects.toBeInstanceOf(NotFoundException);

    expect(memory.assemble).not.toHaveBeenCalled();
    expect(ai.completeJson).not.toHaveBeenCalled();
  });

  it('accepts input at the field limits and gives a long plan room to be returned in full', async () => {
    const { service, ai } = fixture();
    const longPlan = { title: '가'.repeat(200), direction: '나'.repeat(20_000), instruction: '다'.repeat(5_000) };

    await service.refine(projectId, longPlan);

    expect(ai.completeJson).toHaveBeenCalledWith(expect.objectContaining({
      variables: expect.objectContaining({ episode_title: longPlan.title, episode_direction: longPlan.direction }),
      maxTokens: expect.any(Number),
    }));
    expect((ai.completeJson.mock.calls[0]![0] as { maxTokens: number }).maxTokens).toBeGreaterThan(20_000);
  });

  it.each([
    { field: 'title', value: '가'.repeat(201), kind: 'oversized' },
    { field: 'direction', value: '나'.repeat(20_001), kind: 'oversized' },
    { field: 'title', value: ' \n', kind: 'blank' },
    { field: 'direction', value: ' \n', kind: 'blank' },
  ])('rejects $kind AI $field through the runner, preserving the current plan for retry', async ({ field, value }) => {
    const { memory } = fixture();
    const gateway = {
      complete: vi.fn(async () => ({
        content: JSON.stringify({ ...refined, [field]: value }),
        toolCalls: [], usage: {}, model: 'test',
      })),
    };
    const runner = new AiRunnerService(database, new PromptRegistryService(), gateway as never, { isConfigured: () => false } as never);
    const service = new EpisodesService(database, projects, memory as never, runner);

    await expect(service.refine(projectId, input)).rejects.toThrow('invalid structured output');

    expect(gateway.complete).toHaveBeenCalledTimes(2);
    expect(service.list(projectId)).toEqual([]);
  });
});
