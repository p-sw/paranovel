import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { ChatEpisodeTask, ChatHistory, ChatMessage, ChatProposal, ChatThread, EditorAiMessage, Episode } from '@paranovel/contracts';
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
const episode: Episode = { id: 'episode-1', projectId: 'story', number: 1, title: '새로운 문', direction: '문을 열고 나아간다.',
  content: '그는 문을 열었다.', revision: 1, status: 'DRAFT', summary: null, createdAt: thread.createdAt, updatedAt: thread.updatedAt };
const editorMessage: EditorAiMessage = {
  id: 'editor-assistant-1', projectId: 'story', episodeId: episode.id, clientMessageId: 'editor-turn-1', role: 'assistant',
  content: '주인공의 망설임을 드러냈어요.', status: 'COMPLETE', request: null, error: null, createdAt: thread.createdAt,
  edit: { title: '망설임을 드러내는 문장', start: 0, end: episode.content.length, original: episode.content,
    replacement: '그는 망설이다 문고리를 움켜쥐었다.', baseRevision: 1, status: 'PENDING' },
};
const writeTask: ChatEpisodeTask = {
  id: 'task-1', projectId: 'story', messageId: assistantMessage.id, kind: 'WRITE', status: 'COMPLETE',
  episodeId: episode.id, title: episode.title, direction: episode.direction, content: episode.content,
  error: null, editorMessage: null, issues: [], blocked: false,
};
const editTask: ChatEpisodeTask = { ...writeTask, kind: 'EDIT', direction: null, content: '', editorMessage };

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
  vi.spyOn(api.episodes, 'get').mockResolvedValue(episode);
  vi.spyOn(api.editorAi, 'apply').mockResolvedValue({
    episode: { ...episode, content: editorMessage.edit!.replacement, revision: 2 },
    message: { ...editorMessage, edit: { ...editorMessage.edit!, status: 'APPLIED' } },
  });
});
afterEach(() => vi.restoreAllMocks());

