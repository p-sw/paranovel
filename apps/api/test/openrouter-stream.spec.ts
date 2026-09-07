import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenRouterGateway } from '../src/ai/openrouter.gateway';

const request = { model: 'test-model', messages: [{ role: 'user' as const, content: 'hello' }] };
const event = (value: unknown) => `data: ${JSON.stringify(value)}\r\n\r\n`;
const chunk = (delta: Record<string, unknown>) => event({ choices: [{ index: 0, delta }] });

describe('OpenRouter streaming', () => {
  beforeEach(() => vi.stubEnv('OPENROUTER_API_KEY', 'test-key'));
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

  it('reassembles interleaved tool arguments and signed reasoning across byte and SSE boundaries', async () => {
    const sse = ': OPENROUTER PROCESSING\r\n\r\n'
      + chunk({ reasoning: 'first ', reasoning_details: [{ index: 0, type: 'reasoning.text', text: 'first ', signature: null, id: 'reason-1', format: 'anthropic-claude-v1' }] })
      + chunk({ tool_calls: [
        { index: 1, id: 'second', type: 'function', function: { name: 'read_', arguments: '{"title":' }, extra_content: { google: { thought_signature: 'signed-tool' } } },
        { index: 0, id: 'first', type: 'function', function: { name: 'list', arguments: '{"offset":' } },
      ] })
      + chunk({ reasoning: 'second', reasoning_details: [{ index: 0, type: 'reasoning.text', text: 'second', signature: 'signed-' }] })
      + chunk({ content: '안녕 🌙', tool_calls: [
        { index: 0, function: { arguments: '0}' } },
        { index: 1, function: { name: 'record', arguments: '"옛 회차"}' } },
      ], reasoning_details: [
        { index: 0, type: 'reasoning.text', signature: 'reasoning' },
        { index: 1, type: 'reasoning.encrypted', data: 'opaque', id: 'reason-2' },
      ] })
      + 'data: {"model":"actual-model",\r\ndata: "choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":12,"completion_tokens":5}}\r\n\r\n'
      + 'data: [DONE]\r\n\r\n';
    const bytes = new TextEncoder().encode(sse);
    const fetchMock = vi.fn(async () => new Response(new ReadableStream({
      start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); },
    })));
    vi.stubGlobal('fetch', fetchMock);
    const onDelta = vi.fn();

    const result = await new OpenRouterGateway().streamText({ ...request, tools: [{ type: 'function', function: { name: 'list', description: 'List', parameters: {} } }] }, onDelta);

    expect(result).toMatchObject({ content: '안녕 🌙', model: 'actual-model', usage: { promptTokens: 12, completionTokens: 5 } });
    expect(result.toolCalls).toEqual([
      { id: 'first', type: 'function', function: { name: 'list', arguments: '{"offset":0}' } },
      { id: 'second', type: 'function', function: { name: 'read_record', arguments: '{"title":"옛 회차"}' }, extra_content: { google: { thought_signature: 'signed-tool' } } },
    ]);
    expect(result.assistantMessage).toEqual({ role: 'assistant', content: '안녕 🌙', tool_calls: result.toolCalls,
      reasoning: 'first second', reasoning_details: [
        { index: 0, type: 'reasoning.text', text: 'first second', signature: 'signed-reasoning', id: 'reason-1', format: 'anthropic-claude-v1' },
        { index: 1, type: 'reasoning.encrypted', data: 'opaque', id: 'reason-2' },
      ] });
    expect(onDelta.mock.calls).toEqual([['안녕 🌙']]);
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body).toMatchObject({ stream: true, parallel_tool_calls: true, stream_options: { include_usage: true } });
  });

  it('delivers text before completion and cancels an open reader on abort', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const cancel = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({
      start(value) { controller = value; }, cancel,
    }))));
    const abort = new AbortController();
    const onDelta = vi.fn();
    const pending = new OpenRouterGateway().streamText({ ...request, signal: abort.signal }, onDelta);
    const rejection = expect(pending).rejects.toThrow('cancelled');
    await vi.waitFor(() => expect(controller).toBeDefined());
    controller.enqueue(new TextEncoder().encode(chunk({ content: 'first' })));
    await vi.waitFor(() => expect(onDelta).toHaveBeenCalledWith('first'));
    abort.abort(new Error('cancelled'));
    await rejection;
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each([
    [chunk({ content: 'partial' }), 'ended before completion'],
    [event({ error: { message: 'provider disconnected' }, choices: [{ delta: {}, finish_reason: 'error' }] }), 'provider disconnected'],
    [chunk({ tool_calls: [{ index: 0, function: { arguments: '{}' } }] }) + 'data: [DONE]\n\n', 'incomplete tool call'],
  ])('rejects incomplete or errored streams', async (sse, message) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(sse)));
    await expect(new OpenRouterGateway().streamText(request, vi.fn())).rejects.toThrow(message);
  });
});
