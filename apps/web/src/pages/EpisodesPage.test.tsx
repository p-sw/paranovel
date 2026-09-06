import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Outlet, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';
import type { EpisodeOrder } from '@paranovel/contracts';
import { api } from '../api/client';
import type { CanonEntry, Episode, SideStoryGroup } from '../types';
import CanonPage from './CanonPage';
import EpisodesPage from './EpisodesPage';

const proposal = {
  title: '닫힌 문 너머',
  direction: '기록관이 사라진 동료의 흔적을 따라 왕궁에 들어간다.',
  conflicts: [],
};

const pendingCanon: CanonEntry = {
  id: 'pending', projectId: 'story', category: 'CHARACTER', name: '검토할 인물', aliases: [],
  content: '기억을 읽는 기록관', metadata: {}, revision: 1, status: 'PENDING',
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
};

const incompleteEpisode: Episode = {
  id: 'episode-1', projectId: 'story', number: 1,
  title: proposal.title, direction: proposal.direction, content: '', revision: 1,
  status: 'INCOMPLETE', summary: null,
  createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z',
};
let persistedEpisodes: Episode[];
const createdByKey = new Map<string, Episode>();
let navigateRouter: ReturnType<typeof useNavigate>;

function NavigationProbe() {
  navigateRouter = useNavigate();
  return null;
}

function EditorRoute() {
  const { episodeId } = useParams();
  const location = useLocation();
  return <div data-testid="editor-route">{JSON.stringify({ episodeId, state: location.state })}</div>;
}

function renderPage(cachedCanon?: CanonEntry[], initialEntry = '/projects/story/episodes', cachedOrder?: EpisodeOrder) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  if (cachedOrder) queryClient.setQueryData(['episode-order', 'story'], cachedOrder);
  if (cachedCanon) {
    queryClient.setQueryDefaults(['canon', 'story'], { staleTime: Infinity });
    queryClient.setQueryData(['canon', 'story'], cachedCanon);
  }
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <NavigationProbe />
        <Routes>
          <Route path="/elsewhere" element={<div data-testid="elsewhere-route">다른 페이지</div>} />
          <Route path="/projects/:projectId" element={<Outlet context={{ project: { genreTags: ['판타지'], logline: '기록관의 모험' } }} />}>
            <Route path="episodes" element={<EpisodesPage />} />
            <Route path="episodes/:episodeId" element={<EditorRoute />} />
            <Route path="canon" element={<CanonPage />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  persistedEpisodes = [];
  createdByKey.clear();
  vi.spyOn(api.episodes, 'order').mockImplementation(async () => ({
    episodes: [...persistedEpisodes], slots: persistedEpisodes.map((episode) => episode.id),
    revision: persistedEpisodes.map((episode) => `${episode.id}:${episode.revision}`).join(',') || 'initial',
  }));
  vi.spyOn(api.episodes, 'create').mockImplementation(async (_projectId, input, key) => {
    const existing = createdByKey.get(key);
    if (existing) return existing;
    const episode: Episode = {
      ...incompleteEpisode, id: `episode-${persistedEpisodes.length + 1}`, number: persistedEpisodes.length + 1,
      title: input.title, direction: input.direction, content: input.content ?? '',
      status: input.incomplete ? 'INCOMPLETE' : 'DRAFT',
    };
    persistedEpisodes.push(episode);
    createdByKey.set(key, episode);
    return episode;
  });
  vi.spyOn(api.episodes, 'update').mockImplementation(async (_projectId, episodeId, input) => {
    const current = persistedEpisodes.find((episode) => episode.id === episodeId);
    if (!current || current.revision !== input.expectedRevision) throw new Error('회차가 변경됐어요.');
    const episode: Episode = {
      ...current, title: input.title ?? current.title, direction: input.direction ?? current.direction,
      content: input.content ?? current.content, revision: current.revision + 1,
      status: input.incomplete === true ? 'INCOMPLETE' : input.incomplete === false ? 'DRAFT' : current.status,
    };
    persistedEpisodes = persistedEpisodes.map((item) => item.id === episodeId ? episode : item);
    return episode;
  });
  vi.spyOn(api.episodes, 'propose').mockResolvedValue(proposal);
  vi.spyOn(api.sideStories, 'list').mockResolvedValue({ standalone: [], groups: [] });
  vi.spyOn(api.canon, 'list').mockResolvedValue([]);
});

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function openCreator() {
  const user = userEvent.setup();
  renderPage();
  await user.click(screen.getByRole('button', { name: '새 회차' }));
  await screen.findByRole('dialog', { name: '새 회차 만들기' });
  return user;
}

