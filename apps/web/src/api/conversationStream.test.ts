import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatHistory, ConversationStreamEvent, EditorAiHistory, EditorAiInput } from '@paranovel/contracts';
import { api, ApiError } from './client';

const input: EditorAiInput = { content: '문장을 다듬어줘', clientMessageId: 'turn', expectedRevision: 1, selection: { start: 0, end: 0, text: '' } };
const message = {
  id: 'assistant', projectId: 'story', clientMessageId: 'turn', role: 'assistant' as const,
  content: '문을 연다 🌙', status: 'COMPLETE' as const, createdAt: '2026-09-07T00:00:00.000Z',
};
const chatHistory: ChatHistory = { thread: null, messages: [{ ...message, proposals: [] }] };
const editorHistory: EditorAiHistory = { messages: [{ ...message, episodeId: 'episode', request: null, edit: null, error: null }] };

afterEach(() => vi.unstubAllGlobals());

for (const kind of ['chat', 'editor'] as const) {
  const history = kind === 'chat' ? chatHistory : editorHistory;
  const send = (callback: (event: ConversationStreamEvent<ChatHistory | EditorAiHistory>, text: string) => void, signal?: AbortSignal) => kind === 'chat'
    ? api.chat.send('story', input, 'room / 1', callback, signal)
    : api.editorAi.send('story', 'episode', input, callback, signal);
  const response = (events: unknown[]) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(events.map((event) => JSON.stringify(event)).join('\n'))));
  };

  describe(`${kind} conversation stream`, () => {
    it('decodes fragmented UTF-8, resets text, forwards multiple tools, and validates the final history', async () => {
      const events = [
        { type: 'start', messageId: message.id },
        { type: 'delta', text: '다시 쓰기 전' },
        { type: 'reset' },
        { type: 'tool_start', callId: 'one', name: 'read_manuscript' },
        { type: 'tool_start', callId: 'two', name: 'search_canon' },
        { type: 'tool_end', callId: 'two', name: 'search_canon' },
        { type: 'tool_end', callId: 'one', name: 'read_manuscript' },
        { type: 'delta', text: '문을 연다 🌙' },
        { type: 'complete', history },
      ];
      const bytes = new TextEncoder().encode(events.map((event) => JSON.stringify(event)).join('\n'));
      const fetch = vi.fn(async () => new Response(new ReadableStream({
        start(controller) {
          for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
          controller.close();
        },
      })));
      vi.stubGlobal('fetch', fetch);
      const seen = vi.fn();
      expect(await send(seen)).toMatchObject(history);
      expect(fetch).toHaveBeenCalledWith(kind === 'chat'
        ? '/api/projects/story/chat/threads/room%20%2F%201/messages/stream'
        : '/api/projects/story/episodes/episode/editor-ai/messages/stream', expect.objectContaining({
        method: 'POST', headers: { Accept: 'application/x-ndjson', 'Content-Type': 'application/json' },
      }));
      expect(seen.mock.calls.map(([event]) => event.type)).toEqual(events.map((event) => event.type));
      expect(seen.mock.calls[1]![1]).toBe('다시 쓰기 전');
      expect(seen.mock.calls[2]![1]).toBe('');
      expect(seen.mock.calls.at(-1)![1]).toBe(message.content);
    });

    it.each(['eof', 'invalid', 'missing-assistant', 'pending-assistant', 'missing-start'] as const)('rejects %s completion without losing readable deltas', async (failure) => {
      response([
        ...(failure === 'missing-start' ? [] : [{ type: 'start', messageId: message.id }]),
        { type: 'delta', text: '읽을 수 있는 답변' },
        ...(failure === 'eof' ? [] : [{ type: 'complete', history: failure === 'invalid' ? { messages: [null] }
          : failure === 'missing-assistant' ? { ...history, messages: [] }
            : failure === 'pending-assistant' ? { ...history, messages: history.messages.map((item) => ({ ...item, status: 'PENDING' })) }
              : history }]),
      ]);
      const seen = vi.fn();
      await expect(send(seen)).rejects.toBeInstanceOf(ApiError);
      expect(seen.mock.calls.at(-1)).toEqual([{ type: 'delta', text: '읽을 수 있는 답변' }, '읽을 수 있는 답변']);
    });

    it('surfaces server errors and ignores data after the terminal completion', async () => {
      response([{ type: 'error', code: '409', message: '원고가 바뀌었어요.' }]);
      await expect(send(vi.fn())).rejects.toMatchObject({ status: 409, message: '원고가 바뀌었어요.' });
      response([{ type: 'start', messageId: message.id }, { type: 'complete', history }, { type: 'error', message: '늦은 오류' }]);
      expect(await send(vi.fn())).toMatchObject(history);
    });

    it('cancels a blocked reader and never reports completion after abort', async () => {
      const cancel = vi.fn();
      vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode('{"type":"start","messageId":"assistant"}\n')); }, cancel,
      }))));
      const controller = new AbortController();
      const seen = vi.fn();
      const pending = send(seen, controller.signal);
      await vi.waitFor(() => expect(seen).toHaveBeenCalled());
      controller.abort();
      await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(seen).toHaveBeenCalledTimes(1);
    });
  });
}
