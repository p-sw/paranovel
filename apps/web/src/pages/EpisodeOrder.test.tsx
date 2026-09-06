import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Link, MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import type { Episode, EpisodeOrder } from '@paranovel/contracts';
import { api, ApiError } from '../api/client';
import EpisodesPage from './EpisodesPage';

function episode(id: string, number: number): Episode {
  return { id, number, projectId: 'story', title: `원고 ${id}`, direction: '전개 방향', content: '본문', revision: 1,
    status: 'DRAFT', createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' };
}
function order(slots: Array<string | null>, revision = 'original'): EpisodeOrder {
  return { slots, revision, episodes: slots.flatMap((id, index) => id ? [episode(id, index + 1)] : []) };
}
function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/projects/story/episodes']}>
        <Link to="/projects/other/episodes">다른 프로젝트</Link>
        <Routes>
          <Route path="/projects/:projectId" element={<Outlet context={{ project: { genreTags: ['판타지'], logline: '이야기' } }} />}>
            <Route path="episodes" element={<EpisodesPage />} />
            <Route path="episodes/:episodeId" element={<p>원고 편집기</p>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...view, client };
}
function rows() {
  return within(screen.getByRole('region', { name: '회차 목록' })).getAllByRole('article');
}
function titles() {
  return rows().map((row) => within(row).getByRole('heading').textContent);
}

