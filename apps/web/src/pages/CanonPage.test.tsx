import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { api } from '../api/client';
import type { CanonEntry } from '../types';
import CanonPage from './CanonPage';

const appearance: CanonEntry = {
  id: 'appearance', projectId: 'story', category: 'CHARACTER_APPEARANCE', name: '하린', aliases: ['기록관'],
  content: '머리카락: 은색\n눈동자: 보라색\n피부: 올리브색\n복장: 남색 코트\n장신구: 초승달 귀걸이',
  metadata: { source: '인물 설계' }, revision: 3, status: 'ACTIVE',
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
};

function renderPage(path = '/projects/story/canon') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}>
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/projects/:projectId" element={<Outlet context={{ project: { title: '기록의 문' } }} />}>
          <Route path="canon" element={<CanonPage />} />
        </Route>
      </Routes>
    </MemoryRouter>
  </QueryClientProvider>);
}

afterEach(() => vi.restoreAllMocks());

describe('pending canon filter', () => {
  it('does not claim there are no pending entries when loading fails', async () => {
    vi.spyOn(api.canon, 'list').mockRejectedValue(new Error('정사 조회 실패'));

    renderPage('/projects/story/canon?status=PENDING');

    expect(await screen.findByRole('alert')).toHaveTextContent('정사 조회 실패');
    expect(screen.queryByText('검토 중인 정사가 없어요')).not.toBeInTheDocument();
    expect(screen.queryByText('아직 확정된 설정이 없어요')).not.toBeInTheDocument();
  });

  it('combines pending status with category and search while allowing all statuses again', async () => {
    const pendingCharacter: CanonEntry = { ...appearance, id: 'pending-character', category: 'CHARACTER', status: 'PENDING' };
    const pendingLocation: CanonEntry = { ...appearance, id: 'pending-location', category: 'LOCATION', name: '왕궁', aliases: [], content: '왕궁의 비밀 통로', status: 'PENDING' };
    vi.spyOn(api.canon, 'list').mockResolvedValue([
      pendingCharacter, pendingLocation, appearance,
      { ...appearance, id: 'accepted', status: 'ACCEPTED' },
      { ...appearance, id: 'rejected', status: 'REJECTED' },
    ]);
    const user = userEvent.setup();
    renderPage();
    const list = within(await screen.findByRole('region', { name: '정사 목록' }));
    expect(list.getAllByRole('article')).toHaveLength(5);
    await user.click(screen.getByRole('checkbox', { name: '검토 중만 보기' }));
    expect(list.getAllByRole('article')).toHaveLength(2);
    expect(list.getAllByRole('button', { name: '정사로 승인' })).toHaveLength(2);

    await user.type(screen.getByRole('textbox', { name: '정사 검색' }), '기록관');
    expect(list.getAllByRole('article')).toHaveLength(1);
    expect(list.getByRole('heading', { name: '하린' })).toBeVisible();
    await user.click(screen.getByRole('tab', { name: '장소' }));
    expect(screen.queryByRole('region', { name: '정사 목록' })).not.toBeInTheDocument();
    expect(screen.getByText('조건에 맞는 설정이 없어요')).toBeVisible();
    await user.clear(screen.getByRole('textbox', { name: '정사 검색' }));
    expect(screen.getByRole('heading', { name: '왕궁' })).toBeVisible();
    await user.click(screen.getByRole('tab', { name: '전체' }));
    await user.click(screen.getByRole('checkbox', { name: '검토 중만 보기' }));
    expect(within(screen.getByRole('region', { name: '정사 목록' })).getAllByRole('article')).toHaveLength(5);
  });

  it('starts filtered from the warning link and removes approved entries from the pending list', async () => {
    const pending: CanonEntry = { ...appearance, status: 'PENDING' };
    const list = vi.spyOn(api.canon, 'list').mockResolvedValue([pending]);
    vi.spyOn(api.canon, 'update').mockImplementation(async () => {
      list.mockResolvedValue([appearance]);
      return appearance;
    });
    const user = userEvent.setup();
    renderPage('/projects/story/canon?status=PENDING');
    expect(screen.getByRole('checkbox', { name: '검토 중만 보기' })).toBeChecked();
    await user.click(await screen.findByRole('button', { name: '정사로 승인' }));
    expect(await screen.findByText('검토 중인 정사가 없어요')).toBeVisible();
    expect(screen.queryByRole('region', { name: '정사 목록' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '첫 설정 추가' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: '검토 중만 보기' }));
    expect(screen.getByRole('heading', { name: '하린' })).toBeVisible();
    expect(screen.queryByRole('button', { name: '정사로 승인' })).not.toBeInTheDocument();
  });

  it('shows approval failures and blocks duplicate approvals while the request is pending', async () => {
    const pending: CanonEntry = { ...appearance, status: 'PENDING' };
    vi.spyOn(api.canon, 'list').mockResolvedValue([pending]);
    let rejectApproval!: (reason: Error) => void;
    const update = vi.spyOn(api.canon, 'update').mockImplementation(() => new Promise((_resolve, reject) => {
      rejectApproval = reject;
    }));
    const user = userEvent.setup();
    renderPage('/projects/story/canon?status=PENDING');
    const approve = await screen.findByRole('button', { name: '정사로 승인' });

    await user.click(approve);
    expect(approve).toBeDisabled();
    expect(approve).toHaveAttribute('aria-busy', 'true');
    await user.click(approve);
    expect(update).toHaveBeenCalledTimes(1);

    rejectApproval(new Error('승인 충돌'));
    expect(await screen.findByText('정사 승인에 실패했습니다. 승인 충돌')).toBeVisible();
    expect(approve).toBeEnabled();
  });
});

