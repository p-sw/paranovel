import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { api } from '../api/client';
import type { Episode } from '../types';
import EpisodeEditorPage from './EpisodeEditorPage';

const episode: Episode = {
  id: 'episode', projectId: 'story', number: 1, title: '닫힌 문', direction: '문을 연다.',
  content: '원래 본문.', revision: 1, status: 'DRAFT', summary: null,
  createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z',
};

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(api.episodes, 'get').mockResolvedValue(episode);
  vi.spyOn(api.episodes, 'list').mockResolvedValue([episode]);
  vi.spyOn(api.scenes, 'get').mockResolvedValue({
    episodeId: episode.id, characters: [], location: null, time: null, pointOfView: null, goal: null, sourceRevision: 1,
  });
});

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); });

async function openContinuation() {
  const user = userEvent.setup();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/projects/story/episodes/episode']}>
        <Routes><Route path="/projects/:projectId/episodes/:episodeId" element={<EpisodeEditorPage />} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  await user.click(await screen.findByRole('button', { name: '커서에서 이어쓰기' }));
  const dialog = within(screen.getByRole('dialog'));
  await user.click(dialog.getByRole('button', { name: '이어쓰기 시작' }));
  return { user, dialog };
}

describe('continuation draft review', () => {
  it.each(['failure', 'cancel'] as const)('keeps the suggestion editable and marks insertion for review after %s', async (ending) => {
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({
      start(controller) { stream = controller; },
    }))));
    const update = vi.spyOn(api.episodes, 'update').mockResolvedValue({ ...episode, content: '추가 문장.원래 본문.', revision: 2 });
    const { user, dialog } = await openContinuation();
    const textarea = dialog.getByLabelText('이어쓰기 제안 수정') as HTMLTextAreaElement;
    const send = async (event: unknown) => act(async () => {
      stream.enqueue(new TextEncoder().encode(`${JSON.stringify(event)}\n`));
    });
    await send({ type: 'delta', text: '추가 문장.' });
    await send({ type: 'stage', stage: 'CHECKING' });
    expect(dialog.getByLabelText('이어쓰기 제안 수정')).toBe(textarea);
    expect(textarea.readOnly).toBe(true);
    expect(dialog.getByText('일관성을 확인하는 중').closest('.sheet-body')).toBeNull();
    if (ending === 'failure') await send({ type: 'error', code: 'FAILED', message: '검토 실패' });
    else await user.click(dialog.getByRole('button', { name: '중단' }));

    expect(await dialog.findByRole('button', { name: '검토 필요로 삽입' })).toBeEnabled();
    expect(dialog.getByLabelText('이어쓰기 제안 수정')).toBe(textarea);
    expect(textarea).toHaveValue('추가 문장.');
    expect(textarea.readOnly).toBe(false);
    await user.click(dialog.getByRole('button', { name: '검토 필요로 삽입' }));
    expect(update).toHaveBeenCalledWith('story', 'episode', expect.objectContaining({ expectedRevision: 1, forceNeedsReview: true }));
    expect(update.mock.calls[0][2].content).toContain('추가 문장.');
    expect(update.mock.calls[0][2].content).toContain('원래 본문.');
  });
});
