import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import ProjectsPage from './ProjectsPage';
import ProjectWizardPage from './ProjectWizardPage';

function renderPage(page: ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>{page}</MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

describe('mobile entry flows', () => {
  it('renders the empty project state and global comparison entry', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify([]), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })));

    renderPage(<ProjectsPage />);

    expect(await screen.findByText('첫 이야기를 시작해 볼까요?')).toBeTruthy();
    expect(screen.getByRole('link', { name: '두 원고 비교' }).getAttribute('href')).toBe('/compare');
  });

  it('asks for the title in the AI interview rather than the initial form', () => {
    renderPage(<ProjectWizardPage />);

    expect(screen.getByLabelText(/로그라인/)).toBeTruthy();
    expect(screen.queryByLabelText('소설 제목')).toBeNull();
    expect(screen.getByText('제목은 다음 단계에서 AI가 반드시 직접 물어봐요.')).toBeTruthy();
  });
});
