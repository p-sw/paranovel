import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AiRunnerService } from '../src/ai/ai-runner.service';
import type { CompletionRequest, CompletionResult, ToolCall } from '../src/ai/ai.types';
import { TavilySearchService } from '../src/ai/tavily-search.service';
import { DatabaseService } from '../src/database/database.service';
import { generateAnimeImageTool, highlightPlanValidator, type HighlightPlan } from '../src/highlights/highlight.schemas';
import { PromptRegistryService } from '../src/prompts/prompt-registry.service';

const plan: HighlightPlan = {
  afterParagraphId: 2,
  altText: '은빛 머리의 서아가 달빛 아래 푸른 검을 들어 올린다.',
  prompt: 'Seo-a raises a blue sword beneath the moon. Silver hair, amber eyes, warm tan skin, a dark blue coat and a jade earring. Wide composition.',
  orientation: 'landscape',
  allowNSFW: false,
};
const paragraphs = [
  { id: 1, text: '서아는 닫힌 성문 앞으로 걸어갔다.' },
  { id: 2, text: '달이 떠오르자 서아가 푸른 검을 들었다. 🌙' },
];
const approvedCanon = [{
  ref: 'canon:appearance-1', revision: 4, category: 'CHARACTER_APPEARANCE', name: '서아',
  aliases: ['서아 장군'], content: '은빛 머리, 호박색 눈동자, 따뜻한 갈색 피부, 남색 외투, 옥 귀걸이.',
}];

function call(value: unknown = plan, name = 'generate_anime_image'): ToolCall {
  return { id: 'tool-highlight-1', type: 'function', function: { name, arguments: JSON.stringify(value) } };
}

function completion(toolCalls: ToolCall[], promptTokens = 10, completionTokens = 2): CompletionResult {
  return { content: '', toolCalls, model: 'selected-writing-model', usage: { promptTokens, completionTokens } };
}

interface RunRecord {
  id: string;
  task: string;
  project_id: string;
  episode_id: string;
  model: string;
  status: string;
  error: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  latency_ms: number;
  prompt_refs_json: string;
  memory_revision_hash: string;
  context_hash: string;
  completed_at: string | null;
}

