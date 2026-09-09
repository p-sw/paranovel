import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { api } from '../api/client';
import type { Arc, ArcPlanProposal } from '../types';
import ArcPage from './ArcPage';

const timestamp = '2026-09-01T00:00:00.000Z';

function directions(startEpisode: number, endEpisode: number, prefix = '전개') {
  return Array.from({ length: endEpisode - startEpisode + 1 }, (_, index) => {
    const episode = startEpisode + index;
    return { episode, title: `${episode}화 제목`, direction: `${prefix} ${episode}화 방향` };
  });
}

const completedArc = arc({
  id: 'completed',
  title: '끝난 서막',
  startEpisode: 1,
  endEpisode: 5,
  status: 'COMPLETE',
  revision: 2,
});
const archivedArc = arc({
  id: 'archived',
  title: '버려진 추적',
  startEpisode: 6,
  endEpisode: 10,
  status: 'ARCHIVED',
  revision: 2,
});
const activeArc: Arc = {
  ...arc({
    id: 'active',
    title: '현재의 관문',
    startEpisode: 11,
    endEpisode: 15,
    status: 'ACTIVE',
    revision: 3,
  }),
  milestones: [{ id: 'legacy-reversal', episode: 14, type: 'REVERSAL', description: '기존 반전 문장을 그대로 유지한다.' }],
};
const plannedArc = arc({
  id: 'planned',
  title: '왕도의 그림자',
  startEpisode: 16,
  endEpisode: 20,
  status: 'PLANNED',
  revision: 4,
});

const aiProposal: ArcPlanProposal = {
  title: '달의 귀환',
  startEpisodeNumber: 21,
  endEpisodeNumber: 25,
  goal: '사라진 달을 되찾는다.',
  conflict: '왕실이 귀환을 막는다.',
  milestones: [{ episode: 24, type: 'REVERSAL', description: '왕이 달을 숨긴 이유가 드러난다.' }],
  episodeDirections: directions(21, 25, '달의 귀환'),
  conflicts: [],
};

let listedArcs: Arc[];

