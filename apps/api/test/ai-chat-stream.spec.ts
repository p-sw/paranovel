import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AiRunnerService } from '../src/ai/ai-runner.service';
import type { ChatStreamEvent, CompletionRequest, CompletionResult, ToolCall } from '../src/ai/ai.types';
import { DatabaseService } from '../src/database/database.service';
import { aiRuns } from '../src/database/schema';
import { PromptRegistryService } from '../src/prompts/prompt-registry.service';

const toolCall = (id: string, name = 'read'): ToolCall => ({ id, type: 'function', function: { name, arguments: JSON.stringify({ id }) } });
const completion = (content = '', toolCalls: ToolCall[] = []): CompletionResult => ({
  content, toolCalls, model: 'test-model', usage: { promptTokens: 2, completionTokens: 1 },
});
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((value) => { resolve = value; });
  return { promise, resolve };
};

describe('chat runner streaming and concurrent tools', () => {
  let database: DatabaseService;
  let registry: PromptRegistryService;
  let runner: AiRunnerService;
  const complete = vi.fn<(request: CompletionRequest) => Promise<CompletionResult>>();
  const streamText = vi.fn<(request: CompletionRequest, onDelta: (text: string) => void) => Promise<CompletionResult>>();
  const validator = z.object({ reply: z.string(), proposals: z.array(z.unknown()) });

  beforeEach(() => {
    vi.stubEnv('DB_PATH', ':memory:');
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    complete.mockReset(); streamText.mockReset();
    database = new DatabaseService(); registry = new PromptRegistryService();
    runner = new AiRunnerService(database, registry, { complete, streamText } as never, { isConfigured: () => false } as never);
  });
  afterEach(() => { database.onApplicationShutdown(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

  const input = () => ({
    task: 'project_chat', promptId: 'project-chat',
    variables: Object.fromEntries(registry.get('project-chat').requiredVariables.map((key) => [key, '[]'])),
    validator, schema: { name: 'reply', value: {} },
    readTools: ['read', 'image', 'tavily_search'].map((name) => ({ type: 'function' as const, function: { name, description: name, parameters: {} } })),
    readTool: vi.fn(async () => ({ result: 'ok' })),
  });

  it('streams only final reply text before the provider completes and accounts for all turns', async () => {
    const finish = deferred<void>();
    const events: ChatStreamEvent[] = [];
    streamText.mockImplementationOnce(async (_request, onDelta) => {
      onDelta('{"reply":"tool narration must stay private"}');
      return completion('tool narration');
    }).mockImplementationOnce(async (_request, onDelta) => {
      onDelta('{"proposals":[{"reply":"hidden"}],"reply":"첫 문장');
      await finish.promise;
      onDelta('\\n달 \\ud83c');
      onDelta('\\udf19"}');
      return completion('{"proposals":[{"reply":"hidden"}],"reply":"첫 문장\\n달 \\ud83c\\udf19"}');
    });
    const pending = runner.completeChat({ ...input(), onEvent: (event) => events.push(event) });
    await vi.waitFor(() => expect(events).toEqual([{ type: 'delta', text: '첫 문장' }]));
    expect(database.orm.select().from(aiRuns).get()?.status).toBe('RUNNING');
    finish.resolve();
    const result = await pending;
    expect(result.value.reply).toBe('첫 문장\n달 🌙');
    expect(events).toEqual([{ type: 'delta', text: '첫 문장' }, { type: 'delta', text: '\n달 ' }, { type: 'delta', text: '🌙' }]);
    expect(complete).not.toHaveBeenCalled();
    expect(database.orm.select().from(aiRuns).get()).toMatchObject({ status: 'SUCCEEDED', inputTokens: 4, outputTokens: 2 });
  });

  it('resets an invalid streamed reply before a single structured-output retry', async () => {
    const events: ChatStreamEvent[] = [];
    streamText.mockResolvedValueOnce(completion());
    for (const content of ['{"reply":"잘못된 답변"}', '{"reply":"올바른 답변","proposals":[]}']) {
      streamText.mockImplementationOnce(async (_request, onDelta) => {
        onDelta(content);
        return completion(content);
      });
    }
    const result = await runner.completeChat({ ...input(), onEvent: (event) => events.push(event) });
    expect(result.value.reply).toBe('올바른 답변');
    expect(events).toEqual([{ type: 'delta', text: '잘못된 답변' }, { type: 'reset' }, { type: 'delta', text: '올바른 답변' }]);
    expect(streamText).toHaveBeenCalledTimes(3);
    expect(database.orm.select().from(aiRuns).get()).toMatchObject({ inputTokens: 6, outputTokens: 3 });
  });

  it('runs independent calls together, keeps their results ordered and stops at a terminal tool', async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    const events: ChatStreamEvent[] = [];
    let terminal: z.infer<typeof validator> | undefined;
    streamText.mockResolvedValueOnce(completion('', [toolCall('first'), toolCall('second'), toolCall('image', 'image'), toolCall('duplicate-image', 'image'), toolCall('late')]));
    const readTool = vi.fn(async (name: string, json: string) => {
      if (name === 'image') { terminal = { reply: 'authoritative image tags', proposals: [] }; return terminal; }
      return JSON.parse(json).id === 'first' ? first.promise : second.promise;
    });
    const pending = runner.completeChat({ ...input(), readTool, parallelToolNames: ['read'],
      resolveAfterTools: () => terminal, onEvent: (event) => events.push(event) });
    await vi.waitFor(() => expect(readTool).toHaveBeenCalledTimes(2));
    expect(events).toEqual([
      { type: 'tool_start', callId: 'first', name: 'read' }, { type: 'tool_start', callId: 'second', name: 'read' },
    ]);
    second.resolve({ id: 'second' });
    await vi.waitFor(() => expect(events.at(-1)).toEqual({ type: 'tool_end', callId: 'second', name: 'read' }));
    expect(readTool).toHaveBeenCalledTimes(2);
    first.resolve({ id: 'first' });
    expect((await pending).value).toEqual(terminal);
    expect(readTool).toHaveBeenCalledTimes(3);
    expect(streamText).toHaveBeenCalledOnce();
    expect(events.at(-1)).toEqual({ type: 'delta', text: 'authoritative image tags' });
  });

  it('preserves provider metadata and tool-result order when parallel work finishes out of order', async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    const calls = [toolCall('first'), toolCall('second')];
    const assistantMessage = { role: 'assistant' as const, content: null, tool_calls: calls, reasoning: 'reasoning', reasoning_details: [{ type: 'reasoning.encrypted', data: 'signature' }] };
    complete.mockResolvedValueOnce({ ...completion('', calls), assistantMessage })
      .mockResolvedValueOnce(completion()).mockResolvedValueOnce(completion('{"reply":"done","proposals":[]}'));
    const readTool = vi.fn(async (_name: string, json: string) => JSON.parse(json).id === 'first' ? first.promise : second.promise);
    const pending = runner.completeChat({ ...input(), readTool, parallelToolNames: ['read'] });
    await vi.waitFor(() => expect(readTool).toHaveBeenCalledTimes(2));
    second.resolve({ text: 'second' }); first.resolve({ text: 'first' });
    await pending;
    const messages = complete.mock.calls[1]![0].messages;
    expect(messages).toContainEqual(assistantMessage);
    expect(messages.filter((message) => message.role === 'tool')).toEqual([
      { role: 'tool', tool_call_id: 'first', content: '{"text":"first"}' },
      { role: 'tool', tool_call_id: 'second', content: '{"text":"second"}' },
    ]);
  });

  it('reserves eight calls and three searches in model order before parallel execution', async () => {
    const calls = Array.from({ length: 10 }, (_, index) => toolCall(String(index), index < 4 ? 'tavily_search' : 'read'));
    complete.mockResolvedValueOnce(completion('', calls)).mockResolvedValueOnce(completion('{"reply":"done","proposals":[]}'));
    const readTool = vi.fn(async (_name: string, _json: string) => ({ ok: true }));
    await runner.completeChat({ ...input(), readTool, parallelToolNames: ['tavily_search', 'read'] });
    expect(readTool).toHaveBeenCalledTimes(7);
    expect(readTool.mock.calls.slice(0, 3).map(([name]) => name)).toEqual(['tavily_search', 'tavily_search', 'tavily_search']);
    const messages = complete.mock.calls[1]![0].messages.filter((message) => message.role === 'tool');
    expect(messages[3]?.content).toBe('{"error":"SEARCH_LIMIT_REACHED"}');
    expect(messages[8]?.content).toBe('{"error":"READ_LIMIT_REACHED"}');
    expect(messages[9]?.content).toBe('{"error":"READ_LIMIT_REACHED"}');
  });

  it('caps serialized tool output, including escaped text, at 60,000 characters', async () => {
    complete.mockResolvedValueOnce(completion('', [toolCall('large'), toolCall('second')]))
      .mockResolvedValueOnce(completion()).mockResolvedValueOnce(completion('{"reply":"done","proposals":[]}'));
    const readTool = vi.fn(async () => ({ text: '"\\'.repeat(60_000) }));
    await runner.completeChat({ ...input(), readTool, parallelToolNames: ['read'] });
    const messages = complete.mock.calls[1]![0].messages.filter((message) => message.role === 'tool');
    expect(messages.reduce((sum, message) => sum + (message.content?.length ?? 0), 0)).toBeLessThanOrEqual(60_000);
    expect(JSON.parse(messages[0]!.content!)).toMatchObject({ truncated: true });
  });

  it('limits tool rounds to four even when fewer than eight calls are requested', async () => {
    for (let index = 0; index < 4; index += 1) complete.mockResolvedValueOnce(completion('', [toolCall(String(index))]));
    complete.mockResolvedValueOnce(completion('{"reply":"done","proposals":[]}'));
    const readTool = vi.fn(async () => ({ ok: true }));
    await runner.completeChat({ ...input(), readTool, parallelToolNames: ['read'] });
    expect(readTool).toHaveBeenCalledTimes(4);
    expect(complete).toHaveBeenCalledTimes(5);
    expect(complete.mock.calls[4]![0].tools).toBeUndefined();
  });

  it('cancels parallel reads without starting a later sequential tool or final generation', async () => {
    const abort = new AbortController();
    const finish = deferred<void>();
    const events: ChatStreamEvent[] = [];
    streamText.mockResolvedValueOnce(completion('', [toolCall('first'), toolCall('second'), toolCall('image', 'image')]));
    const readTool = vi.fn(async () => { await finish.promise; return { ok: true }; });
    const pending = runner.completeChat({ ...input(), readTool, signal: abort.signal, parallelToolNames: ['read'], onEvent: (event) => events.push(event) });
    const rejection = expect(pending).rejects.toThrow('cancelled');
    await vi.waitFor(() => expect(readTool).toHaveBeenCalledTimes(2));
    abort.abort(new Error('cancelled')); finish.resolve();
    await rejection;
    expect(readTool).toHaveBeenCalledTimes(2);
    expect(streamText).toHaveBeenCalledOnce();
    expect(events.every((event) => event.type === 'tool_start')).toBe(true);
    expect(database.orm.select().from(aiRuns).get()?.status).toBe('CANCELLED');
  });
});
