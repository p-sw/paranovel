import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Link, MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { api } from '../api/client';
import { episodeBackupKey, readEpisodeDraftBackup, writeEpisodeDraftBackup } from '../episodeBackup';
import type { ContinuityIssue, Episode, StreamEvent, StreamResult } from '../types';
import EpisodeEditorPage from './EpisodeEditorPage';

const emptyEpisode: Episode = {
  id: 'episode', projectId: 'story', number: 1, title: '닫힌 문', direction: '문을 연다.',
  content: '', revision: 2, status: 'INCOMPLETE', summary: null,
  createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z',
};
const issue: ContinuityIssue = {
  category: 'CANON', severity: 'BLOCKING', explanation: '흉터의 위치가 달라졌습니다.',
  evidenceRefs: ['canon:scar'], excerpt: '왼손의 흉터', repairInstruction: '오른손의 흉터로 고칩니다.',
};
let savedEpisodes: Record<string, Episode>;

beforeEach(() => {
  localStorage.clear();
  savedEpisodes = {
    episode: { ...emptyEpisode },
    other: { ...emptyEpisode, id: 'other', number: 2, title: '다른 회차', content: '다른 회차 본문.', status: 'DRAFT' },
  };
  vi.spyOn(api.episodes, 'get').mockImplementation(async (_project, episodeId) => savedEpisodes[episodeId]);
  vi.spyOn(api.episodes, 'list').mockImplementation(async () => Object.values(savedEpisodes));
  vi.spyOn(api.episodes, 'flow').mockImplementation(async () => ({ kind: 'MAIN', label: '회차', group: null, episodes: Object.values(savedEpisodes) }));
  vi.spyOn(api.episodes, 'update').mockImplementation(async (_project, episodeId, input) => {
    const current = savedEpisodes[episodeId];
    const updated: Episode = {
      ...current,
      title: input.title ?? current.title,
      direction: input.direction ?? current.direction,
      content: input.content ?? current.content,
      revision: current.revision + 1,
      status: input.forceNeedsReview || current.status === 'NEEDS_REVIEW' ? 'NEEDS_REVIEW' : input.incomplete ? 'INCOMPLETE' : 'DRAFT',
    };
    savedEpisodes[episodeId] = updated;
    return updated;
  });
  vi.spyOn(api.scenes, 'get').mockImplementation(async (_project, episodeId) => ({
    episodeId, characters: [], location: null, time: null, pointOfView: null, goal: null, sourceRevision: 2,
  }));
});

afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); });

function LocationState() {
  const location = useLocation();
  return <output aria-label="이동 상태">{JSON.stringify(location.state)}</output>;
}

function renderEditor({ request = true, strict = false }: { request?: boolean; strict?: boolean } = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const app = <QueryClientProvider client={queryClient}>
    <MemoryRouter initialEntries={[{ pathname: '/projects/story/episodes/episode', state: request ? { generateEpisode: true, otherState: 'retained' } : null }]}>
      <Link to="/projects/story/episodes/other">다른 원고 열기</Link>
      <LocationState />
      <Routes>
        <Route path="/projects/:projectId/episodes/:episodeId" element={<EpisodeEditorPage />} />
        <Route path="/projects/:projectId/episodes" element={<div>회차 목록</div>} />
      </Routes>
    </MemoryRouter>
  </QueryClientProvider>;
  return { user: userEvent.setup(), ...render(strict ? <StrictMode>{app}</StrictMode> : app) };
}

function pendingGeneration() {
  let event!: (event: StreamEvent, accumulated: string) => void;
  let complete!: (result: StreamResult) => void;
  let fail!: (reason: Error) => void;
  let signal!: AbortSignal;
  const generate = vi.spyOn(api.episodes, 'generate').mockImplementation((_project, _input, onEvent, requestSignal) => {
    event = onEvent;
    signal = requestSignal!;
    return new Promise((resolve, reject) => { complete = resolve; fail = reject; });
  });
  return {
    generate,
    event: (value: StreamEvent, content = '') => act(async () => event(value, content)),
    complete: (result: StreamResult) => act(async () => complete(result)),
    fail: (reason: Error) => act(async () => fail(reason)),
    signal: () => signal,
  };
}