describe('project AI chat', () => {
  it('keeps a live episode task through parent resets and history refreshes, then shows its saved manuscript and continuity issues once', async () => {
    let finish!: (history: ChatHistory) => void;
    let emit!: NonNullable<Parameters<typeof api.chat.send>[3]>;
    let turn!: Parameters<typeof api.chat.send>[1];
    vi.mocked(api.chat.send).mockImplementationOnce((_project, input, _thread, callback) => {
      turn = input;
      emit = callback!;
      return new Promise((resolve) => { finish = resolve; });
    });
    const { client } = renderPage();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    fireEvent.change(await screen.findByRole('textbox'), { target: { value: '다음 회차를 써 줘' } });
    fireEvent.click(screen.getByRole('button', { name: '보내기' }));
    await waitFor(() => expect(emit).toBeDefined());
    const live: ChatEpisodeTask = { ...writeTask, status: 'PENDING', content: '그는 문을', stage: 'WRITING' };
    act(() => {
      emit({ type: 'episode_task', task: live }, '');
      emit({ type: 'delta', text: '회차 집필을 시작했어요.' }, '');
      emit({ type: 'reset' }, '');
    });
    expect(screen.getByText('그는 문을')).toBeInTheDocument();
    expect(screen.queryByText('회차 집필을 시작했어요.')).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: '회차 집필: 새로운 문' })).toHaveTextContent('본문을 쓰고 있어요.');
    const pendingHistory: ChatHistory = { thread, messages: [
      { ...userMessage, content: turn.content, clientMessageId: turn.clientMessageId },
      { ...assistantMessage, content: '', status: 'PENDING', clientMessageId: turn.clientMessageId, proposals: [], episodeTasks: [{ ...live, content: '' }] },
    ] };
    act(() => client.setQueryData(['chat', 'story', thread.id], pendingHistory));
    expect(screen.getAllByRole('region', { name: '회차 집필: 새로운 문' })).toHaveLength(1);
    expect(screen.getByText('그는 문을')).toBeInTheDocument();
    const completed: ChatEpisodeTask = { ...writeTask, blocked: true, issues: [{
      category: 'CANON', severity: 'BLOCKING', explanation: '잠긴 문의 열쇠가 필요합니다.', excerpt: episode.content,
      repairInstruction: '열쇠를 얻는 장면을 추가하세요.', evidenceRefs: [],
    }] };
    act(() => emit({ type: 'episode_task', task: completed }, ''));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['episodes', 'story'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['projects'] });
    const complete: ChatHistory = { ...pendingHistory, messages: pendingHistory.messages.map((message) => message.role === 'assistant'
      ? { ...message, status: 'COMPLETE', content: '회차를 저장했어요.', episodeTasks: [completed] } : message) };
    await act(async () => finish(complete));
    const card = within(screen.getByRole('region', { name: '회차 집필: 새로운 문' }));
    expect(card.getByText('회차 저장됨')).toBeInTheDocument();
    expect(card.getByRole('alert')).toHaveTextContent('잠긴 문의 열쇠가 필요합니다.');
    expect(card.getByRole('link', { name: '에디터에서 열기' })).toHaveAttribute('href', '/projects/story/episodes/episode-1');
    expect(screen.getAllByRole('region', { name: '회차 집필: 새로운 문' })).toHaveLength(1);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('restores conversational direction results and failed episode work even when the parent response failed', async () => {
    vi.mocked(api.chat.history).mockResolvedValue({ thread, messages: [{ ...assistantMessage, content: '', proposals: [], status: 'FAILED', error: '최종 답변이 끊겼어요.', episodeTasks: [
      { ...writeTask, id: 'direction-task', kind: 'DIRECTION', episodeId: null, content: '문을 열 열쇠의 출처를 확인해 주세요.' },
      { ...writeTask, status: 'FAILED', content: '작성하다 남은 본문', error: '회차 생성을 완료하지 못했어요.' },
    ] }] });
    renderPage();
    const direction = within(await screen.findByRole('region', { name: '회차 구상: 새로운 문' }));
    expect(direction.getByText(episode.direction)).toBeInTheDocument();
    expect(direction.getByText(/대화로 방향을 더 다듬거나/)).toBeInTheDocument();
    expect(direction.getByText('구상 참고 사항')).toBeInTheDocument();
    expect(direction.getByText('문을 열 열쇠의 출처를 확인해 주세요.')).toBeInTheDocument();
    expect(direction.queryByText(/회차 본문/)).not.toBeInTheDocument();
    const failed = within(screen.getByRole('region', { name: '회차 집필: 새로운 문' }));
    expect(failed.getByRole('alert')).toHaveTextContent('회차 생성을 완료하지 못했어요.');
    expect(failed.getByText('작성하다 남은 본문')).toBeInTheDocument();
    expect(failed.getByRole('link', { name: '에디터에서 열기' })).toBeInTheDocument();
  });

  it.each(['FAILED', 'COMPLETE'] as const)('restores a %s task after the stream misses its terminal event and shows fresh progress on retry', async (status) => {
    let fail!: (error: Error) => void;
    let emit!: NonNullable<Parameters<typeof api.chat.send>[3]>;
    let turn!: Parameters<typeof api.chat.send>[1];
    vi.mocked(api.chat.send).mockImplementation((_project, input, _thread, callback) => {
      turn = input;
      emit = callback!;
      return new Promise((_resolve, reject) => { fail = reject; });
    });
    const { unmount } = renderPage();
    fireEvent.change(await screen.findByRole('textbox'), { target: { value: '다음 회차를 써 줘' } });
    fireEvent.click(screen.getByRole('button', { name: '보내기' }));
    await waitFor(() => expect(emit).toBeDefined());
    const live: ChatEpisodeTask = { ...writeTask, status: 'PENDING', content: '작성 중인 본문', stage: 'WRITING' };
    act(() => emit({ type: 'episode_task', task: live }, ''));
    const restored: ChatEpisodeTask = { ...writeTask, status, content: '서버에 보존된 본문',
      error: status === 'FAILED' ? '회차 작업이 중단되었습니다.' : null };
    vi.mocked(api.chat.history).mockResolvedValue({ thread, messages: [
      { ...userMessage, content: turn.content, clientMessageId: turn.clientMessageId },
      { ...assistantMessage, content: '', status: 'FAILED', clientMessageId: turn.clientMessageId, proposals: [], episodeTasks: [restored] },
    ] });
    await act(async () => fail(new Error('최종 답변의 연결이 끊겼어요.')));
    const card = within(await screen.findByRole('region', { name: '회차 집필: 새로운 문' }));
    expect(await card.findByText('서버에 보존된 본문')).toBeInTheDocument();
    expect(card.queryByRole('status')).not.toBeInTheDocument();
    expect(card.getByText(status === 'FAILED' ? '작업 실패' : '회차 저장됨')).toBeInTheDocument();
    if (status === 'FAILED') {
      expect(card.getByRole('alert')).toHaveTextContent('회차 작업이 중단되었습니다.');
      fireEvent.click(screen.getByRole('button', { name: '답변 다시 시도' }));
      await waitFor(() => expect(api.chat.send).toHaveBeenCalledTimes(2));
      act(() => emit({ type: 'episode_task', task: { ...live, content: '다시 작성하는 본문' } }, ''));
      expect(card.getByRole('status')).toHaveTextContent('본문을 쓰고 있어요.');
      expect(card.getByText('다시 작성하는 본문')).toBeInTheDocument();
      expect(card.queryByRole('alert')).not.toBeInTheDocument();
    }
    unmount();
  });

  it('reuses the editor preview and applies a chat edit through editor AI only after acceptance, preserving the result against an older history read', async () => {
    let finishHistory!: (history: ChatHistory) => void;
    vi.mocked(api.chat.history).mockImplementation(() => new Promise((resolve) => { finishHistory = resolve; }));
    const oldHistory: ChatHistory = { thread, messages: [{ ...assistantMessage, proposals: [], episodeTasks: [editTask] }] };
    const { client } = renderPage('story', oldHistory);
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const card = within(screen.getByRole('region', { name: '회차 편집: 새로운 문' }));
    expect(card.getByRole('region', { name: '수정 전' })).toHaveTextContent(episode.content);
    expect(card.getByRole('region', { name: '수정 후' })).toHaveTextContent(editorMessage.edit!.replacement);
    expect(api.editorAi.apply).not.toHaveBeenCalled();
    fireEvent.click(card.getByRole('button', { name: '수락하고 적용' }));
    expect(await card.findByText('적용됨')).toBeInTheDocument();
    expect(api.editorAi.apply).toHaveBeenCalledExactlyOnceWith('story', episode.id, editorMessage.id);
    expect(api.chat.apply).not.toHaveBeenCalled();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['episodes', 'story'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['episode-order', 'story'] });
    await act(async () => finishHistory(oldHistory));
    expect(card.getByText('적용됨')).toBeInTheDocument();
    expect(card.queryByRole('button', { name: '수락하고 적용' })).not.toBeInTheDocument();
  });

  it('disables a restored edit when the episode revision has changed', async () => {
    vi.mocked(api.episodes.get).mockResolvedValue({ ...episode, revision: 2 });
    vi.mocked(api.chat.history).mockResolvedValue({ thread, messages: [{ ...assistantMessage, proposals: [], episodeTasks: [editTask] }] });
    renderPage();
    expect(await screen.findByText('원고가 변경되어 적용할 수 없어요. 현재 원고를 기준으로 다시 요청해 주세요.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '수락하고 적용' })).toBeDisabled();
    expect(api.editorAi.apply).not.toHaveBeenCalled();
  });

  it('preserves a completed subagent edit and its applied state when the parent stream fails before history is restored', async () => {
    let fail!: (error: Error) => void;
    let emit!: NonNullable<Parameters<typeof api.chat.send>[3]>;
    vi.mocked(api.chat.send).mockImplementationOnce((_project, _input, _thread, callback) => {
      emit = callback!;
      return new Promise((_resolve, reject) => { fail = reject; });
    });
    renderPage();
    fireEvent.change(await screen.findByRole('textbox'), { target: { value: '첫 회차를 다듬어 줘' } });
    fireEvent.click(screen.getByRole('button', { name: '보내기' }));
    await waitFor(() => expect(emit).toBeDefined());
    act(() => emit({ type: 'episode_task', task: editTask }, ''));
    expect(screen.getByRole('button', { name: '수락하고 적용' })).toBeDisabled();
    await act(async () => fail(new Error('최종 답변의 연결이 끊겼어요.')));
    expect(screen.getByText('최종 답변의 연결이 끊겼어요.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '수락하고 적용' }));
    expect(await screen.findByText('수정 적용됨')).toBeInTheDocument();
    expect(screen.getByText('적용됨')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '수락하고 적용' })).not.toBeInTheDocument();
    expect(api.editorAi.apply).toHaveBeenCalledExactlyOnceWith('story', episode.id, editorMessage.id);
  });

  it('leaves an edit unapplied and explains a revision conflict reported during acceptance', async () => {
    vi.mocked(api.chat.history).mockResolvedValue({ thread, messages: [{ ...assistantMessage, proposals: [], episodeTasks: [editTask] }] });
    vi.mocked(api.editorAi.apply).mockRejectedValue(new ApiError('stale', 409));
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: '수락하고 적용' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('채팅에서 현재 원고를 기준으로 다시 수정해 달라고 요청해 주세요.');
    expect(screen.queryByText('적용됨')).not.toBeInTheDocument();
  });

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
