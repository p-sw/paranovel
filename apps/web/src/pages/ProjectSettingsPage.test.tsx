import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { api } from '../api/client';
import type { Project } from '../types';
import ProjectSettingsPage from './ProjectSettingsPage';

type ProjectWithWritingDirection = Project & { writingDirection: string };

const project: ProjectWithWritingDirection = {
  id: 'story',
  title: '기억의 문',
  logline: '기억을 읽는 기록관이 닫힌 문을 찾아간다.',
  genreTags: ['판타지', '미스터리'],
  writingDirection: '주인공 1인칭 시점으로 짧고 건조하게 쓴다.',
  defaultTargetChars: 5_000,
  revision: 7,
  nextEpisodeNumber: 2,
  episodeCount: 1,
  lastEpisodeNumber: 1,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
};

function renderPage(value: ProjectWithWritingDirection = project) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  queryClient.setQueryData(['projects', value.id], value);
  const view = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/projects/${value.id}/settings`]}>
        <Routes>
          <Route path="/projects/:projectId" element={<Outlet context={{ project: value }} />}>
            <Route path="settings" element={<ProjectSettingsPage />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...view, queryClient, user: userEvent.setup() };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('project writing direction settings', () => {
  it('shows the existing writing direction and explains its persistent AI use', () => {
    renderPage();

    expect(screen.getByRole('textbox', { name: '작문 디렉션' })).toHaveValue(project.writingDirection);
    expect(screen.getByText('시점·시제·문체·호흡, 묘사와 대화 방식처럼 AI가 계속 지켜야 할 집필 원칙을 적어 주세요.')).toBeInTheDocument();
  });

  it('saves every edited field exactly and replaces the project query cache with the response', async () => {
    const updated: ProjectWithWritingDirection = {
      ...project,
      title: '잊힌 기록의 문',
      logline: '기억을 잃은 기록관이 봉인된 진실을 추적한다.',
      genreTags: ['다크 판타지', '추리'],
      writingDirection: '  3인칭 제한적 시점으로 쓴다.\n대사는 짧고 긴장감 있게 유지한다.\n',
      revision: 8,
      updatedAt: '2026-09-07T01:00:00.000Z',
    };
    const update = vi.spyOn(api.projects, 'update').mockResolvedValue(updated);
    const { queryClient, user } = renderPage();

    await user.clear(screen.getByLabelText('소설 제목'));
    await user.type(screen.getByLabelText('소설 제목'), updated.title);
    await user.clear(screen.getByLabelText('로그라인'));
    await user.type(screen.getByLabelText('로그라인'), updated.logline);
    await user.clear(screen.getByLabelText('장르 태그'));
    await user.type(screen.getByLabelText('장르 태그'), '다크 판타지, 추리');
    fireEvent.change(screen.getByLabelText('작문 디렉션'), {
      target: { value: updated.writingDirection },
    });
    await user.click(screen.getByRole('button', { name: '변경 저장' }));

    await waitFor(() => expect(update).toHaveBeenCalledWith('story', {
      expectedRevision: 7,
      title: updated.title,
      logline: updated.logline,
      genreTags: updated.genreTags,
      writingDirection: updated.writingDirection,
    }));
    await waitFor(() => expect(queryClient.getQueryData(['projects', 'story'])).toEqual(updated));
  });

  it('allows the writing direction to be cleared', async () => {
    const updated: ProjectWithWritingDirection = {
      ...project,
      writingDirection: '',
      revision: 8,
      updatedAt: '2026-09-07T02:00:00.000Z',
    };
    const update = vi.spyOn(api.projects, 'update').mockResolvedValue(updated);
    const { user } = renderPage();

    await user.clear(screen.getByLabelText('작문 디렉션'));
    await user.click(screen.getByRole('button', { name: '변경 저장' }));

    await waitFor(() => expect(update).toHaveBeenCalledWith('story', {
      expectedRevision: 7,
      title: project.title,
      logline: project.logline,
      genreTags: project.genreTags,
      writingDirection: '',
    }));
  });
});