function pendingContinuityReview() {
  let event!: (event: StreamEvent, accumulated: string) => void;
  let complete!: (result: StreamResult) => void;
  let signal!: AbortSignal;
  const review = vi.spyOn(api.episodes, 'reviewContinuity').mockImplementation((_project, _episode, _input, onEvent, requestSignal) => {
    event = onEvent;
    signal = requestSignal!;
    return new Promise((resolve) => { complete = resolve; });
  });
  return {
    review,
    event: (value: StreamEvent, content = '') => act(async () => event(value, content)),
    complete: (result: StreamResult) => act(async () => complete(result)),
    signal: () => signal,
  };
}

describe('new episode generation in the editor', () => {
  it('uses only the current side-story group for labels and previous/next navigation', async () => {
    const first = { ...emptyEpisode, kind: 'SIDE_STORY' as const, sideStoryGroupId: 'group-1', number: 1, status: 'DRAFT' as const };
    const second = { ...first, id: 'other', number: 2, title: '두 번째 외전', content: '외전의 다음 장면.' };
    const main = { ...emptyEpisode, id: 'main', kind: 'MAIN' as const, number: 99, title: '섞이면 안 되는 본편', status: 'DRAFT' as const };
    savedEpisodes = { episode: first, other: second, main };
    vi.mocked(api.episodes.flow).mockResolvedValue({
      kind: 'SIDE_STORY', label: '외전 · 수도 야화',
      group: {
        id: 'group-1', projectId: 'story', title: '수도 야화', description: '', branchFromEpisodeId: null,
        nextEpisodeNumber: 3, revision: 1,
      },
      episodes: [first, second],
    });
    const { user } = renderEditor({ request: false });

    expect(await screen.findByText('외전 1화')).toBeVisible();
    expect(screen.getByText('외전 · 수도 야화')).toBeVisible();
    expect(screen.queryByText('섞이면 안 되는 본편')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '이전 외전' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: '다음 외전' }));
    await waitFor(() => expect(screen.getByRole('textbox', { name: '회차 제목' })).toHaveValue('두 번째 외전'));
    expect(screen.getByText('외전 2화')).toBeVisible();
  });

  it('streams into the main editor once in StrictMode, keeps it readable during review, and saves after review', async () => {
    const stream = pendingGeneration();
    const repair = vi.spyOn(api.episodes, 'repair');
    renderEditor({ strict: true });
    await waitFor(() => expect(stream.generate).toHaveBeenCalledTimes(1));
    expect(stream.generate).toHaveBeenCalledWith('story', {
      title: emptyEpisode.title, direction: emptyEpisode.direction, episodeId: 'episode', expectedRevision: 2,
    }, expect.any(Function), expect.any(AbortSignal));
    await waitFor(() => expect(screen.getByLabelText('이동 상태')).toHaveTextContent('{"otherState":"retained"}'));
    const textarea = screen.getByRole('textbox', { name: '회차 본문' }) as HTMLTextAreaElement;
    expect(textarea.readOnly).toBe(true);
    expect(textarea).toBeEnabled();
    expect(screen.getByRole('button', { name: '편집 AI' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '커서에서 이어쓰기' })).toBeDisabled();
    expect(screen.getByRole('textbox', { name: '회차 제목' })).toBeDisabled();
    const content = '\n  첫 문장.\n\n왼손의 흉터.  \n';
    await stream.event({ type: 'delta', text: content }, content);
    textarea.scrollTop = 160;
    fireEvent.scroll(textarea);
    await stream.event({ type: 'stage', stage: 'CHECKING' }, content);
    await stream.event({ type: 'reset' }, '');
    await stream.event({ type: 'delta', text: '바뀌면 안 되는 본문.' }, '바뀌면 안 되는 본문.');
    expect(screen.getByText('일관성을 확인하는 중')).toBeVisible();
    expect(screen.getByRole('textbox', { name: '회차 본문' })).toBe(textarea);
    expect(textarea).toHaveValue(content);
    expect(textarea.scrollTop).toBe(160);
    await act(async () => new Promise((resolve) => setTimeout(resolve, 800)));
    expect(api.episodes.update).not.toHaveBeenCalled();
    expect(readEpisodeDraftBackup('episode')).toMatchObject({ content, baseRevision: 2, forceNeedsReview: true });
    await stream.complete({ content, issues: [issue], blocked: true, baseRevision: 2 });
    expect(api.episodes.update).toHaveBeenCalledExactlyOnceWith('story', 'episode', {
      expectedRevision: 2, title: emptyEpisode.title, direction: emptyEpisode.direction, content, forceNeedsReview: true,
    });
    expect(textarea.readOnly).toBe(false);
    expect(textarea.scrollTop).toBe(160);
    expect(screen.getByText('검토 완료')).toBeVisible();
    expect(screen.getByText(issue.explanation)).toBeVisible();
    expect(repair).not.toHaveBeenCalled();
    expect(localStorage.getItem(episodeBackupKey('episode'))).toBeNull();
  });

  it.each(['cancel', 'failure'] as const)('saves a partial manuscript for review after %s and ignores late events', async (ending) => {
    const stream = pendingGeneration();
    const { user } = renderEditor();
    await waitFor(() => expect(stream.generate).toHaveBeenCalledTimes(1));
    await stream.event({ type: 'delta', text: '작성 중인 원고.' }, '작성 중인 원고.');
    if (ending === 'cancel') await user.click(screen.getByRole('button', { name: '생성 중단' }));
    else await stream.fail(new Error('검토 연결 실패'));
    await waitFor(() => expect(api.episodes.update).toHaveBeenCalledTimes(1));
    expect(api.episodes.update).toHaveBeenCalledWith('story', 'episode', expect.objectContaining({ content: '작성 중인 원고.', forceNeedsReview: true, expectedRevision: 2 }));
    expect(screen.getByRole('textbox', { name: '회차 본문' })).toHaveValue('작성 중인 원고.');
    expect((screen.getByRole('textbox', { name: '회차 본문' }) as HTMLTextAreaElement).readOnly).toBe(false);
    await stream.event({ type: 'delta', text: '늦은 응답.' }, '늦은 응답.');
    await stream.complete({ content: '늦은 결과.', issues: [], blocked: false });
    expect(screen.getByRole('textbox', { name: '회차 본문' })).toHaveValue('작성 중인 원고.');
    expect(api.episodes.update).toHaveBeenCalledTimes(1);
  });

  it.each(['cancel', 'failure', 'navigate'] as const)('restores the incomplete status when %s occurs before a manuscript arrives', async (ending) => {
    const stream = pendingGeneration();
    const { user } = renderEditor();
    await waitFor(() => expect(stream.generate).toHaveBeenCalledTimes(1));
    if (ending === 'cancel') await user.click(screen.getByRole('button', { name: '생성 중단' }));
    else if (ending === 'failure') await stream.fail(new Error('작성을 시작하지 못했습니다.'));
    else await user.click(screen.getByRole('link', { name: '다른 원고 열기' }));
    await waitFor(() => expect(api.episodes.update).toHaveBeenCalledTimes(1));
    expect(api.episodes.update).toHaveBeenCalledWith('story', 'episode', expect.objectContaining({ content: '', incomplete: true, forceNeedsReview: undefined }));
    expect(savedEpisodes.episode.status).toBe('INCOMPLETE');
  });

  it('aborts on episode navigation, saves only that episode, and ignores its late result', async () => {
    const stream = pendingGeneration();
    const { user } = renderEditor();
    await waitFor(() => expect(stream.generate).toHaveBeenCalledTimes(1));
    await stream.event({ type: 'delta', text: '첫 회차 초안.' }, '첫 회차 초안.');
    await user.click(screen.getByRole('link', { name: '다른 원고 열기' }));
    expect(await screen.findByDisplayValue('다른 회차 본문.')).toBeVisible();
    expect(stream.signal().aborted).toBe(true);
    expect(api.episodes.update).toHaveBeenCalledWith('story', 'episode', expect.objectContaining({ content: '첫 회차 초안.', forceNeedsReview: true }));
    await stream.complete({ content: '늦게 완성된 첫 회차.', issues: [], blocked: false });
    expect(screen.getByRole('textbox', { name: '회차 본문' })).toHaveValue('다른 회차 본문.');
    expect(stream.generate).toHaveBeenCalledTimes(1);
    expect(api.episodes.update).toHaveBeenCalledTimes(1);
  });

  it('waits for backup recovery and retains the recovered partial manuscript with its review flag', async () => {
    const stream = pendingGeneration();
    writeEpisodeDraftBackup('episode', { ...emptyEpisode, content: '복구할 부분 원고.', savedAt: '2026-09-02T00:00:00Z', baseRevision: 2, forceNeedsReview: true });
    const { user } = renderEditor();
    await user.click(await screen.findByRole('button', { name: '백업 복구' }));
    await waitFor(() => expect(screen.getByLabelText('이동 상태')).toHaveTextContent('{"otherState":"retained"}'));
    expect(stream.generate).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox', { name: '회차 본문' })).toHaveValue('복구할 부분 원고.');
    await waitFor(() => expect(api.episodes.update).toHaveBeenCalledWith('story', 'episode', expect.objectContaining({ content: '복구할 부분 원고.', forceNeedsReview: true })));
  });

  it('starts generation after discarding a backup and never starts it for an already written episode', async () => {
    const stream = pendingGeneration();
    writeEpisodeDraftBackup('episode', { ...emptyEpisode, content: '버릴 원고.', savedAt: '2026-09-02T00:00:00Z', baseRevision: 2 });
    const { user, unmount } = renderEditor();
    expect(await screen.findByRole('button', { name: '버리기' })).toBeVisible();
    expect(stream.generate).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '버리기' }));
    await waitFor(() => expect(stream.generate).toHaveBeenCalledTimes(1));
    unmount();
    await act(async () => undefined);
    savedEpisodes.episode = { ...emptyEpisode, content: '기존 원고.', status: 'DRAFT' };
    renderEditor();
    expect(await screen.findByDisplayValue('기존 원고.')).toBeVisible();
    await waitFor(() => expect(screen.getByLabelText('이동 상태')).toHaveTextContent('{"otherState":"retained"}'));
    expect(stream.generate).toHaveBeenCalledTimes(1);
  });

  it('repairs a selected issue against the saved episode and only replaces the body after review', async () => {
    vi.spyOn(api.episodes, 'generate').mockResolvedValue({ content: '왼손의 흉터.', issues: [issue], blocked: true, baseRevision: 2 });
    let completeRepair!: (result: StreamResult) => void;
    let repairEvent!: (event: StreamEvent, content: string) => void;
    const repair = vi.spyOn(api.episodes, 'repair').mockImplementation((_project, _input, onEvent) => {
      repairEvent = onEvent;
      return new Promise((resolve) => { completeRepair = resolve; });
    });
    const { user } = renderEditor();
    const button = await screen.findByRole('button', { name: `자동 수정: ${issue.explanation}` });
    await waitFor(() => expect(button).toBeEnabled());
    await user.click(button);
    expect(repair).toHaveBeenCalledWith('story', {
      title: emptyEpisode.title, direction: emptyEpisode.direction, content: '왼손의 흉터.', issue, episodeId: 'episode', expectedRevision: 3,
    }, expect.any(Function), expect.any(AbortSignal));
    await act(async () => {
      repairEvent({ type: 'delta', text: '수정 중인 원고.' }, '수정 중인 원고.');
      repairEvent({ type: 'stage', stage: 'CHECKING' }, '수정 중인 원고.');
    });
    expect(screen.getByRole('textbox', { name: '회차 본문' })).toHaveValue('왼손의 흉터.');
    expect(api.episodes.update).toHaveBeenCalledTimes(1);
    await act(async () => completeRepair({ content: '오른손의 흉터.', issues: [], blocked: false, baseRevision: 3 }));
    expect(screen.getByRole('textbox', { name: '회차 본문' })).toHaveValue('오른손의 흉터.');
    expect(api.episodes.update).toHaveBeenLastCalledWith('story', 'episode', expect.objectContaining({ content: '오른손의 흉터.', expectedRevision: 3 }));
    expect(savedEpisodes.episode.status).toBe('NEEDS_REVIEW');
    expect(screen.queryByRole('button', { name: `자동 수정: ${issue.explanation}` })).not.toBeInTheDocument();
  });

  it('retries an empty cancelled generation once against the new revision', async () => {
    const stream = pendingGeneration();
    const { user } = renderEditor();
    await waitFor(() => expect(stream.generate).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole('button', { name: '생성 중단' }));
    await waitFor(() => expect(savedEpisodes.episode.revision).toBe(3));
    await user.click(screen.getByRole('button', { name: '다시 생성' }));
    expect(stream.generate).toHaveBeenCalledTimes(2);
    expect(stream.generate).toHaveBeenLastCalledWith('story', expect.objectContaining({ episodeId: 'episode', expectedRevision: 3 }), expect.any(Function), expect.any(AbortSignal));
    await stream.complete({ content: '재시도한 원고.', issues: [], blocked: false, baseRevision: 3 });
    expect(savedEpisodes.episode.status).toBe('DRAFT');
    expect(savedEpisodes.episode.content).toBe('재시도한 원고.');
    expect(api.episodes.update).toHaveBeenCalledTimes(2);
  });
});

