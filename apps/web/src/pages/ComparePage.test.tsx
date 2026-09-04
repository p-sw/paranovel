import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import ComparePage from './ComparePage';

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter><ComparePage /></MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('mobile comparison workspace', () => {
  it('keeps user, AI and change tabs together after generation', async () => {
    const stream = [
      { type: 'meta', runId: 'comparison-run' },
      { type: 'stage', stage: 'WRITING' },
      { type: 'delta', text: 'AI가 쓴 원고' },
      { type: 'done', content: 'AI가 쓴 원고', blocked: false, issues: [] },
    ].map((event) => JSON.stringify(event)).join('\n');
    vi.stubGlobal('fetch', vi.fn().mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/projects')) {
        return Promise.resolve(new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }));
      }
      return Promise.resolve(new Response(stream, { status: 200, headers: { 'content-type': 'application/x-ndjson' } }));
    }));

    renderPage();
    fireEvent.change(screen.getByLabelText('생성용 방향·브리프'), { target: { value: '비 오는 성벽에서의 대치' } });
    fireEvent.change(screen.getByLabelText('내가 작성한 원고'), { target: { value: '사용자가 쓴 원고' } });
    fireEvent.click(screen.getByRole('button', { name: '독립 초안 생성' }));

    expect(await screen.findByRole('tab', { name: '사용자 원고' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'AI 원고' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: '변경점' })).toBeTruthy();
  });
});
