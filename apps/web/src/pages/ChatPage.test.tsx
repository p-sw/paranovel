import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { ChatHistory, ChatMessage, ChatProposal, ChatThread } from '@paranovel/contracts';
import { api, ApiError } from '../api/client';
import ChatPage from './ChatPage';

const thread: ChatThread = { id: 'room-1', projectId: 'story', title: '새 채팅', createdAt: '2026-09-06T00:00:00.000Z', updatedAt: '2026-09-06T00:00:00.000Z' };
const proposal: ChatProposal = {
  id: 'proposal-1', projectId: 'story', messageId: 'assistant-1', kind: 'CANON', operation: 'UPDATE',
  title: '능력의 대가 변경', targetId: 'canon-1', before: { name: '기억의 문', content: '대가 없음', revision: 1 },
  after: { name: '기억의 문', content: '문을 열 때 기억을 하나 잃는다.' }, effects: [],
  status: 'PENDING', createdAt: '2026-09-06T00:00:00.000Z', appliedAt: null, result: null,
};
const userMessage: ChatMessage = {
  id: 'user-1', projectId: 'story', clientMessageId: 'turn-1', role: 'user', content: '능력에 대가를 추가해 줘',
  status: 'COMPLETE', createdAt: '2026-09-06T00:00:00.000Z', proposals: [],
};
const assistantMessage: ChatMessage = {
  ...userMessage, id: 'assistant-1', role: 'assistant', content: '기억을 대가로 하는 설정을 제안합니다.', proposals: [proposal],
};

function renderPage(projectId = 'story', cachedHistory?: ChatHistory) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  if (cachedHistory) client.setQueryData(['chat', projectId, thread.id], cachedHistory);
  const view = render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[`/projects/${projectId}/chat/${thread.id}`]}>
    <Routes><Route path="/projects/:projectId/chat/:threadId" element={<ChatPage />} /></Routes>
  </MemoryRouter></QueryClientProvider>);
  return { ...view, client };
}

beforeEach(() => {
  vi.spyOn(api.chat, 'history').mockResolvedValue({ thread, messages: [] });
  vi.spyOn(api.chat, 'send').mockResolvedValue({ thread, messages: [userMessage, assistantMessage] });
  vi.spyOn(api.chat, 'apply').mockResolvedValue({ proposal: { ...proposal, status: 'APPLIED', appliedAt: '2026-09-06T01:00:00.000Z' } });
});
afterEach(() => vi.restoreAllMocks());

