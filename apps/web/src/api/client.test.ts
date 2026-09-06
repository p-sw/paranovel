import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './client';

afterEach(() => vi.unstubAllGlobals());

describe('NDJSON client', () => {
  it('honors reset and exposes final continuity issues', async () => {
    const payload = [
      { type: 'meta', runId: 'run-1' },
      { type: 'stage', stage: 'WRITING' },
      { type: 'delta', text: '폐기할 초안' },
      { type: 'reset' },
      { type: 'stage', stage: 'REPAIRING' },
      { type: 'delta', text: '수정된 ' },
      { type: 'delta', text: '초안' },
      {
        type: 'done',
        content: '수정된 초안',
        blocked: false,
        issues: [
          {
            category: 'STYLE',
            severity: 'WARNING',
            excerpt: '초안',
            explanation: '문체를 확인하세요.',
            evidenceRefs: [],
            repairInstruction: '문장을 다듬습니다.',
          },
        ],
      },
    ].map((event) => JSON.stringify(event)).join('\n');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(payload, {
      status: 200,
      headers: { 'content-type': 'application/x-ndjson' },
    })));
    const snapshots: string[] = [];

    const result = await api.comparisons.generate(
      { brief: '비 오는 성벽', targetChars: 1000 },
      (_event, content) => snapshots.push(content),
    );

    expect(snapshots).toContain('');
    expect(result.content).toBe('수정된 초안');
    expect(result.blocked).toBe(false);
    expect(result.issues[0].explanation).toBe('문체를 확인하세요.');
    expect(fetch).toHaveBeenCalledWith('/api/comparisons/generate', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ brief: '비 오는 성벽', targetChars: 1000 }),
    }));
  });
});

describe('write contracts', () => {
  it('sends the saved revision and stable key for highlights and guards placement by image ID', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => Response.json({ configured: true, image: null, generation: null }));
    vi.stubGlobal('fetch', fetchMock);
    await api.highlights.generate('project', 'episode', 7, 'same-paid-request');
    await api.highlights.place('project', 'episode', { expectedEpisodeRevision: 8, expectedImageId: 'image', afterParagraphId: 3 });
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/projects/project/episodes/episode/highlight/generate', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ expectedRevision: 7 }),
      headers: expect.objectContaining({ 'Idempotency-Key': 'same-paid-request' }),
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/projects/project/episodes/episode/highlight/placement', expect.objectContaining({
      method: 'PATCH', body: JSON.stringify({ expectedEpisodeRevision: 8, expectedImageId: 'image', afterParagraphId: 3 }),
    }));
  });

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