describe('new episode flow', () => {
  it.each(['새 회차', '첫 회차 만들기'])('checks current canon before %s and lets the user cancel or continue past the warning', async (entryPoint) => {
    vi.mocked(api.canon.list).mockResolvedValue([
      pendingCanon,
      { ...pendingCanon, id: 'pending-location', category: 'LOCATION' },
      { ...pendingCanon, id: 'active', status: 'ACTIVE' },
      { ...pendingCanon, id: 'accepted', status: 'ACCEPTED' },
      { ...pendingCanon, id: 'rejected', status: 'REJECTED' },
    ]);
    const generate = vi.spyOn(api.episodes, 'generate').mockResolvedValue({ content: '새 회차 본문', issues: [], blocked: false });
    const create = vi.mocked(api.episodes.create);
    const user = userEvent.setup();
    renderPage([]);
    await user.click(await screen.findByRole('button', { name: entryPoint }));

    const warning = await screen.findByRole('alertdialog', { name: '검토 중인 정사가 있어요' });
    expect(warning).toHaveAccessibleDescription(/검토 중인 정사 2개는 승인 전까지/);
    expect(screen.queryByRole('dialog', { name: '새 회차 만들기' })).not.toBeInTheDocument();
    expect(api.episodes.propose).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    await user.click(within(warning).getByRole('button', { name: '취소' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: entryPoint }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: '계속 만들기' }));
    expect(api.canon.list).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    await screen.findByRole('dialog', { name: '새 회차 만들기' });
    await user.click(screen.getByRole('button', { name: '다음' }));
    await user.click(await screen.findByRole('button', { name: 'AI 회차 작성' }));
    expect(await screen.findByTestId('editor-route')).toHaveTextContent(JSON.stringify({ episodeId: 'episode-1', state: { generateEpisode: true } }));
    expect(generate).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('opens only pending canon from the warning without starting episode planning', async () => {
    vi.mocked(api.canon.list).mockResolvedValue([
      pendingCanon, { ...pendingCanon, id: 'active', status: 'ACTIVE', name: '확정된 인물' },
    ]);
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: '새 회차' }));
    const warning = await screen.findByRole('alertdialog');
    await user.click(within(warning).getByRole('link', { name: '정사 검토하기' }));

    expect(await screen.findByRole('checkbox', { name: '검토 중만 보기' })).toBeChecked();
    expect(await screen.findByRole('heading', { name: pendingCanon.name })).toBeVisible();
    expect(screen.queryByRole('heading', { name: '확정된 인물' })).not.toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(api.episodes.propose).not.toHaveBeenCalled();
  });

  it('waits for the canon check, keeps creation closed on failure, and retries with the latest status', async () => {
    let fail!: (reason: Error) => void;
    vi.mocked(api.canon.list)
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }))
      .mockResolvedValueOnce([{ ...pendingCanon, status: 'ACTIVE' }]);
    const user = userEvent.setup();
    renderPage([pendingCanon]);
    await user.click(screen.getByRole('button', { name: '새 회차' }));
    expect(screen.getByRole('button', { name: '새 회차' })).toBeDisabled();
    expect(await screen.findByRole('button', { name: '첫 회차 만들기' })).toBeDisabled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(api.episodes.propose).not.toHaveBeenCalled();

    await act(async () => fail(new Error('정사 조회 실패')));
    expect(await screen.findByRole('alert')).toHaveTextContent('검토 중인 정사를 확인하지 못했어요. 정사 조회 실패');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '다시 시도' }));
    expect(await screen.findByRole('dialog', { name: '새 회차 만들기' })).toBeVisible();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(screen.queryByText(/정사 조회 실패/)).not.toBeInTheDocument();
    expect(api.canon.list).toHaveBeenCalledTimes(2);
  });

  it('repeatedly refines and persists the same episode with revision context before starting AI writing', async () => {
    vi.mocked(api.episodes.propose).mockResolvedValueOnce({ ...proposal, conflicts: ['처음 제안에서 확인할 충돌'] });
    const firstRefinement = {
      title: '문틈의 흔적', direction: '기록관이 동료가 남긴 표식을 살피며 왕궁에 잠입한다.', conflicts: ['개선 후 확인할 충돌'],
    };
    const finalRefinement = {
      title: '비밀의 표식', direction: `${firstRefinement.direction} 경비대와는 마주치지 않는다.`, conflicts: [],
    };
    const refine = vi.spyOn(api.episodes, 'refine')
      .mockResolvedValueOnce(firstRefinement)
      .mockResolvedValueOnce(finalRefinement);
    const generate = vi.spyOn(api.episodes, 'generate').mockResolvedValue({ content: '표식을 따라간 최종 초안.', issues: [], blocked: false });
    const create = vi.mocked(api.episodes.create);
    const user = await openCreator();
    await user.click(screen.getByRole('button', { name: '다음' }));

    const title = await screen.findByLabelText('회차 제목');
    const direction = screen.getByLabelText('전개 방향');
    const instruction = screen.getByLabelText('개선 요청');
    await user.clear(title);
    await user.type(title, '  직접 다듬은 제목  ');
    await user.clear(direction);
    await user.type(direction, '  동료의 표식을 발견하고 왕궁에 잠입한다.\n');
    await user.type(instruction, '  잠입 장면만 더 긴장감 있게 해 줘  ');
    await user.click(screen.getByRole('button', { name: '개선' }));

    expect(refine).toHaveBeenNthCalledWith(1, 'story', {
      episodeId: 'episode-1', expectedRevision: 1,
      title: '  직접 다듬은 제목  ', direction: '  동료의 표식을 발견하고 왕궁에 잠입한다.\n', instruction: '잠입 장면만 더 긴장감 있게 해 줘',
    }, expect.any(AbortSignal));
    expect(title).toHaveValue(firstRefinement.title);
    expect(direction).toHaveValue(firstRefinement.direction);
    expect(instruction).toHaveValue('');
    expect(screen.queryByText('처음 제안에서 확인할 충돌')).not.toBeInTheDocument();
    expect(screen.getByText('개선 후 확인할 충돌')).toBeVisible();

    await user.clear(title);
    await user.type(title, '표식의 비밀');
    await user.type(direction, ' 경비대와는 마주치지 않는다.');
    await user.type(instruction, '표식의 의미를 암시하도록 제목만 다듬어 줘');
    await user.click(screen.getByRole('button', { name: '개선' }));

    expect(refine).toHaveBeenNthCalledWith(2, 'story', {
      episodeId: 'episode-1', expectedRevision: 2,
      title: '표식의 비밀', direction: `${firstRefinement.direction} 경비대와는 마주치지 않는다.`, instruction: '표식의 의미를 암시하도록 제목만 다듬어 줘',
    }, expect.any(AbortSignal));
    expect(title).toHaveValue(finalRefinement.title);
    expect(direction).toHaveValue(finalRefinement.direction);
    expect(instruction).toHaveValue('');
    expect(screen.queryByText('개선 후 확인할 충돌')).not.toBeInTheDocument();
    expect(api.episodes.propose).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: 'AI 회차 작성' }));
    expect(await screen.findByTestId('editor-route')).toHaveTextContent(JSON.stringify({ episodeId: 'episode-1', state: { generateEpisode: true } }));
    expect(generate).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(1);
    expect(api.episodes.update).toHaveBeenLastCalledWith('story', 'episode-1', {
      expectedRevision: 2, title: finalRefinement.title, direction: finalRefinement.direction, incomplete: true,
    });
    expect(persistedEpisodes).toHaveLength(1);
    expect(persistedEpisodes[0]).toMatchObject({ title: finalRefinement.title, direction: finalRefinement.direction, status: 'INCOMPLETE' });
  });

  it('requires a nonblank improvement request, title, and direction before refining', async () => {
    const refine = vi.spyOn(api.episodes, 'refine');
    const user = await openCreator();
    await user.click(screen.getByRole('button', { name: '다음' }));

    const instruction = await screen.findByLabelText('개선 요청');
    const button = screen.getByRole('button', { name: '개선' });
    expect(button).toBeDisabled();
    await user.type(instruction, '  \n  ');
    expect(button).toBeDisabled();
    await user.clear(instruction);
    await user.type(instruction, '결말에 여운을 더해 줘');
    expect(button).toBeEnabled();

    const title = screen.getByLabelText('회차 제목');
    await user.clear(title);
    expect(button).toBeDisabled();
    await user.type(title, '   ');
    expect(button).toBeDisabled();
    await user.clear(title);
    await user.type(title, proposal.title);
    const direction = screen.getByLabelText('전개 방향');
    await user.clear(direction);
    expect(button).toBeDisabled();
    await user.type(direction, ' \n ');
    expect(button).toBeDisabled();
    await user.clear(direction);
    await user.type(direction, proposal.direction);
    expect(button).toBeEnabled();
    expect(refine).not.toHaveBeenCalled();
  });

  it('keeps refinements, manual edits, and an unsent improvement request when returning through an unchanged initial request', async () => {
    const refined = { title: '개선한 제목', direction: '개선한 전개 방향', conflicts: ['개선한 전개에서 확인할 충돌'] };
    const refine = vi.spyOn(api.episodes, 'refine').mockResolvedValueOnce(refined);
    const user = await openCreator();
    await user.type(screen.getByLabelText(/이번 회차에 원하는 것/), '왕궁 잠입');
    await user.click(screen.getByRole('button', { name: '다음' }));
    await user.type(await screen.findByLabelText('개선 요청'), '마지막 장면을 다듬어 줘');
    await user.click(screen.getByRole('button', { name: '개선' }));
    await user.type(screen.getByLabelText('회차 제목'), ' 직접 수정');
    await user.type(screen.getByLabelText('전개 방향'), ' 직접 추가한 장면.');
    await user.type(screen.getByLabelText('개선 요청'), '제목을 조금 더 짧게 다듬어 줘');
    await user.click(screen.getByRole('button', { name: '이전' }));

    expect(screen.getByLabelText(/이번 회차에 원하는 것/)).toHaveValue('왕궁 잠입');
    await user.click(screen.getByRole('button', { name: '다음' }));

    expect(await screen.findByLabelText('회차 제목')).toHaveValue(`${refined.title} 직접 수정`);
    expect(screen.getByLabelText('전개 방향')).toHaveValue(`${refined.direction} 직접 추가한 장면.`);
    expect(screen.getByLabelText('개선 요청')).toHaveValue('제목을 조금 더 짧게 다듬어 줘');
    expect(screen.getByText('개선한 전개에서 확인할 충돌')).toBeVisible();
    expect(api.episodes.propose).toHaveBeenCalledTimes(1);
    expect(refine).toHaveBeenCalledTimes(1);
  });

  it('preserves the current plan, conflicts, and improvement request after a failure and retries them', async () => {
    vi.mocked(api.episodes.propose).mockResolvedValueOnce({ ...proposal, conflicts: ['보존할 설정 충돌'] });
    const refine = vi.spyOn(api.episodes, 'refine')
      .mockRejectedValueOnce(new Error('개선을 완료하지 못했습니다.'))
      .mockResolvedValueOnce({ title: '다듬은 제목', direction: '다듬은 전개 방향', conflicts: [] });
    const user = await openCreator();
    await user.click(screen.getByRole('button', { name: '다음' }));
    const title = await screen.findByLabelText('회차 제목');
    const direction = screen.getByLabelText('전개 방향');
    const instruction = screen.getByLabelText('개선 요청');
    await user.type(title, ' 수정');
    await user.type(direction, ' 동료는 무사하다.');
    await user.type(instruction, '  동료의 흔적을 더 구체적으로 묘사해 줘  ');
    await user.click(screen.getByRole('button', { name: '개선' }));

    expect(await screen.findByText('개선을 완료하지 못했습니다.')).toBeVisible();
    expect(title).toHaveValue(`${proposal.title} 수정`);
    expect(direction).toHaveValue(`${proposal.direction} 동료는 무사하다.`);
    expect(instruction).toHaveValue('  동료의 흔적을 더 구체적으로 묘사해 줘  ');
    expect(screen.getByText('보존할 설정 충돌')).toBeVisible();
    expect(title).toBeEnabled();
    expect(direction).toBeEnabled();
    expect(instruction).toBeEnabled();
    expect(screen.getByRole('button', { name: '개선' })).toBeEnabled();

    await user.click(screen.getByRole('button', { name: '개선' }));
    expect(refine).toHaveBeenCalledTimes(2);
    expect(refine).toHaveBeenLastCalledWith('story', {
      episodeId: 'episode-1', expectedRevision: 1,
      title: `${proposal.title} 수정`, direction: `${proposal.direction} 동료는 무사하다.`, instruction: '동료의 흔적을 더 구체적으로 묘사해 줘',
    }, expect.any(AbortSignal));
    expect(title).toHaveValue('다듬은 제목');
    expect(direction).toHaveValue('다듬은 전개 방향');
    expect(instruction).toHaveValue('');
    expect(screen.queryByText('개선을 완료하지 못했습니다.')).not.toBeInTheDocument();
    expect(screen.queryByText('보존할 설정 충돌')).not.toBeInTheDocument();
  });

  it.each(['success', 'failure'] as const)('locks actions during refinement, aborts on close, and ignores a late %s in a new creator', async (completion) => {
    const newProposal = { title: '새로운 회차', direction: '새로운 이야기의 전개', conflicts: ['새로운 설정 충돌'] };
    vi.mocked(api.episodes.propose).mockResolvedValueOnce(proposal).mockResolvedValueOnce(newProposal);
    let finish!: (value: typeof proposal) => void;
    let fail!: (reason: Error) => void;
    const refine = vi.spyOn(api.episodes, 'refine').mockImplementationOnce(() => new Promise((resolve, reject) => {
      finish = resolve;
      fail = reject;
    }));
    const generate = vi.spyOn(api.episodes, 'generate');
    const create = vi.mocked(api.episodes.create);
    const user = await openCreator();
    await user.click(screen.getByRole('button', { name: '다음' }));
    await user.type(await screen.findByLabelText('개선 요청'), '추격 장면만 짧게 해 줘');
    await user.click(screen.getByRole('button', { name: '개선' }));

    expect(screen.getByRole('button', { name: '개선 중' })).toBeDisabled();
    expect(screen.getByLabelText('회차 제목')).toBeDisabled();
    expect(screen.getByLabelText('전개 방향')).toBeDisabled();
    expect(screen.getByLabelText('개선 요청')).toBeDisabled();
    expect(screen.getByRole('button', { name: '이전' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '빈 회차로 시작' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'AI 회차 작성' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: '개선 중' }));
    expect(refine).toHaveBeenCalledTimes(1);
    expect(generate).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(1);

    const signal = refine.mock.calls[0][2];
    await user.click(screen.getByRole('button', { name: '닫기' }));
    expect(signal?.aborted).toBe(true);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: '새 회차' }));
    await user.click(screen.getByRole('button', { name: '다음' }));
    expect(await screen.findByLabelText('회차 제목')).toHaveValue(newProposal.title);
    await user.type(screen.getByLabelText('개선 요청'), '새로운 회차에 대한 요청');
    await act(async () => {
      if (completion === 'success') finish({ title: '늦게 도착한 제목', direction: '늦게 도착한 방향', conflicts: [] });
      else fail(new Error('이전 개선 요청의 늦은 오류'));
    });

    expect(screen.getByLabelText('회차 제목')).toHaveValue(newProposal.title);
    expect(screen.getByLabelText('전개 방향')).toHaveValue(newProposal.direction);
    expect(screen.getByLabelText('개선 요청')).toHaveValue('새로운 회차에 대한 요청');
    expect(screen.getByText('새로운 설정 충돌')).toBeVisible();
    expect(screen.queryByText('이전 개선 요청의 늦은 오류')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '개선' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'AI 회차 작성' })).toBeEnabled();
  });

  it('starts with one optional request and generates the title and direction on next, even when empty', async () => {
    const generate = vi.spyOn(api.episodes, 'generate').mockResolvedValue({ content: '완성된 첫 문장.', issues: [], blocked: false });
    const create = vi.mocked(api.episodes.create);
    const user = await openCreator();
    const dialog = within(screen.getByRole('dialog'));

    expect(dialog.getAllByRole('textbox')).toHaveLength(1);
    expect(dialog.getByLabelText(/이번 회차에 원하는 것/)).not.toBeRequired();
    expect(dialog.getByRole('button', { name: '다음' })).toBeEnabled();
    expect(dialog.queryByRole('button', { name: /제안/ })).not.toBeInTheDocument();
    expect(dialog.queryByLabelText('회차 제목')).not.toBeInTheDocument();
    expect(api.episodes.propose).not.toHaveBeenCalled();

    await user.click(dialog.getByRole('button', { name: '다음' }));

    expect(vi.mocked(api.episodes.propose).mock.calls[0].slice(0, 3)).toEqual(['story', undefined, expect.any(AbortSignal)]);
    expect(await dialog.findByLabelText('회차 제목')).toHaveValue(proposal.title);
    expect(dialog.getByLabelText('전개 방향')).toHaveValue(proposal.direction);
    expect(dialog.queryByLabelText(/이번 회차에 원하는 것/)).not.toBeInTheDocument();
    expect(generate).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledWith('story', {
      title: proposal.title, direction: proposal.direction, content: '', incomplete: true,
    }, expect.any(String));
    expect(persistedEpisodes).toHaveLength(1);
    expect(persistedEpisodes[0].status).toBe('INCOMPLETE');

    await user.click(dialog.getByRole('button', { name: 'AI 회차 작성' }));
    expect(await screen.findByTestId('editor-route')).toHaveTextContent(JSON.stringify({ episodeId: 'episode-1', state: { generateEpisode: true } }));
    expect(generate).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(1);
    expect(api.episodes.update).not.toHaveBeenCalled();
    expect(persistedEpisodes[0].status).toBe('INCOMPLETE');
  });

  it('sends only the user request and lets the generated plan be edited before starting an empty episode', async () => {
    const create = vi.mocked(api.episodes.create);
    const user = await openCreator();
    await user.type(screen.getByLabelText(/이번 회차에 원하는 것/), '  능력을 들키는 장면\n동료의 반응도 보여 줘  ');
    await user.click(screen.getByRole('button', { name: '다음' }));

    expect(vi.mocked(api.episodes.propose).mock.calls[0].slice(0, 3)).toEqual(['story', '능력을 들키는 장면\n동료의 반응도 보여 줘', expect.any(AbortSignal)]);
    const title = await screen.findByLabelText('회차 제목');
    await user.clear(title);
    await user.type(title, '드러난 비밀');
    await user.click(screen.getByRole('button', { name: '빈 회차로 시작' }));
    expect(await screen.findByTestId('editor-route')).toHaveTextContent(JSON.stringify({ episodeId: 'episode-1', state: null }));
    expect(create).toHaveBeenCalledTimes(1);
    expect(api.episodes.update).toHaveBeenCalledWith('story', 'episode-1', {
      expectedRevision: 1, title: '드러난 비밀', direction: proposal.direction, incomplete: false,
    });
  });

  it('keeps the request after a planning failure and retries from next', async () => {
    vi.mocked(api.episodes.propose).mockRejectedValueOnce(new Error('일시적인 생성 오류'));
    const user = await openCreator();
    await user.type(screen.getByLabelText(/이번 회차에 원하는 것/), '동료와 화해');
    await user.click(screen.getByRole('button', { name: '다음' }));

    expect(await screen.findByText('일시적인 생성 오류')).toBeInTheDocument();
    expect(screen.getByLabelText(/이번 회차에 원하는 것/)).toHaveValue('동료와 화해');
    expect(screen.queryByLabelText('회차 제목')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '다음' }));
    expect(await screen.findByLabelText('회차 제목')).toHaveValue(proposal.title);
    expect(api.episodes.propose).toHaveBeenCalledTimes(2);
  });

  it('disables duplicate next requests and discards late results after closing', async () => {
    let finish!: (value: typeof proposal) => void;
    vi.mocked(api.episodes.propose).mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const user = await openCreator();
    await user.click(screen.getByRole('button', { name: '다음' }));

    expect(screen.getByRole('button', { name: '만드는 중' })).toBeDisabled();
    expect(screen.getByLabelText(/이번 회차에 원하는 것/)).toBeDisabled();
    const signal = vi.mocked(api.episodes.propose).mock.calls[0][2];
    await user.click(screen.getByRole('button', { name: '닫기' }));
    expect(signal?.aborted).toBe(true);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: '새 회차' }));
    await act(async () => finish(proposal));

    expect(screen.getByLabelText(/이번 회차에 원하는 것/)).toHaveValue('');
    expect(screen.queryByLabelText('회차 제목')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '다음' })).toBeEnabled();
    expect(api.episodes.propose).toHaveBeenCalledTimes(1);
  });
});

