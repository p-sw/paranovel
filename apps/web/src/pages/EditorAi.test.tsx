import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { EditorAiHistory, EditorAiInput, Episode } from '@paranovel/contracts';
import { api, ApiError } from '../api/client';
import { characterCount } from '../lib';
import EpisodeEditorPage from './EpisodeEditorPage';

const source = '앞 문장.\n하린은 😀 숨을 삼켰다.\n뒤 문장.';
const selected = '하린은 😀 숨을 삼켰다.';
const replacement = '하린의 손끝이 차갑게 굳었다.';
const initial: Episode = { id: 'episode', projectId: 'story', number: 1, title: '닫힌 문', direction: '문을 연다.',
  content: source, revision: 1, status: 'DRAFT', summary: null, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z' };
let saved: Episode;
let history: EditorAiHistory;

function reply(request: EditorAiInput): EditorAiHistory {
  return { messages: [...history.messages, {
    id: `user-${request.clientMessageId}`, projectId: 'story', episodeId: 'episode', clientMessageId: request.clientMessageId,
    role: 'user', content: request.content, status: 'COMPLETE', request, edit: null, error: null, createdAt: initial.createdAt,
  }, {
    id: `assistant-${request.clientMessageId}`, projectId: 'story', episodeId: 'episode', clientMessageId: request.clientMessageId,
    role: 'assistant', content: '인물의 반응을 구체적으로 다듬었어요.', status: 'COMPLETE', request: null,
    edit: { title: '긴장감을 높인 문장', start: request.selection.start, end: request.selection.end,
      original: request.selection.text, replacement, baseRevision: request.expectedRevision, status: 'PENDING' },
    error: null, createdAt: initial.createdAt,
  }] };
}

beforeEach(() => {
  localStorage.clear();
  saved = { ...initial };
  history = { messages: [] };
  vi.spyOn(api.episodes, 'get').mockImplementation(async () => saved);
  vi.spyOn(api.episodes, 'list').mockImplementation(async () => [saved]);
  vi.spyOn(api.episodes, 'update').mockImplementation(async (_project, _episode, input) => {
    saved = { ...saved, ...input, revision: saved.revision + 1 };
    return saved;
  });
  vi.spyOn(api.scenes, 'get').mockResolvedValue({ episodeId: 'episode', characters: [], location: null, time: null, pointOfView: null, goal: null, sourceRevision: 1 });
  vi.spyOn(api.editorAi, 'history').mockImplementation(async () => history);
  vi.spyOn(api.editorAi, 'send').mockImplementation(async (_project, _episode, request) => {
    history = reply(request);
    return history;
  });
  vi.spyOn(api.editorAi, 'apply').mockImplementation(async (_project, _episode, messageId) => {
    const message = history.messages.find((item) => item.id === messageId)!;
    const edit = message.edit!;
    const applied = { ...message, edit: { ...edit, status: 'APPLIED' as const } };
    saved = { ...saved, content: saved.content.slice(0, edit.start) + edit.replacement + saved.content.slice(edit.end), revision: saved.revision + 1 };
    history = { messages: history.messages.map((item) => item.id === messageId ? applied : item) };
    return { episode: saved, message: applied };
  });
  vi.spyOn(api.chat, 'send');
});

afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); });

async function openEditor(openPanel = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const view = render(<QueryClientProvider client={client}><MemoryRouter initialEntries={['/projects/story/episodes/episode']}>
    <Routes><Route path="/projects/:projectId/episodes/:episodeId" element={<EpisodeEditorPage />} /></Routes>
  </MemoryRouter></QueryClientProvider>);
  const editor = await screen.findByRole('textbox', { name: '회차 본문' }) as HTMLTextAreaElement;
  if (openPanel) {
    fireEvent.click(screen.getByRole('button', { name: '편집 AI' }));
    await screen.findByRole('heading', { name: '이 문장부터, 함께 써요' });
  }
  return { ...view, client, editor };
}

function select(editor: HTMLTextAreaElement, text = selected) {
  const start = editor.value.indexOf(text);
  editor.focus();
  editor.setSelectionRange(start, start + text.length);
  fireEvent.select(editor);
}

