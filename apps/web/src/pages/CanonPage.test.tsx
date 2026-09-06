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

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}>
    <MemoryRouter initialEntries={['/projects/story/canon']}>
      <Routes>
        <Route path="/projects/:projectId" element={<Outlet context={{ project: { title: '기록의 문' } }} />}>
          <Route path="canon" element={<CanonPage />} />
        </Route>
      </Routes>
    </MemoryRouter>
  </QueryClientProvider>);
}

afterEach(() => vi.restoreAllMocks());

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
