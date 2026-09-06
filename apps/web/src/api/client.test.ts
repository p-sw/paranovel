import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './client';

afterEach(() => vi.unstubAllGlobals());

describe('NDJSON client', () => {
  it('preserves the streamed draft and exposes final continuity issues', async () => {
    const payload = [
      { type: 'meta', runId: 'run-1' },
      { type: 'stage', stage: 'WRITING' },
      { type: 'delta', text: '생성된 ' },
      { type: 'delta', text: '초안' },
      { type: 'stage', stage: 'CHECKING' },
      {
        type: 'done',
        content: '생성된 초안',
        blocked: false,
        issues: [
          {
            category: 'SCENE',
            severity: 'WARNING',
            excerpt: '초안',
            explanation: '성벽의 위치가 동쪽에서 서쪽으로 바뀌었습니다.',
            evidenceRefs: [],
            repairInstruction: '성벽의 위치를 동쪽으로 맞춥니다.',
          },
        ],
      },
    ].map((event) => JSON.stringify(event)).join('\n');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(payload, {
      status: 200,
      headers: { 'content-type': 'application/x-ndjson' },
    })));
    const snapshots: string[] = [];

    const result = await api.episodes.generate(
      'story', { title: '성벽', direction: '비 오는 성벽' },
      (_event, content) => snapshots.push(content),
    );

    expect(snapshots).toContain('');
    expect(result.content).toBe('생성된 초안');
    expect(result.blocked).toBe(false);
    expect(result.issues[0].explanation).toBe('성벽의 위치가 동쪽에서 서쪽으로 바뀌었습니다.');
    expect(fetch).toHaveBeenCalledWith('/api/projects/story/episodes/generate', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ title: '성벽', direction: '비 오는 성벽' }),
    }));
  });
});

describe('write contracts', () => {
  it('maps arc episode fields and keeps the optimistic revision', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await api.arcs.update('project-1', 'arc-1', {
      expectedRevision: 4,
      startEpisode: 8,
      endEpisode: 17,
    });

    const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(options.body));
    expect(body).toEqual({
      expectedRevision: 4,
      startEpisodeNumber: 8,
      endEpisodeNumber: 17,
    });
    expect(body).not.toHaveProperty('startEpisode');
    expect(body).not.toHaveProperty('endEpisode');
  });

  it('sends a stable idempotency key when an episode draft is persisted', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await api.episodes.create(
      'project-1',
      { title: '문이 열린 밤', direction: '주인공이 봉인을 확인한다.', content: '첫 문장' },
      'stable-attempt-key',
    );

    const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new Headers(options.headers).get('Idempotency-Key')).toBe('stable-attempt-key');
  });

  it('sends an idempotency key when improvement candidates are accepted', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ improvements: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await api.improvements.accept({
      candidates: [{
        title: '장면 진입',
        rule: '장면의 감각 정보를 먼저 둔다.',
        rationale: '공간을 빠르게 인식시킨다.',
        category: 'STYLE',
        tags: [],
        confidence: 0.9,
        conflictsWithIds: [],
      }],
    }, 'improvement-attempt-key');

    const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new Headers(options.headers).get('Idempotency-Key')).toBe('improvement-attempt-key');
  });
});
