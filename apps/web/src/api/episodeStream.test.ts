import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './client';
import type { ContinuityIssue } from '../types';

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

  it.each(['draft', 'continuation', 'comparison'] as const)('rejects an unsolicited final replacement for %s and retains the streamed text', async (operation) => {
    streamResponse([
      { type: 'delta', text: '원래 초안' },
      { type: 'stage', stage: 'REPAIRING' },
      { type: 'reset' },
      { type: 'delta', text: '수정 중' },
      { type: 'done', content: '수정 완료', issues: [], blocked: false },
    ]);
    const snapshots: string[] = [];
    const onEvent = (_event: unknown, content: string) => { snapshots.push(content); };
    const pending = operation === 'draft'
      ? api.episodes.generate('story', { title: '제목', direction: '방향' }, onEvent)
      : operation === 'continuation'
        ? api.episodes.continue('story', 'episode', { expectedRevision: 1, cursorOffset: 0 }, onEvent)
        : api.comparisons.generate({ brief: '브리프' }, onEvent);
    await expect(pending).rejects.toThrow('완료 응답의 본문이 생성된 초안과 달라');
    expect(snapshots).toEqual(['원래 초안', '원래 초안', '원래 초안', '원래 초안']);
  });

  it.each([
    [{ type: 'done', content: '원래 초안' }],
    [{ type: 'stage', stage: 'CHECKING' }, { type: 'delta', text: '몰래 추가한 문장' }, { type: 'done', content: '\n  원래 초안  \n몰래 추가한 문장' }],
  ])('rejects silent formatting or appended changes without a reset', async (...events) => {
    streamResponse([{ type: 'delta', text: '\n  원래 초안  \n' }, ...events]);
    const snapshots: string[] = [];
    await expect(api.episodes.generate('story', { title: '제목', direction: '방향' }, (_event, content) => snapshots.push(content))).rejects.toThrow();
    expect(snapshots.every((text) => text === '\n  원래 초안  \n')).toBe(true);
  });

  it.each(['draft', 'continuation'] as const)('accepts a replacement only for an explicit %s repair request and ignores late events', async (operation) => {
    const issue: ContinuityIssue = {
      category: 'CANON', severity: 'BLOCKING', excerpt: '원래 초안', explanation: '다친 손이 바뀌었다.',
      evidenceRefs: ['canon:injury'], repairInstruction: '손을 오른손으로 맞춘다.',
    };
    streamResponse([
      { type: 'stage', stage: 'REPAIRING' },
      { type: 'delta', text: '수정 중' },
      { type: 'stage', stage: 'CHECKING' },
      { type: 'done', content: '\n  수정 완료  \n', issues: [], blocked: false },
      { type: 'error', code: 'LATE', message: '완료 후 오류' },
      { type: 'reset' },
    ]);
    const snapshots: string[] = [];
    const onEvent = (_event: unknown, content: string) => { snapshots.push(content); };
    const result = await (operation === 'draft'
      ? api.episodes.repair('story', { title: '제목', direction: '방향', content: '원래 초안', issue }, onEvent)
      : api.episodes.repairContinuation('story', 'episode', { expectedRevision: 1, cursorOffset: 0, content: '원래 초안', issue }, onEvent));
    expect(result.content).toBe('\n  수정 완료  \n');
    expect(snapshots).toEqual(['', '', '', '\n  수정 완료  \n']);
  });

  it.each(['STYLE', 'ARC', 'CHARACTER', 'FORESHADOWING'])('rejects an out-of-scope %s issue without changing the readable draft', async (category) => {
    streamResponse([
      { type: 'delta', text: '원래 초안' },
      { type: 'done', content: '원래 초안', blocked: true, issues: [{
        category, severity: 'BLOCKING', excerpt: '원래 초안', explanation: '검사 대상이 아닌 문제', evidenceRefs: [], repairInstruction: '수정',
      }] },
    ]);
    const snapshots: string[] = [];
    await expect(api.episodes.generate('story', { title: '제목', direction: '방향' }, (_event, content) => snapshots.push(content))).rejects.toThrow();
    expect(snapshots).toEqual(['원래 초안']);
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