function arc(input: Pick<Arc, 'id' | 'title' | 'startEpisode' | 'endEpisode' | 'status' | 'revision'>): Arc {
  return {
    ...input,
    projectId: 'story',
    goal: `${input.title}의 목표`,
    conflict: `${input.title}의 갈등`,
    milestones: [{ episode: input.endEpisode, type: 'GOAL', description: `${input.title}의 목표를 달성한다.` }],
    episodeDirections: directions(input.startEpisode, input.endEpisode, input.title),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/projects/story/arc']}>
        <Routes>
          <Route
            path="/projects/:projectId"
            element={<Outlet context={{ project: { lastEpisodeNumber: 12, nextEpisodeNumber: 13, targetEpisode: 25 } }} />}
          >
            <Route path="arc" element={<ArcPage />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  listedArcs = [completedArc, archivedArc, activeArc, plannedArc];
  vi.spyOn(api.arcs, 'list').mockImplementation(async () => [...listedArcs]);
  vi.spyOn(api.arcs, 'current').mockImplementation(async () =>
    listedArcs.find((item) => item.status === 'ACTIVE') ?? null,
  );
  vi.spyOn(api.arcs, 'update').mockImplementation(async (_projectId, arcId, input) => {
    const current = listedArcs.find((item) => item.id === arcId);
    if (!current) throw new Error('아크가 없습니다.');
    const updated: Arc = {
      ...current,
      ...input,
      revision: current.revision + 1,
      updatedAt: '2026-09-02T00:00:00.000Z',
    };
    listedArcs = listedArcs.map((item) => item.id === arcId ? updated : item);
    return updated;
  });
  vi.spyOn(api.arcs, 'remove').mockImplementation(async (_projectId, arcId) => {
    listedArcs = listedArcs.filter((item) => item.id !== arcId);
  });
  vi.spyOn(api.arcs, 'create').mockImplementation(async (_projectId, input) => {
    const created: Arc = {
      id: 'created',
      projectId: 'story',
      ...input,
      status: input.status ?? 'PLANNED',
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    listedArcs = [...listedArcs, created];
    return created;
  });
  vi.spyOn(api.arcs, 'plan').mockResolvedValue(aiProposal);
});

afterEach(() => vi.restoreAllMocks());

describe('arc lifecycle UI', () => {
  it('groups mixed statuses and exposes mutations only for the current and planned arcs', async () => {
    renderPage();
    await screen.findByRole('heading', { name: '아크 계획' });

    const current = screen.getByRole('region', { name: '현재 아크' });
    const planned = screen.getByRole('region', { name: '대기 중인 아크' });
    const completed = screen.getByRole('region', { name: '이전 아크' });
    const archived = screen.getByRole('region', { name: '보관된 아크' });

    expect(within(current).getByRole('heading', { name: activeArc.title })).toBeVisible();
    expect(within(planned).getByRole('heading', { name: plannedArc.title })).toBeVisible();
    expect(within(completed).getByRole('heading', { name: completedArc.title })).toBeVisible();
    expect(within(archived).getByRole('heading', { name: archivedArc.title })).toBeVisible();
    expect(within(current).getByText(/기존 반전 문장을 그대로 유지한다/)).toBeVisible();
    expect(within(current).getByText('현재의 관문 11화 방향')).toBeVisible();
    expect(within(current).queryByText('회차별 반전')).not.toBeInTheDocument();
    expect(within(planned).getByRole('button', { name: '편집' })).toBeVisible();
    expect(within(planned).getByRole('button', { name: '현재 아크로 전환' })).toBeVisible();
    expect(within(planned).getByRole('button', { name: '삭제' })).toBeVisible();
    expect(within(completed).queryByRole('button', { name: /편집|현재 아크로 전환|삭제/ })).not.toBeInTheDocument();
    expect(within(archived).queryByRole('button', { name: /편집|현재 아크로 전환|삭제/ })).not.toBeInTheDocument();
  });

  it('requires confirmation before editing ACTIVE and sends the protected update contract', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    const user = userEvent.setup();
    renderPage();
    const editCurrent = await screen.findByRole('button', { name: '현재 아크 변경' });

    await user.click(editCurrent);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(screen.queryByLabelText('아크 제목')).not.toBeInTheDocument();

    await user.click(editCurrent);
    const goal = screen.getByLabelText('목표');
    await user.clear(goal);
    await user.type(goal, '확인하고 현재 계획을 바꾼다.');
    await user.click(screen.getByRole('button', { name: '변경 저장' }));

    await waitFor(() => expect(api.arcs.update).toHaveBeenCalledTimes(1));
    expect(api.arcs.update).toHaveBeenCalledWith('story', activeArc.id, {
      title: activeArc.title,
      startEpisode: activeArc.startEpisode,
      endEpisode: activeArc.endEpisode,
      goal: '확인하고 현재 계획을 바꾼다.',
      conflict: activeArc.conflict,
      milestones: activeArc.milestones,
      episodeDirections: activeArc.episodeDirections,
      expectedRevision: activeArc.revision,
      confirmProtected: true,
    });
  });

  it('edits PLANNED without claiming a protected change', async () => {
    const user = userEvent.setup();
    renderPage();
    const planned = await screen.findByRole('region', { name: '대기 중인 아크' });
    await user.click(within(planned).getByRole('button', { name: '편집' }));
    const title = screen.getByLabelText('아크 제목');
    await user.clear(title);
    await user.type(title, '수정한 왕도의 그림자');
    await user.click(screen.getByRole('button', { name: '변경 저장' }));

    await waitFor(() => expect(api.arcs.update).toHaveBeenCalledTimes(1));
    const input = vi.mocked(api.arcs.update).mock.calls[0]![2];
    expect(input).toMatchObject({
      title: '수정한 왕도의 그림자',
      expectedRevision: plannedArc.revision,
    });
    expect(input).not.toHaveProperty('confirmProtected');
    expect(input).not.toHaveProperty('status');
  });

  it('keeps matching episode directions when the arc range changes', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: '대기 아크 추가' }));
    fireEvent.change(screen.getByLabelText('22화 제목'), { target: { value: '보존할 제목' } });
    fireEvent.change(screen.getByLabelText('22화 전개 방향'), { target: { value: '보존할 전개 방향' } });

    await user.clear(screen.getByLabelText('시작 회차'));
    await user.type(screen.getByLabelText('시작 회차'), '22');
    await user.clear(screen.getByLabelText('끝 회차'));
    await user.type(screen.getByLabelText('끝 회차'), '26');

    expect(screen.getByLabelText('22화 제목')).toHaveValue('보존할 제목');
    expect(screen.getByLabelText('22화 전개 방향')).toHaveValue('보존할 전개 방향');
    expect(screen.getByLabelText('26화 제목')).toHaveValue('');
  });

  it('does not save a manual arc while any episode direction is empty', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: '대기 아크 추가' }));
    await user.type(screen.getByLabelText('아크 제목'), '비어 있는 전개');
    await user.type(screen.getByLabelText('목표'), '끝에 도달한다.');
    await user.type(screen.getByLabelText('핵심 갈등'), '길이 막혀 있다.');
    await user.type(screen.getByLabelText('1번째 마일스톤 내용'), '관문을 연다.');

    await user.click(screen.getByRole('button', { name: '대기 아크 저장' }));

    expect(await screen.findByText('21화의 제목과 전개 방향을 모두 입력해 주세요.')).toBeVisible();
    expect(api.arcs.create).not.toHaveBeenCalled();
  });

  it('locks the arc editor controls while a save request is pending', async () => {
    vi.mocked(api.arcs.update).mockReturnValueOnce(new Promise<never>(() => undefined));
    const user = userEvent.setup();
    renderPage();
    const planned = await screen.findByRole('region', { name: '대기 중인 아크' });
    await user.click(within(planned).getByRole('button', { name: '편집' }));
    const titleInput = screen.getByLabelText('아크 제목');
    const editorFieldset = titleInput.closest('fieldset');

    await user.click(screen.getByRole('button', { name: '변경 저장' }));

    await waitFor(() => expect(api.arcs.update).toHaveBeenCalledTimes(1));
    expect(editorFieldset).toBeDisabled();
    expect(titleInput).toBeDisabled();
    expect(screen.getByRole('button', { name: '취소' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '변경 저장' })).toBeDisabled();
  });

  it('confirms and deletes only the selected PLANNED arc', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const user = userEvent.setup();
    renderPage();
    const planned = await screen.findByRole('region', { name: '대기 중인 아크' });
    await user.click(within(planned).getByRole('button', { name: '삭제' }));

    expect(confirm).toHaveBeenCalledWith(expect.stringContaining(plannedArc.title));
    await waitFor(() => expect(api.arcs.remove).toHaveBeenCalledWith('story', plannedArc.id, plannedArc.revision));
  });

  it('activates PLANNED with its revision and explicit protected confirmation', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const user = userEvent.setup();
    renderPage();
    const planned = await screen.findByRole('region', { name: '대기 중인 아크' });
    await user.click(within(planned).getByRole('button', { name: '현재 아크로 전환' }));

    expect(confirm).toHaveBeenCalledWith(expect.stringContaining(activeArc.title));
    await waitFor(() => expect(api.arcs.update).toHaveBeenCalledWith('story', plannedArc.id, {
      expectedRevision: plannedArc.revision,
      status: 'ACTIVE',
      confirmProtected: true,
    }));
  });

  it('creates a manual arc after the live timeline and always stores it as PLANNED', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: '대기 아크 추가' }));
    expect(screen.getByLabelText('시작 회차')).toHaveValue(21);
    expect(screen.getByLabelText('끝 회차')).toHaveValue(25);
    await user.type(screen.getByLabelText('아크 제목'), '왕도 이후');
    await user.type(screen.getByLabelText('목표'), '새로운 도시로 떠난다.');
    await user.type(screen.getByLabelText('핵심 갈등'), '국경이 봉쇄된다.');
    fireEvent.change(screen.getByLabelText('1번째 마일스톤 내용'), { target: { value: '새로운 도시로 출발한다.' } });
    for (let episode = 21; episode <= 25; episode += 1) {
      fireEvent.change(screen.getByLabelText(`${episode}화 제목`), { target: { value: `${episode}화의 문` } });
      fireEvent.change(screen.getByLabelText(`${episode}화 전개 방향`), { target: { value: `${episode}화 사건을 전개한다.` } });
    }
    await user.click(screen.getByRole('button', { name: '대기 아크 저장' }));

    await waitFor(() => expect(api.arcs.create).toHaveBeenCalledWith('story', {
      title: '왕도 이후',
      startEpisode: 21,
      endEpisode: 25,
      goal: '새로운 도시로 떠난다.',
      conflict: '국경이 봉쇄된다.',
      milestones: [{ episode: 25, type: 'GOAL', description: '새로운 도시로 출발한다.' }],
      episodeDirections: Array.from({ length: 5 }, (_, index) => ({
        episode: 21 + index,
        title: `${21 + index}화의 문`,
        direction: `${21 + index}화 사건을 전개한다.`,
      })),
      status: 'PLANNED',
    }));
  });

  it('loads an AI proposal into review and stores it as PLANNED', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'AI로 미래 아크 제안' }));
    await user.click(screen.getByRole('button', { name: '제안 만들기' }));
    expect(await screen.findByRole('heading', { name: aiProposal.title })).toBeVisible();
    expect(screen.getByText(/왕이 달을 숨긴 이유가 드러난다/)).toBeVisible();
    expect(screen.getByText('달의 귀환 25화 방향')).toBeVisible();
    await user.click(screen.getByRole('button', { name: '대기 아크 편집 폼에 불러오기' }));
    expect(screen.getByLabelText('아크 제목')).toHaveValue(aiProposal.title);
    await user.click(screen.getByRole('button', { name: '대기 아크 저장' }));

    await waitFor(() => expect(api.arcs.create).toHaveBeenCalledWith('story', {
      title: aiProposal.title,
      startEpisode: aiProposal.startEpisodeNumber,
      endEpisode: aiProposal.endEpisodeNumber,
      goal: aiProposal.goal,
      conflict: aiProposal.conflict,
      milestones: aiProposal.milestones,
      episodeDirections: aiProposal.episodeDirections,
      status: 'PLANNED',
    }));
  });

  it('ignores a planner response that arrives after the planner is closed', async () => {
    let resolvePlan!: (proposal: ArcPlanProposal) => void;
    vi.mocked(api.arcs.plan).mockImplementationOnce(() => new Promise((resolve) => { resolvePlan = resolve; }));
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'AI로 미래 아크 제안' }));
    await user.click(screen.getByRole('button', { name: '제안 만들기' }));
    await waitFor(() => expect(api.arcs.plan).toHaveBeenCalledTimes(1));

    await user.click(screen.getByRole('button', { name: '닫기' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await act(async () => { resolvePlan(aiProposal); });

    await user.click(screen.getByRole('button', { name: 'AI로 미래 아크 제안' }));
    expect(screen.getByLabelText(/원하는 흐름/)).toBeVisible();
    expect(screen.queryByRole('heading', { name: aiProposal.title })).not.toBeInTheDocument();
  });

  it('loads an AI revision for the next planned arc into that arc instead of duplicating it', async () => {
    const revision = {
      ...aiProposal,
      startEpisodeNumber: plannedArc.startEpisode,
      endEpisodeNumber: plannedArc.endEpisode,
      milestones: [{ episode: 19, type: 'REVERSAL' as const, description: '왕이 달을 숨긴 이유가 드러난다.' }],
      episodeDirections: directions(16, 20, '수정된 왕도'),
      replaceArcId: plannedArc.id,
      replaceArcRevision: plannedArc.revision,
    };
    vi.mocked(api.arcs.plan).mockResolvedValueOnce(revision);
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'AI로 미래 아크 제안' }));
    await user.click(screen.getByRole('button', { name: '제안 만들기' }));
    await user.click(await screen.findByRole('button', { name: '대기 아크 편집 폼에 불러오기' }));
    await user.click(screen.getByRole('button', { name: '변경 저장' }));

    await waitFor(() => expect(api.arcs.update).toHaveBeenCalledWith('story', plannedArc.id, {
      title: revision.title,
      startEpisode: revision.startEpisodeNumber,
      endEpisode: revision.endEpisodeNumber,
      goal: revision.goal,
      conflict: revision.conflict,
      milestones: revision.milestones,
      episodeDirections: revision.episodeDirections,
      expectedRevision: plannedArc.revision,
    }));
    expect(api.arcs.create).not.toHaveBeenCalled();
  });
});