describe('highlight planning tool workflow', () => {
  let database: DatabaseService;
  let registry: PromptRegistryService;
  let tavily: TavilySearchService;
  let runner: AiRunnerService;
  const gateway = { complete: vi.fn<(request: CompletionRequest) => Promise<CompletionResult>>() };

  beforeEach(() => {
    vi.stubEnv('DB_PATH', ':memory:');
    vi.stubEnv('OPENROUTER_EMBEDDING_DIMENSIONS', '4');
    // A configured search provider must still not receive image-planning canon.
    vi.stubEnv('TAVILY_API_KEY', 'tvly-unused-secret');
    vi.stubEnv('AI_WRITING_MODEL', 'configured-writing-model');
    database = new DatabaseService();
    database.connection.prepare("INSERT INTO projects(id, title, logline, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run('project-highlight', '달빛의 문', '성문 앞의 마지막 밤', '2026-09-06', '2026-09-06');
    database.connection.prepare("INSERT INTO episodes(id, project_id, number, title, direction, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run('episode-highlight', 'project-highlight', 1, '떠오르는 달', '성문을 지키는 서아', paragraphs.map(({ text }) => text).join('\n\n'), '2026-09-06', '2026-09-06');
    registry = new PromptRegistryService();
    tavily = new TavilySearchService();
    vi.spyOn(tavily, 'search');
    gateway.complete.mockReset();
    runner = new AiRunnerService(database, registry, gateway as never, tavily);
  });

  afterEach(() => {
    database.onApplicationShutdown();
    vi.unstubAllEnvs();
  });

  function input() {
    return {
      task: 'episode_highlight', promptId: 'episode-highlight',
      projectId: 'project-highlight', episodeId: 'episode-highlight',
      variables: {
        project_context: { title: '달빛의 문', logline: '성문 앞의 마지막 밤', genreTags: ['판타지'], details: '동양풍 판타지' },
        canon: approvedCanon, episode_title: '떠오르는 달', episode_direction: '성문을 지키는 서아',
        episode_paragraphs: paragraphs,
      },
      tool: generateAnimeImageTool,
      validator: highlightPlanValidator,
      validateValue: (value: HighlightPlan) => paragraphs.some(({ id }) => id === value.afterParagraphId),
      maxTokens: 3_000,
    };
  }

  function runs(): RunRecord[] {
    return database.connection.prepare('SELECT * FROM ai_runs ORDER BY rowid').all() as RunRecord[];
  }

  it('requires the single image tool, renders approved appearance canon and preserves model-selected arguments', async () => {
    gateway.complete.mockResolvedValue(completion([call()]));
    const result = await runner.completeTool(input());
    expect(result.value).toEqual(plan);
    expect(gateway.complete).toHaveBeenCalledTimes(1);
    expect(tavily.search).not.toHaveBeenCalled();
    const request = gateway.complete.mock.calls[0]![0];
    expect(request).toMatchObject({
      model: 'configured-writing-model', tools: [generateAnimeImageTool], toolChoice: 'required', maxTokens: 3_000,
    });
    expect(request.tools).toHaveLength(1);
    expect(request.schema).toBeUndefined();
    const userMessage = request.messages.find(({ role }) => role === 'user')!.content!;
    expect(userMessage).toContain(approvedCanon[0]!.content);
    expect(userMessage).toContain(approvedCanon[0]!.ref);
    expect(userMessage).toContain('CHARACTER_APPEARANCE');
    expect(userMessage).toContain(paragraphs[1]!.text);
    expect(userMessage).toContain('동양풍 판타지');
    expect(userMessage).toContain('성문을 지키는 서아');
    expect(JSON.stringify(request)).not.toContain('tvly-unused-secret');

    expect(runs()).toHaveLength(1);
    const record = runs()[0]!;
    expect(record).toMatchObject({
      id: result.runId, task: 'episode_highlight', project_id: 'project-highlight', episode_id: 'episode-highlight',
      model: 'selected-writing-model', status: 'SUCCEEDED', error: null, input_tokens: 10, output_tokens: 2,
    });
    expect(record.latency_ms).toBeGreaterThanOrEqual(0);
    expect(record.completed_at).toEqual(expect.any(String));
    expect(record.memory_revision_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(record.context_hash).toMatch(/^[a-f0-9]{64}$/);
    const refs = JSON.parse(record.prompt_refs_json).map((ref: { id: string }) => ref.id);
    expect(refs).toContain('episode-highlight');
    expect(refs).toContain('memory-contract');
    expect(refs).not.toContain('reference-tools');
    expect(refs).not.toContain('reference-research');
  });

  it.each([
    ['unknown tool name', [call(plan, 'tavily_search')]],
    ['multiple tool calls', [call(), { ...call(), id: 'tool-highlight-2' }]],
    ['nonexistent paragraph', [call({ ...plan, afterParagraphId: 3 })]],
    ['non-tool answer', []],
    ['malformed JSON', [{ ...call(), function: { name: 'generate_anime_image', arguments: '{invalid' } }]],
    ['provider option override', [call({ ...plan, model: 'anime' })]],
    ['oversized prompt', [call({ ...plan, prompt: '가'.repeat(1_001) })]],
  ] satisfies Array<[string, ToolCall[]]>)('allows exactly one planning retry after %s', async (_label, invalidCalls) => {
    gateway.complete.mockResolvedValueOnce(completion(invalidCalls, 10, 2))
      .mockResolvedValueOnce(completion([call()], 20, 4));
    const result = await runner.completeTool(input());
    expect(result.value).toEqual(plan);
    expect(gateway.complete).toHaveBeenCalledTimes(2);
    expect(gateway.complete.mock.calls[1]![0]).toEqual(gateway.complete.mock.calls[0]![0]);
    expect(tavily.search).not.toHaveBeenCalled();
    expect(runs()).toHaveLength(1);
    expect(runs()[0]).toMatchObject({ id: result.runId, status: 'SUCCEEDED', input_tokens: 30, output_tokens: 6, error: null });
  });

  it('records failure after two invalid plans without returning an executable value', async () => {
    gateway.complete.mockResolvedValueOnce(completion([call({ ...plan, afterParagraphId: 999 })]))
      .mockResolvedValueOnce(completion([call(plan, 'unexpected_tool')]));
    await expect(runner.completeTool(input())).rejects.toMatchObject({
      status: 502, message: 'AI가 올바른 이미지 생성 계획을 반환하지 못했습니다.',
    });
    expect(gateway.complete).toHaveBeenCalledTimes(2);
    expect(tavily.search).not.toHaveBeenCalled();
    expect(runs()).toHaveLength(1);
    expect(runs()[0]).toMatchObject({
      status: 'FAILED', error: 'AI가 올바른 이미지 생성 계획을 반환하지 못했습니다.', completed_at: expect.any(String),
    });
  });

  it('sanitizes gateway failures before persisting their audit error and does not retry transport errors', async () => {
    gateway.complete.mockRejectedValue(new Error('Provider echoed Authorization: Bearer private-provider-secret'));
    const error = await runner.completeTool(input()).catch((failure: Error) => failure);
    expect(error).toMatchObject({ status: 502, message: '이미지 장면 분석 요청을 처리하지 못했습니다.' });
    expect(JSON.stringify(error)).not.toContain('private-provider-secret');
    expect(gateway.complete).toHaveBeenCalledTimes(1);
    expect(tavily.search).not.toHaveBeenCalled();
    expect(runs()).toHaveLength(1);
    expect(runs()[0]).toMatchObject({ status: 'FAILED', error: '이미지 장면 분석 요청을 처리하지 못했습니다.' });
    expect(JSON.stringify(runs())).not.toContain('private-provider-secret');
  });
});
