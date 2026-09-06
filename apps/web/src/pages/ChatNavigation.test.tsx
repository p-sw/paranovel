import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import type { ChatHistory, ChatThread, ChatThreadSummary } from '@paranovel/contracts';
import { api } from '../api/client';
import ChatHistoryPage from './ChatHistoryPage';
import ChatIndexPage from './ChatIndexPage';
import ChatPage from './ChatPage';

const first: ChatThread = { id: 'first-room', projectId: 'story', title: '도시 설정 정리', createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T01:00:00.000Z' };
const second: ChatThread = { ...first, id: 'second-room', title: '다음 아크 구상', updatedAt: '2026-09-02T00:00:00.000Z' };
const newThread: ChatThread = { ...first, id: 'new-room', title: '새 채팅' };
const firstHistory: ChatHistory = { thread: first, messages: [
  { id: 'user', projectId: 'story', clientMessageId: 'first-turn', role: 'user', content: '도시의 비밀을 정리해 줘', status: 'COMPLETE', createdAt: first.createdAt, proposals: [] },
  { id: 'assistant', projectId: 'story', clientMessageId: 'first-turn', role: 'assistant', content: '도시 지하에 숨겨진 문이 있습니다.', status: 'COMPLETE', createdAt: first.createdAt, proposals: [] },
] };
const summaries: ChatThreadSummary[] = [
  { ...second, preview: '추적자를 만나는 장면', messageCount: 4, status: 'PENDING' },
  { ...first, preview: firstHistory.messages[1].content, messageCount: 2, status: 'COMPLETE' },
];

function Location() {
  return <output aria-label="현재 경로">{useLocation().pathname}</output>;
}

function renderPage(path = '/projects/story/chat/first-room') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const view = render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[path]}>
    <Routes>
      <Route path="/projects/:projectId/chat" element={<ChatIndexPage />} />
      <Route path="/projects/:projectId/chat/history" element={<ChatHistoryPage />} />
      <Route path="/projects/:projectId/chat/:threadId" element={<ChatPage />} />
    </Routes>
    <Location />
  </MemoryRouter></QueryClientProvider>);
  return { ...view, client };
}

beforeEach(() => {
  vi.spyOn(api.chat, 'threads').mockResolvedValue(summaries);
  vi.spyOn(api.chat, 'createThread').mockResolvedValue(newThread);
  vi.spyOn(api.chat, 'history').mockImplementation(async (_projectId, threadId) => {
    if (threadId === first.id) return firstHistory;
    return { thread: threadId === second.id ? second : newThread, messages: [] };
  });
  vi.spyOn(api.chat, 'send').mockResolvedValue(firstHistory);
});
afterEach(() => vi.restoreAllMocks());