describe('side stories', () => {
  const standalone: Episode = {
    ...incompleteEpisode,
    id: 'standalone-side',
    kind: 'SIDE_STORY',
    number: null,
    sideStoryGroupId: null,
    branchFromEpisodeId: null,
    title: '비 오는 휴일',
    status: 'DRAFT',
  };
  const groupedOne: Episode = {
    ...standalone,
    id: 'group-side-1',
    number: 1,
    sideStoryGroupId: 'group-1',
    title: '밤의 약속',
  };
  const groupedTwo: Episode = { ...groupedOne, id: 'group-side-2', number: 2, title: '새벽의 답' };
  const group: SideStoryGroup & { episodes: Episode[] } = {
    id: 'group-1', projectId: 'story', title: '수도 야화', description: '본편 밖의 수도 이야기',
    branchFromEpisodeId: 'episode-1', nextEpisodeNumber: 3, revision: 1, canon: [],
    arc: {
      id: 'side-arc', projectId: 'story', title: '사라진 등불', startEpisode: 1, endEpisode: 4,
      goal: '등불의 주인을 찾는다.', conflict: '수도 경비대가 추적한다.', reversalPlan: [], status: 'ACTIVE', revision: 1,
      createdAt: incompleteEpisode.createdAt, updatedAt: incompleteEpisode.updatedAt,
    },
    episodes: [groupedOne, groupedTwo], createdAt: incompleteEpisode.createdAt, updatedAt: incompleteEpisode.updatedAt,
  };

  it('keeps standalone and group numbering separate from the main episode order', async () => {
    persistedEpisodes = [{ ...incompleteEpisode, status: 'DRAFT' }];
    vi.mocked(api.sideStories.list).mockResolvedValue({ standalone: [standalone], groups: [group] });
    renderPage();

    expect(await screen.findByRole('link', { name: /닫힌 문 너머/ })).toBeVisible();
    expect(screen.getAllByRole('button', { name: '새 외전' })[0]).toBeVisible();
    expect(within(screen.getByRole('region', { name: '회차 목록' })).getByRole('button', { name: '1화 메뉴' })).toBeVisible();
    const standaloneList = screen.getByRole('region', { name: '단편 외전 목록' });
    expect(within(standaloneList).getByText('단편')).toBeVisible();
    expect(within(standaloneList).queryByText(/단편 외전 [0-9]+화/)).not.toBeInTheDocument();
    const groupedList = screen.getByRole('region', { name: '수도 야화' });
    expect(within(groupedList).getByRole('button', { name: '외전 1화 메뉴' })).toBeVisible();
    expect(within(groupedList).getByRole('button', { name: '외전 2화 메뉴' })).toBeVisible();
    expect(screen.getByText('그룹 정사')).toBeVisible();
    expect(screen.getByText('사라진 등불')).toBeVisible();
  });

  it.each([
    { mode: 'canon', branchId: null },
    { mode: 'episode', branchId: 'episode-1' },
  ] as const)('creates a standalone side story with an explicit $mode boundary', async ({ mode, branchId }) => {
    persistedEpisodes = [{ ...incompleteEpisode, status: 'DRAFT' }];
    const created = { ...standalone, id: `created-${mode}`, status: 'INCOMPLETE' as const };
    const create = vi.spyOn(api.sideStories, 'create').mockResolvedValue(created);
    const user = userEvent.setup();
    renderPage();
    await user.click((await screen.findAllByRole('button', { name: '새 외전' }))[0]);
    const dialog = within(await screen.findByRole('dialog', { name: '새 외전 만들기' }));
    if (mode === 'episode') {
      await user.click(dialog.getByLabelText(/본편 회차에서 이어쓰기/));
      await user.selectOptions(dialog.getByLabelText('이어 쓸 본편 회차'), 'episode-1');
    }
    await user.click(dialog.getByRole('button', { name: '다음' }));
    await user.click(dialog.getByRole('button', { name: '다음' }));
    expect(await dialog.findByLabelText('외전 제목')).toHaveValue(proposal.title);

    expect(api.episodes.propose).toHaveBeenCalledWith('story', undefined, expect.any(AbortSignal), {
      kind: 'SIDE_STORY', sideStoryGroupId: null, branchFromEpisodeId: branchId,
    });
    expect(create).toHaveBeenCalledWith('story', {
      title: proposal.title, direction: proposal.direction, content: '', incomplete: true,
      groupId: null, branchFromEpisodeId: branchId,
    }, expect.any(String));
    expect(api.episodes.create).not.toHaveBeenCalled();
  });

  it('keeps a persisted standalone scope fixed when returning to the request step', async () => {
    persistedEpisodes = [{ ...incompleteEpisode, status: 'DRAFT' }];
    const created = {
      ...standalone,
      id: 'persisted-standalone',
      title: proposal.title,
      direction: proposal.direction,
      status: 'INCOMPLETE' as const,
    };
    const create = vi.spyOn(api.sideStories, 'create').mockResolvedValue(created);
    const user = userEvent.setup();
    renderPage();
    await user.click((await screen.findAllByRole('button', { name: '새 외전' }))[0]);
    const dialog = within(await screen.findByRole('dialog', { name: '새 외전 만들기' }));
    await user.click(dialog.getByRole('button', { name: '다음' }));
    await user.click(dialog.getByRole('button', { name: '다음' }));
    expect(await dialog.findByLabelText('외전 제목')).toHaveValue(proposal.title);
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));

    await user.click(dialog.getByRole('button', { name: '이전' }));

    expect(await dialog.findByLabelText(/외전에 원하는 것/)).toBeVisible();
    expect(dialog.queryByRole('button', { name: '이전' })).not.toBeInTheDocument();
    expect(dialog.queryByRole('radio', { name: /단편 외전/ })).not.toBeInTheDocument();
    await user.click(dialog.getByRole('button', { name: '나중에 계속하기' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '새 외전 만들기' })).not.toBeInTheDocument());
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('requires a group name, canon, and complete arc before creating a new side-story group', async () => {
    const createGroup = vi.spyOn(api.sideStoryGroups, 'create');
    const user = userEvent.setup();
    renderPage();
    await user.click((await screen.findAllByRole('button', { name: '새 외전' }))[0]);
    const dialog = within(await screen.findByRole('dialog', { name: '새 외전 만들기' }));
    await user.click(dialog.getByRole('radio', { name: /새 그룹/ }));

    const next = dialog.getByRole('button', { name: '다음' });
    const requiredFields = [
      [dialog.getByLabelText('그룹 이름'), '겨울 궁전'],
      [dialog.getByLabelText('그룹 정사'), '궁전 안에서는 시간이 느리게 흐른다.'],
      [dialog.getByLabelText('아크 제목'), '얼어붙은 봉인'],
      [dialog.getByLabelText('아크 목표'), '궁전의 봉인을 푼다.'],
      [dialog.getByLabelText('중심 갈등'), '시간을 지키는 파수꾼이 막아선다.'],
    ] as const;

    expect(next).toBeDisabled();
    for (const [field, value] of requiredFields) await user.type(field, value);
    expect(next).toBeEnabled();
    expect(dialog.getByLabelText(/그룹 설명/)).toHaveValue('');
    expect(dialog.getByLabelText(/예상 종료 외전/)).toHaveValue(null);

    for (const [field, value] of requiredFields) {
      await user.clear(field);
      expect(next).toBeDisabled();
      await user.type(field, value);
      expect(next).toBeEnabled();
    }
    expect(createGroup).not.toHaveBeenCalled();
  });

  it('keeps persisted new-group setup committed and closes without creating an external story', async () => {
    const createdGroup: SideStoryGroup = {
      ...group,
      id: 'persisted-new-group',
      title: '겨울 궁전',
      description: '',
      branchFromEpisodeId: null,
      nextEpisodeNumber: 1,
      canon: [],
      arc: { ...group.arc, id: 'persisted-new-group-arc' },
      episodes: [],
    };
    const createGroup = vi.spyOn(api.sideStoryGroups, 'create').mockResolvedValue(createdGroup);
    const createSide = vi.spyOn(api.sideStories, 'create');
    const user = userEvent.setup();
    renderPage();
    await user.click((await screen.findAllByRole('button', { name: '새 외전' }))[0]);
    const dialog = within(await screen.findByRole('dialog', { name: '새 외전 만들기' }));
    await user.click(dialog.getByRole('radio', { name: /새 그룹/ }));
    await user.type(dialog.getByLabelText('그룹 이름'), createdGroup.title);
    await user.type(dialog.getByLabelText('그룹 정사'), '궁전 안에서는 시간이 느리게 흐른다.');
    await user.type(dialog.getByLabelText('아크 제목'), '얼어붙은 봉인');
    await user.type(dialog.getByLabelText('아크 목표'), '궁전의 봉인을 푼다.');
    await user.type(dialog.getByLabelText('중심 갈등'), '시간을 지키는 파수꾼이 막아선다.');

    await user.click(dialog.getByRole('button', { name: '다음' }));

    const persistedNotice = await dialog.findByRole('status');
    expect(persistedNotice).toHaveTextContent('겨울 궁전 그룹은 이미 저장되었습니다.');
    expect(persistedNotice).toHaveTextContent('닫아도 외전 그룹 목록에 남습니다.');
    expect(dialog.queryByRole('button', { name: '이전' })).not.toBeInTheDocument();
    expect(dialog.queryByRole('radio', { name: /단편 외전/ })).not.toBeInTheDocument();
    expect(dialog.getByLabelText(/외전에 원하는 것/)).toBeVisible();

    await user.click(dialog.getByRole('button', { name: '나중에 계속하기' }));

    await waitFor(() => expect(screen.queryByRole('dialog', { name: '새 외전 만들기' })).not.toBeInTheDocument());
    expect(createGroup).toHaveBeenCalledTimes(1);
    expect(api.episodes.propose).not.toHaveBeenCalled();
    expect(createSide).not.toHaveBeenCalled();
  });

  it('retries new-group creation with one idempotency key before planning and saving inside that group', async () => {
    persistedEpisodes = [{ ...incompleteEpisode, status: 'DRAFT' }];
    const createdGroup: SideStoryGroup = {
      ...group,
      id: 'new-group',
      title: '겨울 궁전',
      description: '조연들의 겨울 이야기',
      branchFromEpisodeId: 'episode-1',
      nextEpisodeNumber: 1,
      arc: {
        ...group.arc,
        id: 'new-group-arc',
        title: '얼어붙은 봉인',
        goal: '궁전의 봉인을 푼다.',
        conflict: '시간을 지키는 파수꾼이 막아선다.',
        endEpisode: 6,
      },
      episodes: [],
    };
    const createGroup = vi.spyOn(api.sideStoryGroups, 'create')
      .mockRejectedValueOnce(new Error('그룹 생성 응답을 확인하지 못했어요.'))
      .mockResolvedValueOnce(createdGroup);
    const createdSide = {
      ...standalone,
      id: 'new-group-side',
      number: 1,
      sideStoryGroupId: createdGroup.id,
      title: proposal.title,
      direction: proposal.direction,
      status: 'INCOMPLETE' as const,
    };
    const createSide = vi.spyOn(api.sideStories, 'create').mockResolvedValue(createdSide);
    const user = userEvent.setup();
    renderPage();
    await user.click((await screen.findAllByRole('button', { name: '새 외전' }))[0]);
    const dialog = within(await screen.findByRole('dialog', { name: '새 외전 만들기' }));
    await user.click(dialog.getByRole('radio', { name: /새 그룹/ }));
    await user.type(dialog.getByLabelText('그룹 이름'), createdGroup.title);
    await user.type(dialog.getByLabelText(/그룹 설명/), createdGroup.description);
    await user.type(dialog.getByLabelText('그룹 정사'), '궁전 안에서는 시간이 느리게 흐른다.');
    await user.type(dialog.getByLabelText('아크 제목'), createdGroup.arc.title);
    await user.type(dialog.getByLabelText('아크 목표'), createdGroup.arc.goal);
    await user.type(dialog.getByLabelText('중심 갈등'), createdGroup.arc.conflict);
    await user.type(dialog.getByLabelText(/예상 종료 외전/), '6');
    await user.click(dialog.getByRole('radio', { name: /본편 회차에서 이어쓰기/ }));
    expect(dialog.getByRole('button', { name: '다음' })).toBeDisabled();
    await user.selectOptions(dialog.getByLabelText('이어 쓸 본편 회차'), 'episode-1');

    await user.click(dialog.getByRole('button', { name: '다음' }));
    expect(await dialog.findByText('그룹 생성 응답을 확인하지 못했어요.')).toBeVisible();
    expect(dialog.getByLabelText('그룹 이름')).toHaveValue(createdGroup.title);
    expect(dialog.getByRole('status')).toHaveTextContent('첫 그룹 생성 요청과 같은 내용으로 다시 시도합니다.');
    expect(dialog.getByLabelText('그룹 이름')).toBeDisabled();
    expect(dialog.getByLabelText(/그룹 설명/)).toBeDisabled();
    expect(dialog.getByLabelText('이어 쓸 본편 회차')).toBeDisabled();
    expect(createGroup).toHaveBeenCalledTimes(1);

    await user.click(dialog.getByRole('button', { name: '다음' }));
    expect(await dialog.findByLabelText(/외전에 원하는 것/)).toBeVisible();
    expect(createGroup).toHaveBeenCalledTimes(2);
    const expectedGroupInput = {
      title: createdGroup.title,
      description: createdGroup.description,
      branchFromEpisodeId: 'episode-1',
      canon: '궁전 안에서는 시간이 느리게 흐른다.',
      arc: {
        title: createdGroup.arc.title,
        goal: createdGroup.arc.goal,
        conflict: createdGroup.arc.conflict,
        endEpisodeNumber: 6,
        reversalPlan: [],
      },
    };
    expect(createGroup).toHaveBeenNthCalledWith(1, 'story', expectedGroupInput, expect.any(String));
    expect(createGroup).toHaveBeenNthCalledWith(2, 'story', expectedGroupInput, createGroup.mock.calls[0][2]);
    expect(createGroup.mock.calls[0][2]).toEqual(expect.any(String));

    await user.type(dialog.getByLabelText(/외전에 원하는 것/), '조연들만 남은 겨울밤');
    await user.click(dialog.getByRole('button', { name: '다음' }));
    expect(await dialog.findByLabelText('외전 제목')).toHaveValue(proposal.title);
    expect(api.episodes.propose).toHaveBeenCalledWith(
      'story',
      '조연들만 남은 겨울밤',
      expect.any(AbortSignal),
      { kind: 'SIDE_STORY', sideStoryGroupId: createdGroup.id, branchFromEpisodeId: null },
    );
    await waitFor(() => expect(createSide).toHaveBeenCalledWith('story', {
      title: proposal.title,
      direction: proposal.direction,
      content: '',
      incomplete: true,
      groupId: createdGroup.id,
      branchFromEpisodeId: null,
    }, expect.any(String)));
    expect(api.episodes.create).not.toHaveBeenCalled();
  });
});

