import 'reflect-metadata';
import { BadRequestException, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { ConversationStreamEvent } from '@paranovel/contracts';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatController } from '../src/chat/chat.controller';
import { ChatService } from '../src/chat/chat.service';
import { EditorAiController } from '../src/episodes/editor-ai.controller';
import { EditorAiService } from '../src/episodes/editor-ai.service';

type Emit = (event: ConversationStreamEvent<unknown>) => void;
const routes = [
  { kind: 'chat', path: '/projects/story/chat/messages/stream', threadId: undefined },
  { kind: 'chat', path: '/projects/story/chat/threads/room/messages/stream', threadId: 'room' },
  { kind: 'editor', path: '/projects/story/episodes/chapter/editor-ai/messages/stream', threadId: undefined },
] as const;

describe('conversation streaming HTTP endpoints', () => {
  const apps: INestApplication[] = [];
  const releases: Array<() => void> = [];

  afterEach(async () => {
    releases.splice(0).forEach((release) => release());
    for (const app of apps.splice(0)) {
      (app.getHttpServer() as Server).closeAllConnections();
      await app.close();
    }
  });

  async function start(run: (signal: AbortSignal, emit: Emit) => Promise<unknown>) {
    const chatSend = vi.fn((_project: string, _body: unknown, signal: AbortSignal, _thread: string | undefined, emit: Emit) => run(signal, emit));
    const editorSend = vi.fn((_project: string, _episode: string, _body: unknown, signal: AbortSignal, emit: Emit) => run(signal, emit));
    Reflect.defineMetadata('design:paramtypes', [ChatService], ChatController);
    Reflect.defineMetadata('design:paramtypes', [EditorAiService], EditorAiController);
    const module = await Test.createTestingModule({
      controllers: [ChatController, EditorAiController],
      providers: [{ provide: ChatService, useValue: { send: chatSend } }, { provide: EditorAiService, useValue: { send: editorSend } }],
    }).compile();
    const app = module.createNestApplication();
    apps.push(app);
    await app.listen(0, '127.0.0.1');
    return { url: await app.getUrl(), chatSend, editorSend };
  }

  it.each(routes)('delivers $path deltas before persistence completes', async ({ path, kind, threadId }) => {
    let finish!: () => void;
    const completion = new Promise<void>((resolve) => { finish = resolve; releases.push(resolve); });
    const history = { messages: [], ...(kind === 'chat' ? { thread: null } : {}) };
    const { url, chatSend, editorSend } = await start(async (_signal, emit) => {
      emit({ type: 'start', messageId: 'answer' });
      emit({ type: 'tool_start', callId: 'read-1', name: 'read_project_record' });
      emit({ type: 'tool_end', callId: 'read-1', name: 'read_project_record' });
      emit({ type: 'delta', text: '첫 답변 🌙' });
      await completion;
      return history;
    });
    const body = { content: '이어서 설명해 줘', clientMessageId: 'turn' };
    const response = await fetch(`${url}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    expect(response.headers.get('content-type')).toContain('application/x-ndjson');
    expect(response.headers.get('x-accel-buffering')).toBe('no');
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let received = '';
    while (!received.includes('첫 답변')) received += decoder.decode((await reader.read()).value, { stream: true });
    expect(received).not.toContain('"type":"complete"');
    expect(kind === 'chat' ? chatSend : editorSend).toHaveBeenCalledTimes(1);
    if (kind === 'chat') expect(chatSend.mock.calls[0]).toEqual(['story', body, expect.any(AbortSignal), threadId, expect.any(Function)]);
    else expect(editorSend.mock.calls[0]).toEqual(['story', 'chapter', body, expect.any(AbortSignal), expect.any(Function)]);
    finish();
    while (true) {
      const { done, value } = await reader.read();
      received += decoder.decode(value, { stream: !done });
      if (done) break;
    }
    const events = received.trim().split('\n').map((line) => JSON.parse(line));
    expect(events.map((event) => event.type)).toEqual(['start', 'tool_start', 'tool_end', 'delta', 'complete']);
    expect(events.at(-1)).toEqual({ type: 'complete', history });
  });

  it.each(routes)('returns an error event without complete on invalid $path input', async ({ path }) => {
    const { url } = await start(async () => { throw new BadRequestException('메시지를 확인해 주세요.'); });
    const response = await fetch(`${url}${path}`, { method: 'POST' });
    expect((await response.text()).trim().split('\n').map((line) => JSON.parse(line))).toEqual([
      { type: 'error', code: '400', message: '메시지를 확인해 주세요.' },
    ]);
  });

  it.each(routes)('aborts AI work when the client leaves $path', async ({ path }) => {
    let serverSignal!: AbortSignal;
    const { url } = await start(async (signal, emit) => {
      serverSignal = signal;
      emit({ type: 'start', messageId: 'answer' });
      await new Promise<void>((resolve, reject) => {
        releases.push(resolve);
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
      return { messages: [] };
    });
    const response = await fetch(`${url}${path}`, { method: 'POST' });
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();
    await vi.waitFor(() => expect(serverSignal.aborted).toBe(true));
  });
});
