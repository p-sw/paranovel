import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { ChatHistory, ChatMessage, ChatProposal } from '@paranovel/contracts';
import { api, ApiError } from '../api/client';
import ChatPage from './ChatPage';

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
  if (cachedHistory) client.setQueryData(['chat', projectId], cachedHistory);
  const view = render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[`/projects/${projectId}/chat`]}>
    <Routes><Route path="/projects/:projectId/chat" element={<ChatPage />} /></Routes>
  </MemoryRouter></QueryClientProvider>);
  return { ...view, client };
}

beforeEach(() => {
  vi.spyOn(api.chat, 'history').mockResolvedValue({ messages: [] });
  vi.spyOn(api.chat, 'send').mockResolvedValue({ messages: [userMessage, assistantMessage] });
  vi.spyOn(api.chat, 'apply').mockResolvedValue({ proposal: { ...proposal, status: 'APPLIED', appliedAt: '2026-09-06T01:00:00.000Z' } });
});
afterEach(() => vi.restoreAllMocks());

describe('project AI chat', () => {
  it.each([['CHARACTER', '인물'], ['CHARACTER_APPEARANCE', '인물 외형']])('shows the %s label and exact free-text metadata in the proposal review', async (category, label) => {
    vi.mocked(api.chat.history).mockResolvedValue({ messages: [{ ...assistantMessage, proposals: [{
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
    renderPage('story', { messages: [] });
    fireEvent.change(screen.getByRole('textbox'), { target: { value: userMessage.content } });
    fireEvent.click(screen.getByRole('button', { name: '보내기' }));
    expect(await screen.findByText(assistantMessage.content)).toBeInTheDocument();
    await act(async () => finishHistory({ messages: [] }));
    expect(screen.getByText(assistantMessage.content)).toBeInTheDocument();
  });

  it('keeps the applied state when an older background history read finishes late', async () => {
    let finishHistory!: (history: ChatHistory) => void;
    vi.mocked(api.chat.history).mockImplementation(() => new Promise((resolve) => { finishHistory = resolve; }));
    const oldHistory = { messages: [userMessage, assistantMessage] };
    renderPage('story', oldHistory);
    fireEvent.click(screen.getByRole('button', { name: '변경안 적용' }));
    expect(await screen.findByText('적용 완료')).toBeInTheDocument();
    await act(async () => finishHistory(oldHistory));
    expect(screen.getByText('적용 완료')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '변경안 적용' })).not.toBeInTheDocument();
  });

  it('restores history and applies a reviewable proposal only after clicking its apply button', async () => {
    vi.mocked(api.chat.history).mockResolvedValue({ messages: [userMessage, assistantMessage] });
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
    expect(api.chat.send).toHaveBeenCalledWith('story', { content: '능력에 대가를 추가해 줘', clientMessageId: expect.any(String) });
    expect(screen.getByRole('button', { name: '보내기' })).toBeDisabled();
    fireEvent.change(input, { target: { value: '다음 질문을 미리 작성' } });
    await act(async () => resolve({ messages: [userMessage, assistantMessage] }));
    expect(input).toHaveValue('다음 질문을 미리 작성');
    expect(await screen.findByText(assistantMessage.content)).toBeInTheDocument();
    expect(api.chat.apply).not.toHaveBeenCalled();
  });

  it('retries a failed saved turn with the same client message id', async () => {
    vi.mocked(api.chat.history).mockResolvedValue({ messages: [userMessage, { ...assistantMessage, content: '', proposals: [], status: 'FAILED', error: '연결이 끊어졌습니다.' }] });
    renderPage();
    expect(await screen.findByText('연결이 끊어졌습니다.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '답변 다시 시도' }));
    await waitFor(() => expect(api.chat.send).toHaveBeenCalledWith('story', { content: userMessage.content, clientMessageId: 'turn-1' }));
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
    await waitFor(() => expect(api.chat.send).toHaveBeenNthCalledWith(2, 'story', originalInput));
  });

  it('shows deletion and arc archival effects before applying, and leaves stale proposals unapplied', async () => {
    const deletion: ChatProposal = { ...proposal, operation: 'DELETE', after: null, effects: [{
      label: '기존 활성 아크가 보관됩니다.', before: { title: '첫 번째 문', status: 'ACTIVE' }, after: { title: '첫 번째 문', status: 'ARCHIVED' },
    }] };
    vi.mocked(api.chat.history).mockResolvedValue({ messages: [{ ...assistantMessage, proposals: [deletion] }] });
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
    expect(api.chat.history).toHaveBeenCalledWith('another-story');
    fireEvent.change(input, { target: { value: '새로운 설정' } });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true, keyCode: 229 });
    expect(api.chat.send).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(api.chat.send).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '보내기' }));
    await waitFor(() => expect(api.chat.send).toHaveBeenCalledWith('another-story', expect.objectContaining({ content: '새로운 설정' })));
  });
});