describe('chat rooms and history navigation', () => {
  it('opens the most recently active room from AI chat and restores directly linked rooms', async () => {
    const view = renderPage('/projects/story/chat');
    expect(await screen.findByRole('textbox')).toBeInTheDocument();
    expect(screen.getByLabelText('현재 경로')).toHaveTextContent('/chat/second-room');
    expect(api.chat.history).toHaveBeenCalledWith('story', second.id);
    view.unmount();
    renderPage('/projects/story/chat/first-room');
    expect(await screen.findByText(firstHistory.messages[1].content)).toBeInTheDocument();
    expect(api.chat.history).toHaveBeenLastCalledWith('story', first.id);
  });

  it('lists room previews and opens a saved conversation that can be continued in the same room', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('link', { name: '채팅 기록' }));
    expect(await screen.findByRole('heading', { name: '채팅 기록' })).toBeInTheDocument();
    const list = within(await screen.findByRole('list', { name: '이전 채팅방' }));
    expect(list.getAllByRole('link')[0]).toHaveTextContent(second.title);
    expect(list.getByText('답변 중')).toBeInTheDocument();
    expect(list.getByText('메시지 2개')).toBeInTheDocument();
    expect(list.getByText(firstHistory.messages[1].content)).toBeInTheDocument();
    fireEvent.click(list.getByRole('link', { name: /도시 설정 정리/ }));
    const log = within(await screen.findByRole('log'));
    expect(log.getByText(firstHistory.messages[1].content)).toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '문의 기원을 설명해 줘' } });
    fireEvent.click(screen.getByRole('button', { name: '보내기' }));
    await waitFor(() => expect(api.chat.send).toHaveBeenCalledWith('story', expect.objectContaining({ content: '문의 기원을 설명해 줘' }), first.id));
  });

  it('opens a fresh room without showing the previous draft or a late response from the previous room', async () => {
    let finish!: (history: ChatHistory) => void;
    vi.mocked(api.chat.send).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const { client } = renderPage();
    fireEvent.change(await screen.findByRole('textbox'), { target: { value: '오래 걸리는 질문' } });
    fireEvent.click(screen.getByRole('button', { name: '보내기' }));
    await waitFor(() => expect(finish).toBeDefined());
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '이전 방의 입력 초안' } });
    fireEvent.click(screen.getByRole('button', { name: '새 채팅' }));
    expect(await screen.findByRole('heading', { name: '어떤 이야기를 함께 풀어 볼까요?' })).toBeInTheDocument();
    expect(screen.getByLabelText('현재 경로')).toHaveTextContent('/chat/new-room');
    expect(screen.getByRole('textbox')).toHaveValue('');
    expect(screen.queryByText(firstHistory.messages[1].content)).not.toBeInTheDocument();
    const completed = { ...firstHistory, messages: [...firstHistory.messages, { ...firstHistory.messages[1], id: 'late-answer', content: '이전 방의 늦은 답변' }] };
    await act(async () => finish(completed));
    expect(screen.queryByText('이전 방의 늦은 답변')).not.toBeInTheDocument();
    expect(client.getQueryData(['chat', 'story', first.id])).toEqual(completed);
    expect(screen.getByRole('textbox')).toHaveValue('');
  });

  it('prevents duplicate room creation and retains the current room when creation fails', async () => {
    let fail!: (reason: Error) => void;
    vi.mocked(api.chat.createThread).mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
    renderPage();
    expect(await screen.findByText(firstHistory.messages[1].content)).toBeInTheDocument();
    const button = screen.getByRole('button', { name: '새 채팅' });
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(api.chat.createThread).toHaveBeenCalledTimes(1));
    expect(button).toBeDisabled();
    const requestId = vi.mocked(api.chat.createThread).mock.calls[0][1];
    await act(async () => fail(new Error('채팅방을 만들지 못했습니다.')));
    expect(await screen.findByRole('alert')).toHaveTextContent('채팅방을 만들지 못했습니다.');
    expect(screen.getByText(firstHistory.messages[1].content)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '새 채팅' }));
    await waitFor(() => expect(api.chat.createThread).toHaveBeenNthCalledWith(2, 'story', requestId));
    expect(await screen.findByRole('heading', { name: '어떤 이야기를 함께 풀어 볼까요?' })).toBeInTheDocument();
  });

  it('shows empty history and creates the first chat from it', async () => {
    vi.mocked(api.chat.threads).mockResolvedValue([]);
    renderPage('/projects/story/chat/history');
    expect(await screen.findByRole('heading', { name: '아직 채팅 기록이 없어요' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '새 채팅' }));
    expect(await screen.findByRole('textbox')).toBeInTheDocument();
    expect(screen.getByLabelText('현재 경로')).toHaveTextContent('/chat/new-room');
    expect(api.chat.createThread).toHaveBeenCalledWith('story', expect.any(String));
  });

  it('offers new chat and history for a project without any saved rooms', async () => {
    vi.mocked(api.chat.threads).mockResolvedValue([]);
    renderPage('/projects/fresh-project/chat');
    expect(await screen.findByRole('heading', { name: '어떤 이야기를 함께 풀어 볼까요?' })).toBeInTheDocument();
    expect(api.chat.threads).toHaveBeenCalledWith('fresh-project');
    expect(screen.getByRole('button', { name: '새 채팅' })).toBeEnabled();
    expect(screen.getByRole('link', { name: '채팅 기록' })).toHaveAttribute('href', '/projects/fresh-project/chat/history');
    expect(api.chat.createThread).not.toHaveBeenCalled();
  });

  it('keeps a failed history load retryable and keeps navigation available for a missing room', async () => {
    vi.mocked(api.chat.threads).mockRejectedValueOnce(new Error('기록을 불러오지 못했습니다.'));
    const view = renderPage('/projects/story/chat/history');
    expect(await screen.findByRole('alert')).toHaveTextContent('기록을 불러오지 못했습니다.');
    fireEvent.click(screen.getByRole('button', { name: '다시 시도' }));
    expect(await screen.findByRole('list', { name: '이전 채팅방' })).toBeInTheDocument();
    view.unmount();
    vi.mocked(api.chat.history).mockRejectedValueOnce(new Error('채팅방을 찾을 수 없습니다.'));
    renderPage('/projects/story/chat/missing-room');
    expect(await screen.findByRole('alert')).toHaveTextContent('채팅방을 찾을 수 없습니다.');
    expect(screen.getByRole('link', { name: '채팅 기록' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '새 채팅' })).toBeEnabled();
  });
});
