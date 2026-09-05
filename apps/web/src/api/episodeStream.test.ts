import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './client';

afterEach(() => vi.unstubAllGlobals());

function streamResponse(events: unknown[]) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(events.map((event) => JSON.stringify(event)).join('\n'))));
}

describe('episode stream terminal validation', () => {
  it.each([
    [{ type: 'delta', text: '남아 있는 초안' }],
    [{ type: 'delta', text: '남아 있는 초안' }, { type: 'done', content: '', issues: [], blocked: false }],
    [{ type: 'delta', text: '남아 있는 초안' }, { type: 'done', content: '완료', issues: [null], blocked: false }],
  ])('rejects incomplete or invalid completion without overwriting the last readable content', async (...events) => {
    streamResponse(events);
    const snapshots: string[] = [];
    await expect(api.episodes.generate('story', { title: '제목', direction: '방향' }, (_event, content) => snapshots.push(content))).rejects.toThrow();
    expect(snapshots.at(-1)).toBe('남아 있는 초안');
  });

  it('commits only the final replacement and ignores data after completion', async () => {
    streamResponse([
      { type: 'delta', text: '원래 초안' },
      { type: 'stage', stage: 'REPAIRING' },
      { type: 'reset' },
      { type: 'delta', text: '수정 중' },
      { type: 'done', content: '수정 완료', issues: [], blocked: false },
      { type: 'error', code: 'LATE', message: '완료 후 오류' },
      { type: 'reset' },
    ]);
    const snapshots: string[] = [];
    const result = await api.episodes.generate('story', { title: '제목', direction: '방향' }, (_event, content) => snapshots.push(content));
    expect(result.content).toBe('수정 완료');
    expect(snapshots).toEqual(['원래 초안', '원래 초안', '원래 초안', '원래 초안', '수정 완료']);
  });

  it('decodes split UTF-8 characters and a final event without a newline', async () => {
    const bytes = new TextEncoder().encode([
      { type: 'delta', text: '문을 연다 🌙' },
      { type: 'done', content: '문을 연다 🌙', issues: [], blocked: false },
    ].map((event) => JSON.stringify(event)).join('\n'));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({
      start(controller) {
        for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
        controller.close();
      },
    }))));
    const result = await api.episodes.generate('story', { title: '제목', direction: '방향' }, () => undefined);
    expect(result.content).toBe('문을 연다 🌙');
  });
});
