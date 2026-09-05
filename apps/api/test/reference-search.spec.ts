import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AiRunnerService } from '../src/ai/ai-runner.service';
import { episodeDirectionSchema, episodeDirectionValidator, projectInterviewTools } from '../src/ai/ai.schemas';
import type { CompletionRequest, CompletionResult, PromptRunInput, ToolCall } from '../src/ai/ai.types';
import { OpenRouterGateway } from '../src/ai/openrouter.gateway';
import { TavilySearchService } from '../src/ai/tavily-search.service';
import { DatabaseService } from '../src/database/database.service';
import { PromptRegistryService, type PromptId } from '../src/prompts/prompt-registry.service';

const source = {
  title: '인정과 파루',
  url: 'https://example.org/history',
  content: '인정과 파루는 밤의 통행 제한과 해제를 알렸다.',
  score: 0.9,
};
const searchArgs = { query: '조선 후기 한양 인정 파루', search_depth: 'basic', max_results: 3 };
const searchCall = (id = 'search-1'): ToolCall => ({
  id,
  type: 'function',
  function: { name: 'tavily_search', arguments: JSON.stringify(searchArgs) },
});
const completion = (content: string, toolCalls: ToolCall[] = []): CompletionResult => ({
  content, toolCalls, model: 'test-model', usage: { promptTokens: 10, completionTokens: 2 },
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('Tavily reference search', () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.stubEnv('TAVILY_API_KEY', 'tvly-test-secret');
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });

  it('sends only validated search parameters and bounds excerpts and results', async () => {
    fetchMock.mockResolvedValue(Response.json({
      results: Array.from({ length: 6 }, () => ({ ...source, content: '가'.repeat(3_000) })),
      answer: 'unused answer',
    }));
    const result = await new TavilySearchService().search(JSON.stringify(searchArgs));

    expect(fetchMock).toHaveBeenCalledWith('https://api.tavily.com/search', expect.objectContaining({
      method: 'POST',
      headers: { Authorization: 'Bearer tvly-test-secret', 'Content-Type': 'application/json' },
      signal: expect.any(AbortSignal),
    }));
    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
    expect(body).toEqual({
      ...searchArgs, topic: 'general', auto_parameters: false,
      include_answer: false, include_raw_content: false, include_images: false,
    });
    expect(result.results).toHaveLength(3);
    expect(result.results[0]).toEqual({ ...source, content: '가'.repeat(2_000) });
    expect(JSON.stringify(result)).not.toContain('tvly-test-secret');
  });

  it.each([
    '{broken', 'null', '{"query":" "}', '{"query":"history","max_results":6}',
    '{"query":"history","search_depth":"unsupported"}',
    '{"query":"history","api_key":"injected"}',
    JSON.stringify({ query: 'a'.repeat(401) }),
  ])('rejects invalid tool arguments without a network call: %s', async (args) => {
    expect(await new TavilySearchService().search(args)).toEqual({
      results: [], error: { code: 'INVALID_ARGUMENTS' },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('disables search when the key is missing', async () => {
    vi.stubEnv('TAVILY_API_KEY', ' ');
    const service = new TavilySearchService();
    expect(service.isConfigured()).toBe(false);
    expect(await service.search(JSON.stringify(searchArgs))).toEqual({
      results: [], error: { code: 'NOT_CONFIGURED' },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([401, 429, 432, 500])('returns a sanitized error for upstream status %s', async (status) => {
    fetchMock.mockResolvedValue(Response.json({ detail: 'tvly-test-secret' }, { status }));
    expect(await new TavilySearchService().search(JSON.stringify(searchArgs))).toEqual({
      query: searchArgs.query, results: [], error: { code: 'UPSTREAM_ERROR', status },
    });
  });

  it('accepts empty results and rejects malformed responses', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ results: [] }))
      .mockResolvedValueOnce(new Response('not json'))
      .mockResolvedValueOnce(Response.json({ results: [{ ...source, url: 'javascript:alert(1)' }] }));
    const service = new TavilySearchService();
    expect(await service.search(JSON.stringify(searchArgs))).toEqual({ query: searchArgs.query, results: [] });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect(await service.search(JSON.stringify(searchArgs))).toMatchObject({
        results: [], error: { code: 'INVALID_RESPONSE' },
      });
    }
  });

  it('sanitizes network failures', async () => {
    fetchMock.mockRejectedValue(new Error('request contained tvly-test-secret'));
    expect(await new TavilySearchService().search(JSON.stringify(searchArgs))).toMatchObject({
      results: [], error: { code: 'NETWORK_ERROR' },
    });
  });

  it('times out a pending search but propagates user cancellation', async () => {
    const timeout = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal);
    fetchMock.mockImplementation(async (_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true });
    }));
    const service = new TavilySearchService();
    const pendingTimeout = service.search(JSON.stringify(searchArgs));
    timeout.abort(new DOMException('Timed out', 'TimeoutError'));
    expect(await pendingTimeout).toMatchObject({ results: [], error: { code: 'TIMEOUT' } });

    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(new AbortController().signal);
    const cancellation = new AbortController();
    const pendingCancellation = service.search(JSON.stringify(searchArgs), cancellation.signal);
    cancellation.abort(new DOMException('Cancelled', 'AbortError'));
    await expect(pendingCancellation).rejects.toMatchObject({ name: 'AbortError' });
    await expect(service.search(JSON.stringify(searchArgs), cancellation.signal))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('LLM reference workflow', () => {
  let database: DatabaseService;
  let registry: PromptRegistryService;
  let tavily: TavilySearchService;

  beforeEach(() => {
    vi.stubEnv('DB_PATH', ':memory:');
    vi.stubEnv('OPENROUTER_EMBEDDING_DIMENSIONS', '4');
    vi.stubEnv('TAVILY_API_KEY', 'tvly-test-secret');
    database = new DatabaseService();
    registry = new PromptRegistryService();
    tavily = new TavilySearchService();
  });

  afterEach(() => database.onApplicationShutdown());

  function input(promptId: PromptId = 'episode-draft'): PromptRunInput {
    return {
      task: promptId,
      promptId,
      variables: Object.fromEntries(registry.get(promptId).requiredVariables.map((key) => [key, key === 'canon' ? 'PRIVATE_CANON' : '작품 자료'])),
    };
  }

  function runRecord() {
    return database.connection.prepare('SELECT status, input_tokens, output_tokens, prompt_refs_json FROM ai_runs').get() as {
      status: string; input_tokens: number; output_tokens: number; prompt_refs_json: string;
    };
  }

  it('executes model-selected Tavily calls and streams only the final prose over OpenRouter', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'router-test-secret');
    vi.stubEnv('OPENROUTER_BASE_URL', 'https://openrouter.ai/api/v1');
    const requests: Array<Record<string, unknown>> = [];
    const call = { ...searchCall(), extra_content: { google: { thought_signature: 'signed-tool' } } };
    const reasoning = [{ type: 'reasoning.encrypted', data: 'signed-reasoning', index: 0 }];
    let searchCount = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      if (url === 'https://api.tavily.com/search') {
        searchCount += 1;
        expect(body.query).toBe(searchArgs.query);
        expect(init.body).not.toContain('PRIVATE_CANON');
        expect(init.body).not.toContain('router-test-secret');
        return Response.json({ results: [source] });
      }
      expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
      requests.push(body);
      if (requests.length === 1) {
        return Response.json({
          choices: [{ message: { role: 'assistant', content: null, tool_calls: [call], reasoning_details: reasoning } }],
          usage: { prompt_tokens: 10, completion_tokens: 4 },
        });
      }
      if (requests.length === 2) {
        return Response.json({
          choices: [{ message: { content: 'DONE' } }],
          usage: { prompt_tokens: 20, completion_tokens: 2 },
        });
      }
      const events = [
        { choices: [{ delta: { content: '종이 울렸다. ' } }] },
        { choices: [{ delta: { content: '그는 걸음을 멈췄다.' } }] },
        { usage: { prompt_tokens: 30, completion_tokens: 6 } },
      ];
      return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n');
    }));
    const runner = new AiRunnerService(database, registry, new OpenRouterGateway(), tavily);
    const onDelta = vi.fn();
    const started = vi.fn();
    const { runId, result } = await runner.streamText(input(), onDelta, started);

    expect(searchCount).toBe(1);
    expect(requests).toHaveLength(3);
    expect(requests[0]).toMatchObject({
      stream: false, tool_choice: 'auto', tools: [{ function: { name: 'tavily_search' } }],
    });
    expect(requests[0]).not.toHaveProperty('response_format');
    expect(requests[1]!.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'assistant', tool_calls: [call], reasoning_details: reasoning }),
      expect.objectContaining({ role: 'tool', tool_call_id: call.id, content: expect.stringContaining(source.url) }),
    ]));
    expect(requests[2]).toMatchObject({ stream: true });
    expect(requests[2]).not.toHaveProperty('tools');
    expect(JSON.stringify(requests[2]!.messages)).toContain('tavily_references');
    expect(JSON.stringify(requests[2]!.messages)).toContain(source.url);
    expect(JSON.stringify(requests[2]!.messages)).not.toContain('signed-reasoning');
    expect(onDelta.mock.calls).toEqual([['종이 울렸다. '], ['그는 걸음을 멈췄다.']]);
    expect(started).toHaveBeenCalledWith(runId);
    expect(result.content).toBe('종이 울렸다. 그는 걸음을 멈췄다.');
    expect(runRecord()).toMatchObject({ status: 'SUCCEEDED', input_tokens: 60, output_tokens: 12 });
    expect(JSON.parse(runRecord().prompt_refs_json).map((ref: { id: string }) => ref.id))
      .toEqual(expect.arrayContaining(['reference-tools', 'reference-research', 'episode-draft']));
  });

  it('finishes research before JSON validation and reuses references when retrying output', async () => {
    const search = vi.spyOn(tavily, 'search').mockResolvedValue({ query: searchArgs.query, results: [source] });
    const valid = { title: '닫힌 문', direction: '종소리에 주인공이 멈춘다.', conflicts: [] };
    const gateway = { complete: vi.fn<(request: CompletionRequest) => Promise<CompletionResult>>()
      .mockResolvedValueOnce(completion('', [searchCall()]))
      .mockResolvedValueOnce(completion('DONE'))
      .mockResolvedValueOnce(completion('{"title":"불완전"}'))
      .mockResolvedValueOnce(completion(JSON.stringify(valid))) };
    const runner = new AiRunnerService(database, registry, gateway as never, tavily);
    const { value } = await runner.completeJson({
      ...input('episode-direction'),
      schema: { name: 'episode_direction', value: episodeDirectionSchema },
      validator: episodeDirectionValidator,
    });

    expect(value).toEqual(valid);
    expect(search).toHaveBeenCalledTimes(1);
    expect(gateway.complete).toHaveBeenCalledTimes(4);
    expect(gateway.complete.mock.calls[0]![0].schema).toBeUndefined();
    const finalRequest = gateway.complete.mock.calls[2]![0];
    expect(finalRequest.schema?.name).toBe('episode_direction');
    expect(JSON.stringify(finalRequest.messages)).toContain(source.url);
    expect(gateway.complete.mock.calls[3]![0]).toEqual(finalRequest);
    expect(runRecord()).toMatchObject({ status: 'SUCCEEDED', input_tokens: 40, output_tokens: 8 });
  });

  it('lets the LLM skip unnecessary search, including when the core prompt is excluded', async () => {
    const search = vi.spyOn(tavily, 'search');
    const gateway = { complete: vi.fn().mockResolvedValueOnce(completion('DONE')).mockResolvedValueOnce(completion('청사진')) };
    const runner = new AiRunnerService(database, registry, gateway as never, tavily);
    const { result } = await runner.completeText({ ...input('project-blueprint'), includeCore: false, includeMemoryContract: false });

    expect(search).not.toHaveBeenCalled();
    expect(result.content).toBe('청사진');
    expect(gateway.complete).toHaveBeenCalledTimes(2);
    const request = gateway.complete.mock.calls[1]![0] as CompletionRequest;
    expect(request.messages).toHaveLength(2);
    expect(request.messages[0]!.content).toContain('tavily_search');
    expect(runRecord().prompt_refs_json).not.toContain('novelist-core');
  });

  it('keeps the existing generation path when the key is absent', async () => {
    vi.stubEnv('TAVILY_API_KEY', '');
    const gateway = { complete: vi.fn().mockResolvedValue(completion('본문')) };
    const runner = new AiRunnerService(database, registry, gateway as never, new TavilySearchService());
    await runner.completeText(input());

    expect(gateway.complete).toHaveBeenCalledTimes(1);
    expect(gateway.complete.mock.calls[0]![0].tools).toBeUndefined();
    expect(runRecord().prompt_refs_json).not.toContain('reference-tools');
  });

  it.each(['project-interview', 'scene-extract', 'episode-memory-extract', 'continuity-review', 'continuity-repair', 'improvement-extract'] as const)(
    'preserves the existing %s tool and source contract', async (promptId) => {
      const search = vi.spyOn(tavily, 'search');
      const toolCalls: ToolCall[] = promptId === 'project-interview'
        ? [{ id: 'question-1', type: 'function', function: { name: 'ask_project_details', arguments: '{}' } }] : [];
      const gateway = { complete: vi.fn().mockResolvedValue(completion('result', toolCalls)) };
      const runner = new AiRunnerService(database, registry, gateway as never, tavily);
      const request = input(promptId);
      if (promptId === 'project-interview') {
        request.tools = projectInterviewTools;
        request.toolChoice = 'required';
      }
      const { result } = await runner.completeText(request);

      expect(search).not.toHaveBeenCalled();
      expect(gateway.complete).toHaveBeenCalledTimes(1);
      expect(gateway.complete.mock.calls[0]![0].tools).toEqual(request.tools);
      expect(gateway.complete.mock.calls[0]![0].toolChoice).toBe(request.toolChoice);
      expect(result.toolCalls).toEqual(toolCalls);
      expect(runRecord().prompt_refs_json).not.toContain('reference-research');
    },
  );

  it.each([false, true])('caps sequential and batched search requests (batched=%s)', async (batched) => {
    const search = vi.spyOn(tavily, 'search').mockResolvedValue({ results: [source] });
    const gateway = {
      complete: vi.fn(async (request: CompletionRequest) => request.tools
        ? completion('', batched ? Array.from({ length: 5 }, (_, index) => searchCall(`search-${index}`)) : [searchCall()])
        : completion('완성된 본문')),
    };
    const runner = new AiRunnerService(database, registry, gateway as never, tavily);
    const { result } = await runner.completeText(input());

    expect(search).toHaveBeenCalledTimes(3);
    expect(gateway.complete).toHaveBeenCalledTimes(batched ? 2 : 4);
    expect(result.content).toBe('완성된 본문');
    if (batched) {
      expect(JSON.stringify(gateway.complete.mock.calls.at(-1)![0].messages)).toContain('SEARCH_LIMIT_REACHED');
    }
  });

  it('passes search failures and unknown tool errors back without failing generation', async () => {
    const search = vi.spyOn(tavily, 'search').mockResolvedValue({
      results: [], error: { code: 'UPSTREAM_ERROR', status: 429 },
    });
    const unknown: ToolCall = { id: 'unknown', type: 'function', function: { name: 'read_private_file', arguments: '{}' } };
    const gateway = { complete: vi.fn().mockResolvedValueOnce(completion('', [unknown, searchCall()]))
      .mockResolvedValueOnce(completion('DONE')).mockResolvedValueOnce(completion('기존 문맥으로 작성한 본문')) };
    const runner = new AiRunnerService(database, registry, gateway as never, tavily);
    await runner.completeText(input());

    expect(search).toHaveBeenCalledTimes(1);
    const researchRequest = gateway.complete.mock.calls[1]![0] as CompletionRequest;
    expect(researchRequest.messages.filter((message) => message.role === 'tool').map((message) => message.tool_call_id))
      .toEqual(['unknown', 'search-1']);
    const finalRequest = gateway.complete.mock.calls[2]![0] as CompletionRequest;
    expect(JSON.stringify(finalRequest.messages)).toContain('UPSTREAM_ERROR');
    expect(JSON.stringify(finalRequest.messages)).toContain('UNKNOWN_TOOL');
    expect(runRecord().status).toBe('SUCCEEDED');
  });

  it('cancels research with the writing request and does not start the final stream', async () => {
    const controller = new AbortController();
    vi.spyOn(tavily, 'search').mockImplementation(async (_args, signal) => {
      expect(signal).toBe(controller.signal);
      controller.abort(new DOMException('Cancelled', 'AbortError'));
      signal!.throwIfAborted();
      return { results: [] };
    });
    const gateway = { complete: vi.fn().mockResolvedValue(completion('', [searchCall()])), streamText: vi.fn() };
    const runner = new AiRunnerService(database, registry, gateway as never, tavily);
    const onDelta = vi.fn();
    await expect(runner.streamText({ ...input(), signal: controller.signal }, onDelta))
      .rejects.toMatchObject({ name: 'AbortError' });

    expect(gateway.streamText).not.toHaveBeenCalled();
    expect(onDelta).not.toHaveBeenCalled();
    expect(runRecord().status).toBe('CANCELLED');
  });
});