describe('incomplete episode plans', () => {
  it('keeps one incomplete row after closing and restores manual edits after reloading the list', async () => {
    const user = userEvent.setup();
    const page = renderPage();
    await user.click(screen.getByRole('button', { name: '새 회차' }));
    await user.click(await screen.findByRole('button', { name: '다음' }));
    expect(await screen.findByLabelText('회차 제목')).toHaveValue(proposal.title);
    await user.click(screen.getByRole('button', { name: '닫기' }));

    const row = await screen.findByRole('button', { name: /닫힌 문 너머.*미완성/ });
    expect(screen.getAllByText('미완성')).toHaveLength(1);
    expect(screen.queryByRole('link', { name: /닫힌 문 너머/ })).not.toBeInTheDocument();
    await user.click(row);
    expect(await screen.findByRole('dialog', { name: '새 회차 만들기' })).toBeVisible();
    expect(screen.getByLabelText('회차 제목')).toHaveValue(proposal.title);
    expect(screen.getByLabelText('전개 방향')).toHaveValue(proposal.direction);
    expect(screen.queryByLabelText(/이번 회차에 원하는 것/)).not.toBeInTheDocument();
    expect(screen.queryByTestId('editor-route')).not.toBeInTheDocument();
    expect(api.episodes.propose).toHaveBeenCalledTimes(1);
    expect(api.episodes.create).toHaveBeenCalledTimes(1);

    await user.clear(screen.getByLabelText('회차 제목'));
    await user.type(screen.getByLabelText('회차 제목'), '다시 열린 문');
    await user.type(screen.getByLabelText('전개 방향'), ' 동료의 목소리가 들린다.');
    await user.click(screen.getByRole('button', { name: '닫기' }));
    expect(await screen.findByRole('button', { name: /다시 열린 문.*미완성/ })).toBeVisible();
    expect(api.episodes.update).toHaveBeenLastCalledWith('story', 'episode-1', {
      expectedRevision: 1, title: '다시 열린 문', direction: `${proposal.direction} 동료의 목소리가 들린다.`, incomplete: true,
    });
    page.unmount();
    renderPage();
    await user.click(await screen.findByRole('button', { name: /다시 열린 문.*미완성/ }));
    expect(await screen.findByLabelText('회차 제목')).toHaveValue('다시 열린 문');
    expect(screen.getByLabelText('전개 방향')).toHaveValue(`${proposal.direction} 동료의 목소리가 들린다.`);
    expect(api.episodes.propose).toHaveBeenCalledTimes(1);
    expect(api.episodes.create).toHaveBeenCalledTimes(1);
    expect(persistedEpisodes).toHaveLength(1);
  });

  it('opens an incomplete plan directly from the resume URL without proposing or creating again', async () => {
    persistedEpisodes = [incompleteEpisode];
    renderPage(undefined, '/projects/story/episodes?resume=episode-1');

    expect(await screen.findByRole('dialog', { name: '새 회차 만들기' })).toBeVisible();
    expect(screen.getByLabelText('회차 제목')).toHaveValue(proposal.title);
    expect(screen.getByLabelText('전개 방향')).toHaveValue(proposal.direction);
    expect(screen.queryByTestId('editor-route')).not.toBeInTheDocument();
    expect(api.episodes.propose).not.toHaveBeenCalled();
    expect(api.episodes.create).not.toHaveBeenCalled();
    await userEvent.setup().click(screen.getByRole('button', { name: '닫기' }));
    expect(await screen.findByRole('button', { name: /닫힌 문 너머.*미완성/ })).toBeVisible();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('continues to open a normal empty draft in the editor', async () => {
    persistedEpisodes = [{ ...incompleteEpisode, status: 'DRAFT' }];
    renderPage();
    await userEvent.setup().click(await screen.findByRole('link', { name: /닫힌 문 너머/ }));

    expect(await screen.findByTestId('editor-route')).toHaveTextContent(JSON.stringify({ episodeId: 'episode-1', state: null }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(api.episodes.propose).not.toHaveBeenCalled();
    expect(api.episodes.create).not.toHaveBeenCalled();
  });

  it('reproposes a changed request with the existing episode context and updates its row', async () => {
    const replacement = { title: '새로운 작전', direction: '경비병으로 변장해서 왕궁에 들어간다.', conflicts: [] };
    vi.mocked(api.episodes.propose).mockResolvedValueOnce(proposal).mockResolvedValueOnce(replacement);
    const user = await openCreator();
    await user.type(screen.getByLabelText(/이번 회차에 원하는 것/), '왕궁 잠입');
    await user.click(screen.getByRole('button', { name: '다음' }));
    await screen.findByLabelText('회차 제목');
    await user.click(screen.getByRole('button', { name: '이전' }));
    await user.type(screen.getByLabelText(/이번 회차에 원하는 것/), ' 변장 작전');
    await user.click(screen.getByRole('button', { name: '다음' }));

    expect(await screen.findByLabelText('회차 제목')).toHaveValue(replacement.title);
    expect(api.episodes.propose).toHaveBeenLastCalledWith('story', '왕궁 잠입 변장 작전', expect.any(AbortSignal), {
      episodeId: 'episode-1', expectedRevision: 1,
    });
    expect(api.episodes.update).toHaveBeenCalledWith('story', 'episode-1', {
      expectedRevision: 1, title: replacement.title, direction: replacement.direction, incomplete: true,
    });
    await user.click(screen.getByRole('button', { name: '닫기' }));
    expect(await screen.findByRole('button', { name: /새로운 작전.*미완성/ })).toBeVisible();
    expect(screen.getAllByText('미완성')).toHaveLength(1);
    expect(api.episodes.create).toHaveBeenCalledTimes(1);
    expect(persistedEpisodes).toHaveLength(1);
  });

  it('retries a lost create response with its original key and payload, then saves subsequent manual edits', async () => {
    const create = vi.mocked(api.episodes.create);
    const persist = create.getMockImplementation()!;
    create.mockImplementationOnce(async (...args) => {
      await persist(...args);
      throw new Error('저장 응답을 받지 못했어요.');
    });
    const user = await openCreator();
    await user.click(screen.getByRole('button', { name: '다음' }));
    expect(await screen.findByText('저장 응답을 받지 못했어요.')).toBeVisible();
    expect(screen.getByLabelText('회차 제목')).toHaveValue(proposal.title);
    const initialCall = create.mock.calls[0];
    await user.type(screen.getByLabelText('회차 제목'), ' 수정');
    await user.click(screen.getByRole('button', { name: '닫기' }));

    expect(await screen.findByRole('button', { name: /닫힌 문 너머 수정.*미완성/ })).toBeVisible();
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[1]).toEqual(initialCall);
    expect(api.episodes.update).toHaveBeenCalledWith('story', 'episode-1', {
      expectedRevision: 1, title: `${proposal.title} 수정`, direction: proposal.direction, incomplete: true,
    });
    expect(api.episodes.propose).toHaveBeenCalledTimes(1);
    expect(persistedEpisodes).toHaveLength(1);
    expect(persistedEpisodes[0].title).toBe(`${proposal.title} 수정`);
  });

  it('keeps an unsaved plan in the dialog after a close failure and retries the same episode', async () => {
    persistedEpisodes = [incompleteEpisode];
    vi.mocked(api.episodes.update).mockRejectedValueOnce(new Error('전개 방향을 저장하지 못했어요.'));
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: /닫힌 문 너머.*미완성/ }));
    await user.type(screen.getByLabelText('전개 방향'), ' 잠입 계획을 바꾼다.');
    await user.click(screen.getByRole('button', { name: '닫기' }));

    expect(await screen.findByText('전개 방향을 저장하지 못했어요.')).toBeVisible();
    expect(screen.getByRole('dialog')).toBeVisible();
    expect(screen.getByLabelText('전개 방향')).toHaveValue(`${proposal.direction} 잠입 계획을 바꾼다.`);
    expect(screen.queryByTestId('editor-route')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '닫기' }));
    expect(await screen.findByRole('button', { name: /닫힌 문 너머.*미완성/ })).toBeVisible();
    expect(api.episodes.update).toHaveBeenCalledTimes(2);
    expect(vi.mocked(api.episodes.update).mock.calls[1]).toEqual(vi.mocked(api.episodes.update).mock.calls[0]);
    expect(api.episodes.create).not.toHaveBeenCalled();
    expect(persistedEpisodes[0].direction).toBe(`${proposal.direction} 잠입 계획을 바꾼다.`);
  });

  it.each(['AI 회차 작성', '빈 회차로 시작'])('retries failed %s saving and waits for it before entering the editor', async (action) => {
    persistedEpisodes = [incompleteEpisode];
    const update = vi.mocked(api.episodes.update);
    const persist = update.getMockImplementation()!;
    update.mockRejectedValueOnce(new Error('회차를 시작하지 못했어요.'));
    let finish!: () => void;
    update.mockImplementationOnce((...args) => new Promise((resolve, reject) => {
      finish = () => { void persist(...args).then(resolve, reject); };
    }));
    const generate = vi.spyOn(api.episodes, 'generate');
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: /닫힌 문 너머.*미완성/ }));
    await user.type(screen.getByLabelText('회차 제목'), ' 수정');
    await user.click(screen.getByRole('button', { name: action }));

    expect(await screen.findByText('회차를 시작하지 못했어요.')).toBeVisible();
    expect(screen.getByRole('dialog')).toBeVisible();
    expect(persistedEpisodes[0].status).toBe('INCOMPLETE');
    expect(screen.queryByTestId('editor-route')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: action }));
    expect(screen.getByRole('button', { name: 'AI 회차 작성' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '빈 회차로 시작' })).toBeDisabled();
    expect(screen.getByLabelText('회차 제목')).toBeDisabled();
    expect(screen.queryByTestId('editor-route')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '닫기' }));
    expect(screen.getByRole('dialog')).toBeVisible();
    expect(update).toHaveBeenCalledTimes(2);
    await act(async () => finish());

    expect(await screen.findByTestId('editor-route')).toHaveTextContent(JSON.stringify({
      episodeId: 'episode-1', state: action === 'AI 회차 작성' ? { generateEpisode: true } : null,
    }));
    expect(persistedEpisodes[0].status).toBe(action === 'AI 회차 작성' ? 'INCOMPLETE' : 'DRAFT');
    expect(persistedEpisodes[0].title).toBe(`${proposal.title} 수정`);
    expect(api.episodes.create).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
  });
});

