import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { api } from '../api/client';
import type { ContinuityIssue, Episode, StreamEvent, StreamResult } from '../types';
import EpisodeEditorPage from './EpisodeEditorPage';

const episode: Episode = {
  id: 'episode', projectId: 'story', number: 1, title: '닫힌 문', direction: '문을 연다.',
  content: '원래 본문.', revision: 1, status: 'DRAFT', summary: null,
  createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z',
};

const warnings: ContinuityIssue[] = [
  {
    category: 'STYLE', severity: 'WARNING', excerpt: '먼저 쓴 제안.',
    explanation: '서술 시제가 앞 문장과 다릅니다.', evidenceRefs: [], repairInstruction: '과거 시제로 통일합니다.',
  },
  {
    category: 'TIMELINE', severity: 'WARNING', excerpt: '다음 날',
    explanation: '장면 전환 시간이 불분명합니다.', evidenceRefs: ['scene:episode'], repairInstruction: '같은 날 저녁으로 명시합니다.',
  },
];

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
  it('repairs the selected warning using the edited suggestion and inserts the reviewed result at the original revision', async () => {
    const continuation = vi.spyOn(api.episodes, 'continue').mockResolvedValue({ content: '먼저 쓴 제안.', issues: warnings, blocked: false });
    let completeRepair!: (result: StreamResult) => void;
    let repairEvent!: (event: StreamEvent, content: string) => void;
    const repair = vi.spyOn(api.episodes, 'repairContinuation').mockImplementation((_project, _episode, _input, onEvent) => {
      repairEvent = onEvent;
      return new Promise((resolve) => { completeRepair = resolve; });
    });
    const update = vi.spyOn(api.episodes, 'update').mockResolvedValue({ ...episode, content: '자동으로 고친 제안.원래 본문.', revision: 2 });
    const { user, dialog } = await openContinuation();
    const textarea = await dialog.findByLabelText('이어쓰기 제안 수정') as HTMLTextAreaElement;
    await user.clear(textarea);
    await user.type(textarea, '직접 다듬은 제안.');
    await user.click(dialog.getByRole('button', { name: `자동 수정: ${warnings[1].explanation}` }));

    const cursorOffset = continuation.mock.calls[0][2].cursorOffset;
    expect(repair).toHaveBeenCalledWith('story', 'episode', {
      expectedRevision: 1, cursorOffset, content: '직접 다듬은 제안.', issue: warnings[1],
    }, expect.any(Function), expect.any(AbortSignal));
    expect(textarea.readOnly).toBe(true);
    expect(dialog.getByRole('button', { name: '커서에 삽입' })).toBeDisabled();
    expect(dialog.getByRole('button', { name: '다시 생성' })).toBeDisabled();
    dialog.getAllByRole('button', { name: /^자동 수정:/ }).forEach((button) => expect(button).toBeDisabled());
    await act(async () => {
      repairEvent({ type: 'reset' }, '');
      repairEvent({ type: 'delta', text: '검토 전 수정본.' }, '검토 전 수정본.');
      repairEvent({ type: 'stage', stage: 'CHECKING' }, '검토 전 수정본.');
    });
    expect(textarea).toHaveValue('직접 다듬은 제안.');
    expect(dialog.getByText('일관성을 확인하는 중')).toBeVisible();
    expect(update).not.toHaveBeenCalled();

    await act(async () => { completeRepair({ content: '자동으로 고친 제안.', issues: [warnings[0]], blocked: false }); });
    expect(textarea).toHaveValue('자동으로 고친 제안.');
    expect(textarea.readOnly).toBe(false);
    expect(dialog.queryByRole('button', { name: `자동 수정: ${warnings[1].explanation}` })).not.toBeInTheDocument();
    expect(dialog.getByRole('button', { name: `자동 수정: ${warnings[0].explanation}` })).toBeEnabled();
    expect(update).not.toHaveBeenCalled();
    await user.click(dialog.getByRole('button', { name: '커서에 삽입' }));
    expect(update).toHaveBeenCalledWith('story', 'episode', {
      expectedRevision: 1,
      content: `${episode.content.slice(0, cursorOffset)}자동으로 고친 제안.${episode.content.slice(cursorOffset)}`,
      forceNeedsReview: undefined,
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it.each(['failure', 'cancel'] as const)('preserves the suggestion and unresolved issues after repair %s', async (ending) => {
    const blockingIssue: ContinuityIssue = { ...warnings[0], severity: 'BLOCKING' };
    vi.spyOn(api.episodes, 'continue').mockResolvedValue({ content: '검토를 마친 제안.', issues: [blockingIssue, warnings[1]], blocked: true });
    let completeRepair!: (result: StreamResult) => void;
    let failRepair!: (reason: Error) => void;
    let signal!: AbortSignal;
    const repair = vi.spyOn(api.episodes, 'repairContinuation').mockImplementation((_project, _episode, _input, _onEvent, requestSignal) => {
      signal = requestSignal!;
      return new Promise((resolve, reject) => { completeRepair = resolve; failRepair = reject; });
    });
    const update = vi.spyOn(api.episodes, 'update').mockResolvedValue({ ...episode, revision: 2, status: 'NEEDS_REVIEW' });
    const { user, dialog } = await openContinuation();
    const textarea = await dialog.findByLabelText('이어쓰기 제안 수정') as HTMLTextAreaElement;
    await user.click(dialog.getByRole('button', { name: `자동 수정: ${warnings[1].explanation}` }));
    expect(repair).toHaveBeenCalledTimes(1);
    if (ending === 'failure') {
      await act(async () => { failRepair(new Error('선택한 문제 수정에 실패했습니다.')); });
      expect(dialog.getByText('선택한 문제 수정에 실패했습니다.')).toBeVisible();
    } else {
      await user.click(dialog.getByRole('button', { name: '중단' }));
      expect(signal.aborted).toBe(true);
      await act(async () => { completeRepair({ content: '늦게 도착한 수정본.', issues: [], blocked: false }); });
    }

    expect(textarea).toHaveValue('검토를 마친 제안.');
    expect(textarea.readOnly).toBe(false);
    expect(dialog.getByText('검토 완료')).toBeVisible();
    expect(dialog.getByRole('button', { name: `자동 수정: ${warnings[1].explanation}` })).toBeEnabled();
    expect(dialog.getByRole('button', { name: `자동 수정: ${blockingIssue.explanation}` })).toBeEnabled();
    expect(update).not.toHaveBeenCalled();
    await user.click(dialog.getByRole('button', { name: '검토 필요로 삽입' }));
    expect(update).toHaveBeenCalledWith('story', 'episode', expect.objectContaining({
      expectedRevision: 1, forceNeedsReview: true,
    }));
    expect(update.mock.calls[0][2].content).toContain('검토를 마친 제안.');
  });

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