describe('manual continuity review in the editor', () => {
  it('saves dirty writing, reviews the current manuscript, persists blocking status, and reuses full-draft repair', async () => {
    savedEpisodes.episode = { ...emptyEpisode, content: '기존 원고.', status: 'DRAFT' };
    const review = pendingContinuityReview();
    const repair = vi.spyOn(api.episodes, 'repair').mockResolvedValue({
      content: '오른손의 흉터.', issues: [], blocked: false, baseRevision: 4,
    });
    const { user } = renderEditor({ request: false });
    const textarea = await screen.findByRole('textbox', { name: '회차 본문' }) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: '왼손의 흉터.' } });

    await user.click(screen.getByRole('button', { name: '일관성 검사' }));
    await waitFor(() => expect(review.review).toHaveBeenCalledTimes(1));
    expect(api.episodes.update).toHaveBeenCalledWith('story', 'episode', expect.objectContaining({
      expectedRevision: 2,
      content: '왼손의 흉터.',
    }));
    expect(review.review).toHaveBeenCalledWith(
      'story',
      'episode',
      { expectedRevision: 3, content: '왼손의 흉터.' },
      expect.any(Function),
      expect.any(AbortSignal),
    );
    expect(textarea.readOnly).toBe(true);
    expect(screen.getByRole('textbox', { name: '회차 제목' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '편집 AI' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '커서에서 이어쓰기' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '일관성 검사' })).toHaveAttribute('aria-busy', 'true');

    await review.event({ type: 'stage', stage: 'MEMORY' }, '왼손의 흉터.');
    expect(screen.getByText('기억을 불러오는 중')).toBeVisible();
    await review.event({ type: 'stage', stage: 'CHECKING' }, '왼손의 흉터.');
    expect(screen.getByText('일관성을 확인하는 중')).toBeVisible();
    await review.complete({ content: '왼손의 흉터.', issues: [issue], blocked: true, baseRevision: 3 });

    await waitFor(() => expect(savedEpisodes.episode.status).toBe('NEEDS_REVIEW'));
    expect(api.episodes.update).toHaveBeenLastCalledWith('story', 'episode', expect.objectContaining({
      expectedRevision: 3,
      content: '왼손의 흉터.',
      forceNeedsReview: true,
    }));
    expect(screen.getByText('일관성 검사 완료')).toBeVisible();
    expect(screen.getByText(issue.explanation)).toBeVisible();
    expect(textarea).toHaveValue('왼손의 흉터.');
    expect(textarea.readOnly).toBe(false);

    await user.click(screen.getByRole('button', { name: `자동 수정: ${issue.explanation}` }));
    await waitFor(() => expect(repair).toHaveBeenCalledWith('story', expect.objectContaining({
      episodeId: 'episode', expectedRevision: 4, content: '왼손의 흉터.', issue,
    }), expect.any(Function), expect.any(AbortSignal)));
    await waitFor(() => expect(textarea).toHaveValue('오른손의 흉터.'));
  });

  it('shows an explicit success result when the current manuscript has no continuity issues', async () => {
    savedEpisodes.episode = { ...emptyEpisode, content: '문제가 없는 원고.', status: 'DRAFT' };
    vi.spyOn(api.episodes, 'reviewContinuity').mockResolvedValue({
      content: '문제가 없는 원고.', issues: [], blocked: false, baseRevision: 2,
    });
    const { user } = renderEditor({ request: false });

    await user.click(await screen.findByRole('button', { name: '일관성 검사' }));

    expect(await screen.findByText('현재 원고에서 일관성 문제를 찾지 못했어요.')).toBeVisible();
    expect(screen.getByText('일관성 검사 완료')).toBeVisible();
    expect(api.episodes.update).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox', { name: '회차 본문' })).toHaveValue('문제가 없는 원고.');
  });

  it('rejects a review result that does not identify the saved manuscript revision', async () => {
    savedEpisodes.episode = { ...emptyEpisode, content: '검사할 원고.', status: 'DRAFT' };
    vi.spyOn(api.episodes, 'reviewContinuity').mockResolvedValue({
      content: '검사할 원고.', issues: [], blocked: false,
    });
    const { user } = renderEditor({ request: false });

    await user.click(await screen.findByRole('button', { name: '일관성 검사' }));

    expect(await screen.findByText('원고가 변경되었습니다. 최신 원고를 확인해 주세요.')).toBeVisible();
    expect(screen.getByText('일관성 검사 실패')).toBeVisible();
    expect(screen.queryByText('현재 원고에서 일관성 문제를 찾지 못했어요.')).not.toBeInTheDocument();
    expect(api.episodes.update).not.toHaveBeenCalled();
  });

  it('removes a completed review once the reviewed manuscript changes', async () => {
    savedEpisodes.episode = { ...emptyEpisode, content: '왼손의 흉터.', status: 'DRAFT' };
    vi.spyOn(api.episodes, 'reviewContinuity').mockResolvedValue({
      content: '왼손의 흉터.', issues: [{ ...issue, severity: 'WARNING' }], blocked: false, baseRevision: 2,
    });
    const { user } = renderEditor({ request: false });
    const textarea = await screen.findByRole('textbox', { name: '회차 본문' });
    await user.click(screen.getByRole('button', { name: '일관성 검사' }));
    expect(await screen.findByText(issue.explanation)).toBeVisible();

    fireEvent.change(textarea, { target: { value: '오른손의 흉터.' } });

    await waitFor(() => expect(screen.queryByText(issue.explanation)).not.toBeInTheDocument());
    expect(screen.queryByText('일관성 검사 완료')).not.toBeInTheDocument();
  });

  it('cancels a continuity review, unlocks the editor, and ignores its late result', async () => {
    savedEpisodes.episode = { ...emptyEpisode, content: '검사할 원고.', status: 'DRAFT' };
    const review = pendingContinuityReview();
    const { user } = renderEditor({ request: false });
    const textarea = await screen.findByRole('textbox', { name: '회차 본문' }) as HTMLTextAreaElement;
    await user.click(screen.getByRole('button', { name: '일관성 검사' }));
    await waitFor(() => expect(review.review).toHaveBeenCalledTimes(1));

    await user.click(screen.getByRole('button', { name: '검사 중단' }));
    expect(review.signal().aborted).toBe(true);
    expect(screen.getByText('일관성 검사 중단됨')).toBeVisible();
    expect(textarea.readOnly).toBe(false);
    await review.complete({ content: '검사할 원고.', issues: [issue], blocked: true, baseRevision: 2 });

    expect(screen.queryByText(issue.explanation)).not.toBeInTheDocument();
    expect(screen.queryByText('현재 원고에서 일관성 문제를 찾지 못했어요.')).not.toBeInTheDocument();
    expect(savedEpisodes.episode.status).toBe('DRAFT');
  });

  it('keeps the manuscript editable and exposes a retry after continuity review failure', async () => {
    savedEpisodes.episode = { ...emptyEpisode, content: '보존할 원고.', status: 'DRAFT' };
    vi.spyOn(api.episodes, 'reviewContinuity').mockRejectedValue(new Error('일관성 검사 연결 실패'));
    const { user } = renderEditor({ request: false });
    const textarea = await screen.findByRole('textbox', { name: '회차 본문' }) as HTMLTextAreaElement;

    await user.click(screen.getByRole('button', { name: '일관성 검사' }));

    expect(await screen.findByText('일관성 검사 연결 실패')).toBeVisible();
    expect(screen.getByText('일관성 검사 실패')).toBeVisible();
    expect(textarea).toHaveValue('보존할 원고.');
    expect(textarea.readOnly).toBe(false);
    expect(screen.getByRole('button', { name: '일관성 검사' })).toBeEnabled();
  });
});
