import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { api } from '../api/client';
import EpisodesPage from './EpisodesPage';

const proposal = {
  title: '닫힌 문 너머',
  direction: '기록관이 사라진 동료의 흔적을 따라 왕궁에 들어간다.',
  conflicts: [],
};

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/projects/story/episodes']}>
        <Routes>
          <Route path="/projects/:projectId" element={<Outlet context={{ project: { genreTags: ['판타지'], logline: '기록관의 모험' } }} />}>
            <Route path="episodes" element={<EpisodesPage />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.spyOn(api.episodes, 'list').mockResolvedValue([]);
  vi.spyOn(api.episodes, 'propose').mockResolvedValue(proposal);
});

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function openCreator() {
  const user = userEvent.setup();
  renderPage();
  await user.click(screen.getByRole('button', { name: '새 회차' }));
  return user;
}

describe('new episode flow', () => {
  it('keeps the same readable textarea and scroll position through writing, checking and completion', async () => {
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({
      start(controller) { stream = controller; },
    }))));
    const user = await openCreator();
    await user.click(screen.getByRole('button', { name: '다음' }));
    await user.click(await screen.findByRole('button', { name: 'AI 초안 만들기' }));
    const textarea = screen.getByLabelText('AI 초안 수정') as HTMLTextAreaElement;
    const draft = '문을 열자 빛이 쏟아졌다.\n\n'.repeat(500);
    const send = async (event: unknown) => act(async () => {
      stream.enqueue(new TextEncoder().encode(`${JSON.stringify(event)}\n`));
    });
    await send({ type: 'stage', stage: 'WRITING' });
    await send({ type: 'delta', text: draft });
    textarea.scrollTop = 640;
    textarea.dispatchEvent(new Event('scroll'));
    await send({ type: 'stage', stage: 'CHECKING' });

    expect(screen.getByLabelText('AI 초안 수정')).toBe(textarea);
    expect(textarea).toHaveValue(draft);
    expect(textarea.readOnly).toBe(true);
    expect(textarea).toBeEnabled();
    expect(textarea.scrollTop).toBe(640);
    const status = screen.getByText('일관성을 확인하는 중');
    expect(status.closest('.sheet-body')).toBeNull();
    expect(status).toBeVisible();

    const repaired = draft.replaceAll('빛이', '비가');
    await send({ type: 'done', content: repaired, issues: [], blocked: false });
    expect(screen.getByLabelText('AI 초안 수정')).toBe(textarea);
    expect(textarea).toHaveValue(repaired);
    expect(textarea.readOnly).toBe(false);
    expect(textarea.scrollTop).toBe(640);
    expect(screen.getByRole('button', { name: '초안 저장' })).toBeEnabled();
  });

  it.each(['error', 'empty', 'eof', 'cancel'] as const)('preserves the draft when repair ends with %s', async (failure) => {
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({
      start(controller) { stream = controller; },
    }))));
    const create = vi.spyOn(api.episodes, 'create').mockResolvedValue({} as never);
    const user = await openCreator();
    await user.click(screen.getByRole('button', { name: '다음' }));
    await user.click(await screen.findByRole('button', { name: 'AI 초안 만들기' }));
    const send = async (event: unknown) => act(async () => {
      stream.enqueue(new TextEncoder().encode(`${JSON.stringify(event)}\n`));
    });
    await send({ type: 'delta', text: '보존해야 할 원고.' });
    await send({ type: 'stage', stage: 'CHECKING' });
    await send({ type: 'stage', stage: 'REPAIRING' });
    await send({ type: 'reset' });
    await send({ type: 'delta', text: '아직 완성되지 않은 보정' });
    expect(screen.getByText('충돌을 바로잡는 중')).toBeVisible();
    expect(screen.getByLabelText('AI 초안 수정')).toHaveValue('보존해야 할 원고.');

    if (failure === 'error') await send({ type: 'error', code: 'FAILED', message: '보정 오류' });
    if (failure === 'empty') await send({ type: 'done', content: ' ', issues: [], blocked: false });
    if (failure === 'eof') await act(async () => stream.close());
    if (failure === 'cancel') await user.click(screen.getByRole('button', { name: '생성 중단' }));

    expect(await screen.findByRole('button', { name: '검토 필요로 저장' })).toBeEnabled();
    expect(screen.getByLabelText('AI 초안 수정')).toHaveValue('보존해야 할 원고.');
    expect((screen.getByLabelText('AI 초안 수정') as HTMLTextAreaElement).readOnly).toBe(false);
    await user.click(screen.getByRole('button', { name: '검토 필요로 저장' }));
    expect(create).toHaveBeenCalledWith('story', expect.objectContaining({ content: '보존해야 할 원고.', forceNeedsReview: true }), expect.any(String));
  });

  it('starts with one optional request and generates the title and direction on next, even when empty', async () => {
    const generate = vi.spyOn(api.episodes, 'generate').mockResolvedValue({ content: '완성된 첫 문장.', issues: [], blocked: false });
    const create = vi.spyOn(api.episodes, 'create').mockResolvedValue({} as never);
    const user = await openCreator();
    const dialog = within(screen.getByRole('dialog'));

    expect(dialog.getAllByRole('textbox')).toHaveLength(1);
    expect(dialog.getByLabelText(/이번 회차에 원하는 것/)).not.toBeRequired();
    expect(dialog.getByRole('button', { name: '다음' })).toBeEnabled();
    expect(dialog.queryByRole('button', { name: /제안/ })).not.toBeInTheDocument();
    expect(dialog.queryByLabelText('회차 제목')).not.toBeInTheDocument();
    expect(api.episodes.propose).not.toHaveBeenCalled();

    await user.click(dialog.getByRole('button', { name: '다음' }));

    expect(api.episodes.propose).toHaveBeenCalledWith('story', undefined, expect.any(AbortSignal));
    expect(await dialog.findByLabelText('회차 제목')).toHaveValue(proposal.title);
    expect(dialog.getByLabelText('전개 방향')).toHaveValue(proposal.direction);
    expect(dialog.queryByLabelText(/이번 회차에 원하는 것/)).not.toBeInTheDocument();
    expect(generate).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();

    await user.click(dialog.getByRole('button', { name: 'AI 초안 만들기' }));
    expect(await dialog.findByLabelText('AI 초안 수정')).toHaveValue('완성된 첫 문장.');
    expect(generate).toHaveBeenCalledWith('story', { title: proposal.title, direction: proposal.direction }, expect.any(Function), expect.any(AbortSignal));
    await user.click(dialog.getByRole('button', { name: '초안 저장' }));
    expect(create).toHaveBeenCalledWith('story', {
      title: proposal.title, direction: proposal.direction, content: '완성된 첫 문장.', forceNeedsReview: false,
    }, expect.any(String));
  });

  it('sends only the user request and lets the generated plan be edited before starting an empty episode', async () => {
    const create = vi.spyOn(api.episodes, 'create').mockResolvedValue({} as never);
    const user = await openCreator();
    await user.type(screen.getByLabelText(/이번 회차에 원하는 것/), '  능력을 들키는 장면\n동료의 반응도 보여 줘  ');
    await user.click(screen.getByRole('button', { name: '다음' }));

    expect(api.episodes.propose).toHaveBeenCalledWith('story', '능력을 들키는 장면\n동료의 반응도 보여 줘', expect.any(AbortSignal));
    const title = await screen.findByLabelText('회차 제목');
    await user.clear(title);
    await user.type(title, '드러난 비밀');
    await user.click(screen.getByRole('button', { name: '빈 회차로 시작' }));
    expect(create).toHaveBeenCalledWith('story', {
      title: '드러난 비밀', direction: proposal.direction, content: '', forceNeedsReview: false,
    }, expect.any(String));
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
    await user.click(screen.getByRole('button', { name: '새 회차' }));
    await act(async () => finish(proposal));

    expect(screen.getByLabelText(/이번 회차에 원하는 것/)).toHaveValue('');
    expect(screen.queryByLabelText('회차 제목')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '다음' })).toBeEnabled();
    expect(api.episodes.propose).toHaveBeenCalledTimes(1);
  });
});