async function ask(content = '긴장감을 높여줘') {
  const input = screen.getByRole('textbox', { name: '편집 AI에게 보낼 메시지' });
  input.focus();
  fireEvent.change(input, { target: { value: content } });
  fireEvent.click(screen.getByRole('button', { name: '편집 AI에 보내기' }));
  await screen.findByRole('heading', { name: '긴장감을 높인 문장' });
}

describe('editing conversation in the episode workspace', () => {
  it('keeps a passage attached and highlighted when focus moves and the browser collapses its native selection', async () => {
    const { editor, container } = await openEditor();
    select(editor);
    const input = screen.getByRole('textbox', { name: '편집 AI에게 보낼 메시지' });
    input.focus();
    editor.setSelectionRange(source.length, source.length);
    fireEvent.keyUp(editor, { key: 'Tab' });
    expect(input).toHaveFocus();
    expect(screen.getByLabelText('편집 AI에 고정한 원문')).toHaveTextContent(selected);
    expect(container.querySelector('.story-editor-highlight mark')).toHaveTextContent(selected);
    await ask();
    expect(vi.mocked(api.editorAi.send).mock.calls[0]![2].selection).toEqual({
      start: source.indexOf(selected), end: source.indexOf(selected) + selected.length, text: selected,
    });
    expect(screen.getByRole('button', { name: '선택한 부분에 적용' })).toBeEnabled();
  });

  it('attaches a passage selected before opening the AI panel and preserves it through auto-focus', async () => {
    const { editor, container } = await openEditor(false);
    select(editor);
    fireEvent.click(screen.getByRole('button', { name: '편집 AI' }));
    await screen.findByRole('heading', { name: '이 문장부터, 함께 써요' });
    expect(screen.getByRole('textbox', { name: '편집 AI에게 보낼 메시지' })).toHaveFocus();
    expect(screen.getByLabelText('편집 AI에 고정한 원문')).toHaveTextContent(selected);
    expect(container.querySelector('.story-editor-highlight mark')).toHaveTextContent(selected);
    await ask();
    expect(vi.mocked(api.editorAi.send).mock.calls[0]![2].selection.text).toBe(selected);
  });

  it('changes the attached passage only when a new passage is selected or it is explicitly cleared', async () => {
    const { editor, container } = await openEditor();
    select(editor);
    editor.setSelectionRange(0, 0);
    fireEvent.select(editor);
    expect(screen.getByLabelText('편집 AI에 고정한 원문')).toHaveTextContent(selected);
    select(editor, '뒤 문장.');
    expect(screen.getByLabelText('편집 AI에 고정한 원문')).toHaveTextContent('뒤 문장.');
    expect(container.querySelector('.story-editor-highlight mark')).toHaveTextContent('뒤 문장.');
    fireEvent.click(screen.getByRole('button', { name: '편집 AI 선택 해제' }));
    expect(screen.queryByLabelText('편집 AI에 고정한 원문')).not.toBeInTheDocument();
    expect(container.querySelector('.story-editor-highlight')).toBeNull();
    expect(screen.getByText('원고 끝에서 이어쓰기')).toBeInTheDocument();
    await ask();
    expect(vi.mocked(api.editorAi.send).mock.calls[0]![2].selection.text).toBe('');
  });

  it('requires a fresh attachment when the author changes the manuscript underneath a pinned passage', async () => {
    const { editor, container } = await openEditor();
    select(editor);
    fireEvent.change(editor, { target: { value: `새 문장.\n${source}` } });
    expect(container.querySelector('.story-editor-highlight')).toBeNull();
    expect(screen.getByRole('alert')).toHaveTextContent('원고가 바뀌었어요.');
    const input = screen.getByRole('textbox', { name: '편집 AI에게 보낼 메시지' });
    fireEvent.change(input, { target: { value: '긴장감을 높여줘' } });
    expect(screen.getByRole('button', { name: '편집 AI에 보내기' })).toBeDisabled();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(api.editorAi.send).not.toHaveBeenCalled();
    select(editor);
    await ask();
    expect(vi.mocked(api.editorAi.send).mock.calls[0]![2]).toMatchObject({ expectedRevision: 2,
      selection: { start: editor.value.indexOf(selected), end: editor.value.indexOf(selected) + selected.length, text: selected } });
  });

  it('sends the exact selection through the separate editor API, applies it, and continues with the replacement selected', async () => {
    const { editor } = await openEditor();
    select(editor);
    expect(screen.getByText(`선택한 부분 · ${characterCount(selected)}자`)).toBeInTheDocument();
    await ask();
    const firstRequest = vi.mocked(api.editorAi.send).mock.calls[0]![2];
    expect(firstRequest).toMatchObject({ content: '긴장감을 높여줘', expectedRevision: 1,
      selection: { start: source.indexOf(selected), end: source.indexOf(selected) + selected.length, text: selected } });
    expect(api.chat.send).not.toHaveBeenCalled();
    expect(editor).toHaveValue(source);
    expect(api.editorAi.apply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '선택한 부분에 적용' }));
    await waitFor(() => expect(editor).toHaveValue(source.replace(selected, replacement)));
    expect(await screen.findByText('적용됨')).toBeInTheDocument();
    expect(screen.getByText(`선택한 부분 · ${characterCount(replacement)}자`)).toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox', { name: '편집 AI에게 보낼 메시지' }), { target: { value: '좀 더 짧게' } });
    fireEvent.click(screen.getByRole('button', { name: '편집 AI에 보내기' }));
    await waitFor(() => expect(api.editorAi.send).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.editorAi.send).mock.calls[1]![2]).toMatchObject({ content: '좀 더 짧게', expectedRevision: 2, selection: { text: replacement } });
  });

  it('saves local writing before sending it and defaults to an insertion at the end without a selection', async () => {
    const { editor } = await openEditor();
    fireEvent.change(editor, { target: { value: `${source}\n새로 쓴 문장.` } });
    await ask('다음 장면을 써줘');
    expect(api.episodes.update).toHaveBeenCalled();
    expect(vi.mocked(api.editorAi.send).mock.calls[0]![2]).toMatchObject({ expectedRevision: 2,
      selection: { start: saved.content.length, end: saved.content.length, text: '' } });
    expect(screen.getByRole('button', { name: '원고에 삽입' })).toBeEnabled();
  });

  it('retains the conversation and input draft when the panel is closed and reopened', async () => {
    await openEditor();
    await ask();
    fireEvent.change(screen.getByRole('textbox', { name: '편집 AI에게 보낼 메시지' }), { target: { value: '아직 보내지 않은 요청' } });
    fireEvent.click(screen.getByRole('button', { name: '편집 AI 닫기' }));
    expect(screen.queryByRole('log')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '편집 AI' }));
    expect(screen.getByRole('textbox', { name: '편집 AI에게 보낼 메시지' })).toHaveValue('아직 보내지 않은 요청');
    expect(screen.getByRole('heading', { name: '긴장감을 높인 문장' })).toBeInTheDocument();
  });

  it('disables outdated edits as soon as the author changes the manuscript', async () => {
    const { editor } = await openEditor();
    select(editor);
    await ask();
    fireEvent.change(editor, { target: { value: `직접 고친 문장.\n${source}` } });
    expect(screen.getByRole('button', { name: '선택한 부분에 적용' })).toBeDisabled();
    expect(screen.getByText(/원고가 변경되어 적용할 수 없어요/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '선택한 부분에 적용' }));
    expect(api.editorAi.apply).not.toHaveBeenCalled();
    expect(editor).toHaveValue(`직접 고친 문장.\n${source}`);
  });

  it('preserves the local manuscript and shows a conflict from another editor during application', async () => {
    vi.mocked(api.editorAi.apply).mockRejectedValueOnce(new ApiError('원고가 변경되었습니다. 다시 선택해 주세요.', 409));
    const { editor } = await openEditor();
    select(editor);
    await ask();
    fireEvent.click(screen.getByRole('button', { name: '선택한 부분에 적용' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('원고가 변경되었습니다.');
    expect(editor).toHaveValue(source);
    expect(editor).toBeEnabled();
  });

  it('preserves an unsent request for retries and prevents duplicate sends while responding', async () => {
    let fail!: (reason: Error) => void;
    vi.mocked(api.editorAi.send).mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
    const { editor } = await openEditor();
    select(editor);
    const input = screen.getByRole('textbox', { name: '편집 AI에게 보낼 메시지' });
    fireEvent.change(input, { target: { value: '반응을 다듬어줘' } });
    const button = screen.getByRole('button', { name: '편집 AI에 보내기' });
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(fail).toBeDefined());
    expect(api.editorAi.send).toHaveBeenCalledTimes(1);
    const request = vi.mocked(api.editorAi.send).mock.calls[0]![2];
    fireEvent.change(input, { target: { value: '그 다음 요청의 초안' } });
    await act(async () => fail(new Error('연결이 끊겼어요.')));
    expect(await screen.findByRole('alert')).toHaveTextContent('연결이 끊겼어요.');
    expect(input).toHaveValue('그 다음 요청의 초안');
    fireEvent.click(screen.getByRole('button', { name: '전송 다시 시도' }));
    await screen.findByRole('heading', { name: '긴장감을 높인 문장' });
    expect(api.editorAi.send).toHaveBeenLastCalledWith('story', 'episode', request);
    expect(input).toHaveValue('그 다음 요청의 초안');
  });

  it('keeps Korean composition and Shift+Enter from sending, while plain Enter sends', async () => {
    await openEditor();
    const input = screen.getByRole('textbox', { name: '편집 AI에게 보낼 메시지' });
    fireEvent.change(input, { target: { value: '다음 장면을 써줘' } });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(api.editorAi.send).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(api.editorAi.send).toHaveBeenCalledTimes(1));
  });

  it('clears the attached selection without submitting the message draft', async () => {
    const { editor } = await openEditor();
    select(editor);
    const input = screen.getByRole('textbox', { name: '편집 AI에게 보낼 메시지' });
    fireEvent.change(input, { target: { value: '다음 장면을 써줘' } });
    fireEvent.click(screen.getByRole('button', { name: '편집 AI 선택 해제' }));
    expect(api.editorAi.send).not.toHaveBeenCalled();
    expect(input).toHaveValue('다음 장면을 써줘');
    expect(screen.getByText('원고 끝에서 이어쓰기')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '편집 AI에 보내기' }));
    await waitFor(() => expect(api.editorAi.send).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.editorAi.send).mock.calls[0]![2].selection).toEqual({ start: source.length, end: source.length, text: '' });
  });

  it('never displays a late reply or selection from a different episode after navigation', async () => {
    const second = { ...initial, id: 'second', number: 2, title: '두 번째 문', content: '두 번째 회차 본문.' };
    vi.mocked(api.episodes.list).mockResolvedValue([initial, second]);
    vi.mocked(api.episodes.get).mockImplementation(async (_project, id) => id === second.id ? second : saved);
    vi.mocked(api.editorAi.history).mockImplementation(async (_project, id) => id === second.id ? { messages: [] } : history);
    let finish!: (value: EditorAiHistory) => void;
    vi.mocked(api.editorAi.send).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const { editor } = await openEditor();
    select(editor);
    fireEvent.change(screen.getByRole('textbox', { name: '편집 AI에게 보낼 메시지' }), { target: { value: '느린 요청' } });
    fireEvent.click(screen.getByRole('button', { name: '편집 AI에 보내기' }));
    await waitFor(() => expect(finish).toBeDefined());
    const request = vi.mocked(api.editorAi.send).mock.calls[0]![2];
    fireEvent.click(screen.getByRole('button', { name: '다음 회차' }));
    await waitFor(() => expect(screen.getByRole('textbox', { name: '회차 제목' })).toHaveValue(second.title));
    fireEvent.click(screen.getByRole('button', { name: '편집 AI' }));
    await screen.findByRole('heading', { name: '이 문장부터, 함께 써요' });
    await act(async () => finish(reply(request)));
    expect(screen.getByRole('textbox', { name: '회차 본문' })).toHaveValue(second.content);
    expect(within(screen.getByRole('log')).queryByText('느린 요청')).not.toBeInTheDocument();
    expect(screen.getByText('원고 끝에서 이어쓰기')).toBeInTheDocument();
  });
});