describe('character appearance canon editor', () => {
  it('shows visual-detail guidance and saves a separate appearance entry', async () => {
    vi.spyOn(api.canon, 'list').mockResolvedValue([]);
    const create = vi.spyOn(api.canon, 'create').mockResolvedValue(appearance);
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: '추가' }));
    await user.selectOptions(screen.getByLabelText('분류'), 'CHARACTER_APPEARANCE');
    expect(screen.getByLabelText('확정 내용')).toHaveAccessibleDescription(/머리카락 색·길이·스타일.*눈동자 색.*피부색.*장신구/);
    await user.type(screen.getByLabelText('이름'), appearance.name);
    await user.type(screen.getByLabelText('확정 내용'), appearance.content);
    await user.click(screen.getByRole('button', { name: '저장' }));
    await waitFor(() => expect(create).toHaveBeenCalledWith('story', expect.objectContaining({
      category: 'CHARACTER_APPEARANCE', name: appearance.name, content: appearance.content, status: 'ACTIVE',
    })));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('filters same-name character records and preserves appearance metadata and revision on edit', async () => {
    vi.spyOn(api.canon, 'list').mockResolvedValue([
      { ...appearance, id: 'character', category: 'CHARACTER', content: '기억을 읽는 기록관' }, appearance,
    ]);
    const update = vi.spyOn(api.canon, 'update').mockResolvedValue({ ...appearance, revision: 4 });
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('기억을 읽는 기록관');
    await user.click(screen.getByRole('tab', { name: '인물 외형' }));
    expect(screen.queryByText('기억을 읽는 기록관')).not.toBeInTheDocument();
    const list = within(screen.getByRole('region', { name: '정사 목록' }));
    await user.click(list.getByRole('button', { name: /인물 외형/ }));
    expect(screen.getByLabelText('확정 내용')).toHaveValue(appearance.content);
    await user.type(screen.getByLabelText('확정 내용'), '\n신발: 검은 장화');
    await user.click(screen.getByRole('button', { name: '저장' }));
    await waitFor(() => expect(update).toHaveBeenCalledWith('story', appearance.id, expect.objectContaining({
      category: 'CHARACTER_APPEARANCE', content: `${appearance.content}\n신발: 검은 장화`,
      metadata: appearance.metadata, expectedRevision: 3,
    })));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
});