describe('episode resume navigation races', () => {
  it('waits for stale order data to refresh before consuming an incomplete episode resume URL', async () => {
    const cachedOrder: EpisodeOrder = {
      episodes: [{ ...incompleteEpisode, status: 'DRAFT' }], slots: ['episode-1'], revision: 'old-order',
    };
    let finish!: (order: EpisodeOrder) => void;
    vi.mocked(api.episodes.order).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    renderPage(undefined, '/projects/story/episodes?resume=episode-1', cachedOrder);
    expect(await screen.findByRole('link', { name: /닫힌 문 너머/ })).toBeVisible();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    await act(async () => finish({ episodes: [incompleteEpisode], slots: ['episode-1'], revision: 'new-order' }));
    expect(await screen.findByRole('dialog', { name: '새 회차 만들기' })).toBeVisible();
    expect(screen.getByLabelText('회차 제목')).toHaveValue(proposal.title);
    expect(api.episodes.propose).not.toHaveBeenCalled();
    expect(api.episodes.create).not.toHaveBeenCalled();
  });

  it('finishes saving after leaving the creator without reopening the editor or starting AI writing', async () => {
    persistedEpisodes = [incompleteEpisode];
    const persist = vi.mocked(api.episodes.update).getMockImplementation()!;
    let finish!: () => Promise<void>;
    vi.mocked(api.episodes.update).mockImplementationOnce((...args) => new Promise((resolve, reject) => {
      finish = async () => { await persist(...args).then(resolve, reject); };
    }));
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: /닫힌 문 너머.*미완성/ }));
    await user.type(screen.getByLabelText('회차 제목'), ' 수정');
    await user.click(screen.getByRole('button', { name: 'AI 회차 작성' }));
    expect(api.episodes.update).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'AI 회차 작성' })).toBeDisabled();
    await act(async () => navigateRouter('/elsewhere'));
    expect(await screen.findByTestId('elsewhere-route')).toBeVisible();
    await act(async () => finish());

    expect(screen.getByTestId('elsewhere-route')).toBeVisible();
    expect(screen.queryByTestId('editor-route')).not.toBeInTheDocument();
    expect(persistedEpisodes[0]).toMatchObject({ title: `${proposal.title} 수정`, status: 'INCOMPLETE' });
    expect(api.episodes.create).not.toHaveBeenCalled();
  });
});