describe('project AI chat', () => {
  it('renders live text and simultaneous tools, survives history refreshes, and reviews proposals only at completion', async () => {
    let finish!: (history: ChatHistory) => void;
    let emit!: NonNullable<Parameters<typeof api.chat.send>[3]>;
    let turn!: Parameters<typeof api.chat.send>[1];
    vi.mocked(api.chat.send).mockImplementationOnce((_project, input, _thread, callback) => {
      turn = input;
      emit = callback!;
      return new Promise((resolve) => { finish = resolve; });
    });
    const { client } = renderPage();
    fireEvent.change(await screen.findByRole('textbox'), { target: { value: userMessage.content } });
    fireEvent.click(screen.getByRole('button', { name: '보내기' }));
    await waitFor(() => expect(emit).toBeDefined());
    act(() => {
      emit({ type: 'delta', text: '설정을 살펴보고 있어요.' }, '');
      emit({ type: 'tool_start', callId: 'one', name: 'search_canon' }, '');
      emit({ type: 'tool_start', callId: 'two', name: 'read_episode' }, '');
    });
    expect(screen.getByText('설정을 살펴보고 있어요.')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('도구 2개');
    const complete = { thread, messages: [
      { ...userMessage, clientMessageId: turn.clientMessageId },
      { ...assistantMessage, clientMessageId: turn.clientMessageId },
    ] };
    act(() => client.setQueryData(['chat', 'story', thread.id], complete));
    expect(screen.getAllByText('설정을 살펴보고 있어요.')).toHaveLength(1);
    expect(screen.queryByText(assistantMessage.content)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '변경안 적용' })).not.toBeInTheDocument();
    act(() => emit({ type: 'tool_end', callId: 'one', name: 'search_canon' }, ''));
    expect(screen.getByRole('status')).toHaveTextContent('도구 1개');
    act(() => {
      emit({ type: 'reset' }, '');
      emit({ type: 'delta', text: '기억을 대가로 ' }, '');
      emit({ type: 'delta', text: '하는 설정을 제안합니다.' }, '');
    });
    expect(screen.queryByText('설정을 살펴보고 있어요.')).not.toBeInTheDocument();
    expect(screen.getByText(assistantMessage.content)).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('답변을 쓰고 있어요.');
    await act(async () => finish(complete));
    expect(screen.getByRole('button', { name: '변경안 적용' })).toBeEnabled();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(api.chat.apply).not.toHaveBeenCalled();
  });

  it('keeps partial text on stream failure, then clears it and tool activity when retrying', async () => {
    let fail!: (error: Error) => void;
    let emit!: NonNullable<Parameters<typeof api.chat.send>[3]>;
    vi.mocked(api.chat.send).mockImplementationOnce((_project, _input, _thread, callback) => {
      emit = callback!;
      return new Promise((_resolve, reject) => { fail = reject; });
    }).mockImplementationOnce(() => new Promise(() => undefined));
    const { unmount } = renderPage();
    fireEvent.change(await screen.findByRole('textbox'), { target: { value: userMessage.content } });
    fireEvent.click(screen.getByRole('button', { name: '보내기' }));
    await waitFor(() => expect(emit).toBeDefined());
    act(() => {
      emit({ type: 'delta', text: '완료되지 않은 답변' }, '');
      emit({ type: 'tool_start', callId: 'one', name: 'search_canon' }, '');
    });
    await act(async () => fail(new Error('연결이 끊겼어요.')));
    expect(screen.getByText('완료되지 않은 답변')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('연결이 끊겼어요.');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '전송 다시 시도' }));
    await waitFor(() => expect(api.chat.send).toHaveBeenCalledTimes(2));
    expect(screen.queryByText('완료되지 않은 답변')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).not.toHaveTextContent('도구');
    const signal = vi.mocked(api.chat.send).mock.calls[1]![4]!;
    unmount();
    expect(signal.aborted).toBe(true);
  });

  it('labels project writing-direction changes in proposal reviews', async () => {
    const projectProposal: ChatProposal = {
      ...proposal,
      kind: 'PROJECT',
      targetId: 'story',
      title: '시점과 문체 변경',
      before: { writingDirection: '3인칭 현재 시점', revision: 1 },
      after: { writingDirection: '주인공 1인칭 과거 시점', revision: 2 },
    };
    vi.mocked(api.chat.history).mockResolvedValue({
      thread,
      messages: [{ ...assistantMessage, proposals: [projectProposal] }],
    });

    renderPage();

    const card = within(await screen.findByRole('region', { name: '시점과 문체 변경 변경안' }));
    expect(card.getByText('작문 디렉션')).toBeInTheDocument();
    expect(card.getByText('3인칭 현재 시점')).toBeInTheDocument();
    expect(card.getByText('주인공 1인칭 과거 시점')).toBeInTheDocument();
  });

  it.each([['CHARACTER', '인물'], ['CHARACTER_APPEARANCE', '인물 외형']])('shows the %s label and exact free-text metadata in the proposal review', async (category, label) => {
    vi.mocked(api.chat.history).mockResolvedValue({ thread, messages: [{ ...assistantMessage, proposals: [{
      ...proposal, before: null, operation: 'CREATE', after: {
        name: 'ACTIVE', category, content: 'ARCHIVED',
        metadata: { source: 'ACTIVE', id: 'user-defined-id', active: false, episode: 1, description: '실제 사용자 데이터' },
      },
    }] }] });
    renderPage();
    const card = within(await screen.findByRole('region', { name: '능력의 대가 변경 변경안' }));
    expect(card.getByText('ACTIVE', { exact: true })).toBeInTheDocument();
    expect(card.getByText('ARCHIVED', { exact: true })).toBeInTheDocument();
    expect(card.getByText(label!, { exact: true })).toBeInTheDocument();
    expect(card.getByText(/source: ACTIVE/)).toHaveTextContent('id: user-defined-id');
    expect(card.getByText(/source: ACTIVE/)).toHaveTextContent('active: false');
    expect(card.getByText(/source: ACTIVE/)).toHaveTextContent('description: 실제 사용자 데이터');
  });

  it('keeps a completed response when an older background history read finishes late', async () => {
    let finishHistory!: (history: ChatHistory) => void;
    vi.mocked(api.chat.history).mockImplementation(() => new Promise((resolve) => { finishHistory = resolve; }));
    renderPage('story', { thread, messages: [] });
    fireEvent.change(screen.getByRole('textbox'), { target: { value: userMessage.content } });
    fireEvent.click(screen.getByRole('button', { name: '보내기' }));
    expect(await screen.findByText(assistantMessage.content)).toBeInTheDocument();
    await act(async () => finishHistory({ thread, messages: [] }));
    expect(screen.getByText(assistantMessage.content)).toBeInTheDocument();
  });

  it('keeps the applied state when an older background history read finishes late', async () => {
    let finishHistory!: (history: ChatHistory) => void;
    vi.mocked(api.chat.history).mockImplementation(() => new Promise((resolve) => { finishHistory = resolve; }));
    const oldHistory = { thread, messages: [userMessage, assistantMessage] };
    renderPage('story', oldHistory);
    fireEvent.click(screen.getByRole('button', { name: '변경안 적용' }));
    expect(await screen.findByText('적용 완료')).toBeInTheDocument();
    await act(async () => finishHistory(oldHistory));
    expect(screen.getByText('적용 완료')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '변경안 적용' })).not.toBeInTheDocument();
  });

  it('restores history and applies a reviewable proposal only after clicking its apply button', async () => {
    vi.mocked(api.chat.history).mockResolvedValue({ thread, messages: [userMessage, assistantMessage] });
    const { client } = renderPage();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    expect(await screen.findByText(userMessage.content)).toBeInTheDocument();
    expect(screen.getByText(assistantMessage.content)).toBeInTheDocument();
    const card = within(screen.getByRole('region', { name: '능력의 대가 변경 변경안' }));
    expect(card.getByText('대가 없음')).toBeInTheDocument();
    expect(card.getByText('문을 열 때 기억을 하나 잃는다.')).toBeInTheDocument();
    expect(api.chat.apply).not.toHaveBeenCalled();
    fireEvent.click(card.getByRole('button', { name: '변경안 적용' }));
    expect(await card.findByText('적용 완료')).toBeInTheDocument();
    expect(api.chat.apply).toHaveBeenCalledExactlyOnceWith('story', 'proposal-1');
    expect(card.queryByRole('button', { name: '변경안 적용' })).not.toBeInTheDocument();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['canon', 'story'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['arcs', 'story'] });
  });

  it('sends a trimmed message, prevents duplicate sends, and preserves a draft written while waiting', async () => {
    let resolve!: (history: ChatHistory) => void;
    vi.mocked(api.chat.send).mockImplementation(() => new Promise((done) => { resolve = done; }));
    renderPage();
    const input = await screen.findByRole('textbox', { name: 'AI에게 보낼 메시지' });
    fireEvent.change(input, { target: { value: '  능력에 대가를 추가해 줘  ' } });
    fireEvent.click(screen.getByRole('button', { name: '보내기' }));
    await waitFor(() => expect(api.chat.send).toHaveBeenCalledTimes(1));
    expect(api.chat.send).toHaveBeenCalledWith('story', { content: '능력에 대가를 추가해 줘', clientMessageId: expect.any(String) }, thread.id, expect.any(Function), expect.any(AbortSignal));
    expect(screen.getByRole('button', { name: '보내기' })).toBeDisabled();
    fireEvent.change(input, { target: { value: '다음 질문을 미리 작성' } });
    await act(async () => resolve({ thread, messages: [userMessage, assistantMessage] }));
    expect(input).toHaveValue('다음 질문을 미리 작성');
    expect(await screen.findByText(assistantMessage.content)).toBeInTheDocument();
    expect(api.chat.apply).not.toHaveBeenCalled();
  });

  it('retries a failed saved turn with the same client message id', async () => {
    vi.mocked(api.chat.history).mockResolvedValue({ thread, messages: [userMessage, { ...assistantMessage, content: '', proposals: [], status: 'FAILED', error: '연결이 끊어졌습니다.' }] });
    renderPage();
    expect(await screen.findByText('연결이 끊어졌습니다.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '답변 다시 시도' }));
    await waitFor(() => expect(api.chat.send).toHaveBeenCalledWith('story', { content: userMessage.content, clientMessageId: 'turn-1' }, thread.id, expect.any(Function), expect.any(AbortSignal)));
    expect(await screen.findByText(assistantMessage.content)).toBeInTheDocument();
    expect(screen.getAllByText(userMessage.content)).toHaveLength(1);
  });

  it('retains a message and its retry identity when the request fails before history can be saved', async () => {
    vi.mocked(api.chat.send).mockRejectedValueOnce(new Error('네트워크 연결을 확인해 주세요.'));
    renderPage();
    fireEvent.change(await screen.findByRole('textbox'), { target: { value: '설정을 읽어 줘' } });
    fireEvent.click(screen.getByRole('button', { name: '보내기' }));
    expect(await screen.findByText('네트워크 연결을 확인해 주세요.')).toBeInTheDocument();
    expect(screen.getByText('설정을 읽어 줘')).toBeInTheDocument();
    const originalInput = vi.mocked(api.chat.send).mock.calls[0][1];
    fireEvent.click(screen.getByRole('button', { name: '전송 다시 시도' }));
    await waitFor(() => expect(api.chat.send).toHaveBeenNthCalledWith(2, 'story', originalInput, thread.id, expect.any(Function), expect.any(AbortSignal)));
  });

  it('shows deletion and arc archival effects before applying, and leaves stale proposals unapplied', async () => {
    const deletion: ChatProposal = { ...proposal, operation: 'DELETE', after: null, effects: [{
      label: '기존 활성 아크가 보관됩니다.', before: { title: '첫 번째 문', status: 'ACTIVE' }, after: { title: '첫 번째 문', status: 'ARCHIVED' },
    }] };
    vi.mocked(api.chat.history).mockResolvedValue({ thread, messages: [{ ...assistantMessage, proposals: [deletion] }] });
    vi.mocked(api.chat.apply).mockRejectedValue(new ApiError('stale', 409));
    renderPage();
    expect(await screen.findByText('적용하면 이 항목이 삭제됩니다.')).toBeInTheDocument();
    expect(screen.getByText('기존 활성 아크가 보관됩니다.')).toBeInTheDocument();
    expect(screen.getByText('보관됨')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '삭제 적용' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('대상 내용이 변경되어');
    expect(screen.queryByText('적용 완료')).not.toBeInTheDocument();
  });

  it('uses the selected project and does not submit Enter while composing Korean text', async () => {
    renderPage('another-story');
    const input = await screen.findByRole('textbox');
    expect(api.chat.history).toHaveBeenCalledWith('another-story', thread.id);
    fireEvent.change(input, { target: { value: '새로운 설정' } });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true, keyCode: 229 });
    expect(api.chat.send).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(api.chat.send).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '보내기' }));
    await waitFor(() => expect(api.chat.send).toHaveBeenCalledWith('another-story', expect.objectContaining({ content: '새로운 설정' }), thread.id, expect.any(Function), expect.any(AbortSignal)));
  });
});