beforeEach(() => {
  vi.spyOn(api.episodes, 'order').mockResolvedValue(order([null, 'b', null, 'd', null]));
  vi.spyOn(api.sideStories, 'list').mockResolvedValue({ standalone: [], groups: [] });
  vi.spyOn(api.episodes, 'updateOrder').mockImplementation(async (_projectId, input) => {
    const saved = order(input.slots, 'saved');
    vi.mocked(api.episodes.order).mockResolvedValue(saved);
    return saved;
  });
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  // Supply browser layout/animation primitives, while keeping the actual dnd-kit sensors and sorting plugin.
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const row = this.closest('.episode-row');
    const index = row?.parentElement ? Array.from(row.parentElement.children).indexOf(row) : 0;
    return DOMRect.fromRect({ x: 0, y: row ? 100 + index * 130 : 0, width: 700, height: row ? 120 : 768 });
  });
  Object.defineProperty(Element.prototype, 'getAnimations', { configurable: true, value: () => [] });
  Object.defineProperty(Document.prototype, 'getAnimations', { configurable: true, value: () => [] });
  Object.defineProperty(Element.prototype, 'animate', { configurable: true, value: () => ({ finished: Promise.resolve(), cancel() {} }) });
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: () => undefined });
  vi.stubGlobal('scrollBy', () => undefined);
  const reportError = console.error.bind(console);
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    // jsdom's stylesheet parser does not support dnd-kit's nested @layer rules.
    if (String(args[0]).includes('Could not parse CSS stylesheet') && String(args[1]).includes('@layer dnd-kit')) return;
    reportError(...args);
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('episode order editor', () => {
  it('shows leading, interior, and trailing gaps, with navigation only for real episodes', async () => {
    renderPage();
    await screen.findByRole('heading', { name: '원고 d' });
    expect(titles()).toEqual(['빈 회차', '원고 d', '빈 회차', '원고 b', '빈 회차']);
    expect(rows().map((row) => row.querySelector('.episode-number')?.textContent)).toEqual(['5화', '4화', '3화', '2화', '1화']);
    expect(within(screen.getByRole('region', { name: '회차 목록' })).getAllByRole('link')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: /빈 회차 삭제/ })).not.toBeInTheDocument();
    expect(screen.queryByText('첫 회차가 기다리고 있어요')).not.toBeInTheDocument();
  });

  it('removes only placeholders, immediately renumbers, blocks opening cards, and discards changes on cancel', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('heading', { name: '원고 d' });
    await user.click(screen.getByRole('button', { name: '수정' }));
    expect(screen.getByRole('button', { name: '새 회차' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: /화 메뉴/ })).not.toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: '회차 목록' })).queryByRole('link')).not.toBeInTheDocument();
    await user.click(screen.getByRole('heading', { name: '원고 d' }));
    await user.keyboard('{Enter}');
    expect(screen.queryByText('원고 편집기')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '1화 빈 회차 삭제' }));
    expect(rows()).toHaveLength(4);
    expect(screen.getByRole('button', { name: '1화 원고 b 순서 이동' })).toBeVisible();
    expect(api.episodes.updateOrder).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '취소' }));
    expect(rows()).toHaveLength(5);
    expect(screen.getByRole('button', { name: '새 회차' })).toBeEnabled();
    expect(screen.getByRole('link', { name: /원고 d/ })).toHaveAttribute('href', '/projects/story/episodes/d');
  });

  it('saves placeholders in ascending slot order, refreshes related caches, and keeps trailing placeholders after remount', async () => {
    const user = userEvent.setup();
    const view = renderPage();
    const invalidate = vi.spyOn(view.client, 'invalidateQueries');
    await screen.findByRole('heading', { name: '원고 d' });
    await user.click(screen.getByRole('button', { name: '수정' }));
    await user.click(screen.getByRole('button', { name: '3화 빈 회차 삭제' }));
    await user.click(screen.getByRole('button', { name: '완료' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: '취소' })).not.toBeInTheDocument());
    expect(api.episodes.updateOrder).toHaveBeenCalledWith('story', { slots: [null, 'b', 'd', null], expectedRevision: 'original' });
    expect(titles()).toEqual(['빈 회차', '원고 d', '원고 b', '빈 회차']);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['episodes', 'story'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['episode-flow', 'story'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['scene', 'story'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['side-stories', 'story'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['side-story-groups', 'story'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['side-story-group', 'story'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['projects'] });
    view.unmount();
    vi.mocked(api.episodes.order).mockResolvedValue(order([null, 'b', 'd', null], 'saved'));
    renderPage();
    await screen.findByRole('heading', { name: '원고 d' });
    expect(titles()).toEqual(['빈 회차', '원고 d', '원고 b', '빈 회차']);
  });

  it('shows placeholder-only lists and waits until save to show the first-episode state', async () => {
    vi.mocked(api.episodes.order).mockResolvedValue(order([null, null]));
    const user = userEvent.setup();
    renderPage();
    await screen.findAllByRole('heading', { name: '빈 회차' });
    expect(screen.queryByText('첫 회차가 기다리고 있어요')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '수정' }));
    await user.click(screen.getByRole('button', { name: '2화 빈 회차 삭제' }));
    await user.click(screen.getByRole('button', { name: '1화 빈 회차 삭제' }));
    expect(screen.queryByText('첫 회차가 기다리고 있어요')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '완료' }));
    expect(await screen.findByText('첫 회차가 기다리고 있어요')).toBeVisible();
    expect(api.episodes.updateOrder).toHaveBeenCalledWith('story', { slots: [], expectedRevision: 'original' });
  });

  it('locks every edit control while saving, retains the draft after failure, and retries the same change', async () => {
    let rejectSave!: (reason: Error) => void;
    vi.mocked(api.episodes.updateOrder).mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectSave = reject; }));
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('heading', { name: '원고 d' });
    await user.click(screen.getByRole('button', { name: '수정' }));
    await user.click(screen.getByRole('button', { name: '1화 빈 회차 삭제' }));
    await user.click(screen.getByRole('button', { name: '완료' }));
    for (const button of screen.getAllByRole('button')) expect(button).toBeDisabled();
    await act(async () => rejectSave(new Error('연결이 끊겼어요.')));
    expect(await screen.findByRole('alert')).toHaveTextContent('연결이 끊겼어요.');
    expect(rows()).toHaveLength(4);
    await user.click(screen.getByRole('button', { name: '다시 시도' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: '취소' })).not.toBeInTheDocument());
    expect(api.episodes.updateOrder).toHaveBeenCalledTimes(2);
    expect(vi.mocked(api.episodes.updateOrder).mock.calls[0]).toEqual(vi.mocked(api.episodes.updateOrder).mock.calls[1]);
  });

  it('preserves conflicted edits until explicitly reloading and then saves against the latest revision', async () => {
    vi.mocked(api.episodes.updateOrder).mockRejectedValueOnce(new ApiError('Conflict', 409));
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('heading', { name: '원고 d' });
    await user.click(screen.getByRole('button', { name: '수정' }));
    await user.click(screen.getByRole('button', { name: '1화 빈 회차 삭제' }));
    await user.click(screen.getByRole('button', { name: '완료' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('다른 곳에서 변경됐어요');
    expect(rows()).toHaveLength(4);
    expect(screen.getByRole('button', { name: '완료' })).toBeDisabled();
    vi.mocked(api.episodes.order).mockRejectedValueOnce(new Error('목록을 불러오지 못했어요.'));
    await user.click(screen.getByRole('button', { name: '최신 목록 다시 불러오기' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('목록을 불러오지 못했어요.');
    expect(rows()).toHaveLength(4);
    vi.mocked(api.episodes.order).mockResolvedValue(order(['b', 'd', 'e'], 'latest'));
    await user.click(screen.getByRole('button', { name: '최신 목록 다시 불러오기' }));
    expect(await screen.findByRole('button', { name: '3화 원고 e 순서 이동' })).toBeVisible();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '완료' }));
    expect(api.episodes.updateOrder).toHaveBeenLastCalledWith('story', { slots: ['b', 'd', 'e'], expectedRevision: 'latest' });
  });

  it('uses the real keyboard drag sensor to move a placeholder and save its new position', async () => {
    vi.mocked(api.episodes.order).mockResolvedValue(order(['a', null, 'c']));
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('heading', { name: '원고 c' });
    await user.click(screen.getByRole('button', { name: '수정' }));
    const handle = screen.getByRole('button', { name: '2화 빈 회차 순서 이동' });
    handle.focus();
    await user.keyboard('[Space]');
    await waitFor(() => expect(screen.getByRole('button', { name: '완료' })).toBeDisabled());
    await user.keyboard('[ArrowUp]');
    await waitFor(() => expect(titles()[0]).toBe('빈 회차'));
    await user.keyboard('[Space]');
    await waitFor(() => expect(screen.getByRole('button', { name: '완료' })).toBeEnabled());
    expect(screen.getByRole('button', { name: '3화 빈 회차 순서 이동' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: '완료' }));
    expect(api.episodes.updateOrder).toHaveBeenCalledWith('story', { slots: ['a', 'c', null], expectedRevision: 'original' });
  });

  it('restores the current draft when a keyboard drag is canceled with Escape', async () => {
    vi.mocked(api.episodes.order).mockResolvedValue(order(['a', null, 'c']));
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('heading', { name: '원고 c' });
    await user.click(screen.getByRole('button', { name: '수정' }));
    screen.getByRole('button', { name: '3화 원고 c 순서 이동' }).focus();
    await user.keyboard('[Space]');
    await waitFor(() => expect(screen.getByRole('button', { name: '완료' })).toBeDisabled());
    await user.keyboard('[ArrowDown]');
    await waitFor(() => expect(titles()[0]).toBe('빈 회차'));
    await user.keyboard('[Escape]');
    await waitFor(() => expect(screen.getByRole('button', { name: '완료' })).toBeEnabled());
    expect(titles()).toEqual(['원고 c', '빈 회차', '원고 a']);
    await user.click(screen.getByRole('button', { name: '완료' }));
    expect(api.episodes.updateOrder).toHaveBeenCalledWith('story', { slots: ['a', null, 'c'], expectedRevision: 'original' });
  });

  it('keeps a late save result in its original project cache after navigation', async () => {
    let finishSave!: (value: EpisodeOrder) => void;
    vi.mocked(api.episodes.updateOrder).mockImplementationOnce(() => new Promise((resolve) => { finishSave = resolve; }));
    const user = userEvent.setup();
    const { client } = renderPage();
    await screen.findByRole('heading', { name: '원고 d' });
    await user.click(screen.getByRole('button', { name: '수정' }));
    await user.click(screen.getByRole('button', { name: '1화 빈 회차 삭제' }));
    await user.click(screen.getByRole('button', { name: '완료' }));
    vi.mocked(api.episodes.order).mockResolvedValue(order(['other-episode'], 'other-revision'));
    await user.click(screen.getByRole('link', { name: '다른 프로젝트' }));
    await screen.findByRole('heading', { name: '원고 other-episode' });
    await act(async () => finishSave(order(['b', null, 'd', null], 'old-project-saved')));
    expect(client.getQueryData<EpisodeOrder>(['episode-order', 'story'])?.revision).toBe('old-project-saved');
    expect(client.getQueryData<EpisodeOrder>(['episode-order', 'other'])?.revision).toBe('other-revision');
    expect(screen.getByRole('heading', { name: '원고 other-episode' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: '원고 d' })).not.toBeInTheDocument();
  });

  it('drops the previous project draft when navigating to another project', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('heading', { name: '원고 d' });
    await user.click(screen.getByRole('button', { name: '수정' }));
    vi.mocked(api.episodes.order).mockResolvedValue(order(['other-episode'], 'other-revision'));
    await user.click(screen.getByRole('link', { name: '다른 프로젝트' }));
    expect(await screen.findByRole('heading', { name: '원고 other-episode' })).toBeVisible();
    expect(screen.queryByRole('button', { name: '취소' })).not.toBeInTheDocument();
    expect(api.episodes.order).toHaveBeenLastCalledWith('other');
    expect(api.episodes.updateOrder).not.toHaveBeenCalled();
  });
});
