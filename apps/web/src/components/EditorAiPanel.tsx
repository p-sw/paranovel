import { useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, Check, PencilLine, RotateCcw, Send, Sparkles, TextSelect, X } from 'lucide-react';
import type { EditorAiEdit, EditorAiInput } from '@paranovel/contracts';
import { api, messageOf } from '../api/client';
import { characterCount, createIdempotencyKey } from '../lib';
import type { SelectionSnapshot } from '../types';
import { Button, ErrorState, IconButton, Spinner } from './Ui';
import { ConversationReply } from './ConversationReply';
import { useConversationStream } from '../useConversationStream';

type Turn = { content: string; clientMessageId: string; request?: EditorAiInput };

interface Props {
  projectId: string;
  episodeId: string;
  open: boolean;
  disabled: boolean;
  dirty: boolean;
  selection: SelectionSnapshot | null;
  content: string;
  revision: number;
  onClose: () => void;
  onClearSelection: () => void;
  prepareRequest: (content: string, clientMessageId: string) => Promise<EditorAiInput>;
  onApply: (messageId: string, edit: EditorAiEdit) => Promise<void>;
}

export default function EditorAiPanel({ projectId, episodeId, open, disabled, dirty, selection, content, revision, onClose, onClearSelection, prepareRequest, onApply }: Props) {
  const client = useQueryClient();
  const [draft, setDraft] = useState('');
  const [localTurn, setLocalTurn] = useState<Turn | null>(null);
  const [sendError, setSendError] = useState('');
  const [applyErrors, setApplyErrors] = useState<Record<string, string>>({});
  const [awayFromBottom, setAwayFromBottom] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const sending = useRef(false);
  const applying = useRef(false);
  const follow = useRef(true);
  const stream = useConversationStream(`${projectId}:${episodeId}`);
  const queryKey = ['editor-ai', projectId, episodeId];
  const query = useQuery({
    queryKey, queryFn: () => api.editorAi.history(projectId, episodeId), enabled: open, staleTime: 0,
    refetchInterval: (query) => query.state.data?.messages.some((message) => message.status === 'PENDING') ? 2_000 : false,
  });
  const messages = query.data?.messages ?? [];
  const sendMutation = useMutation({
    mutationFn: async (turn: Turn) => {
      const { onEvent, signal } = stream.start();
      const request = turn.request ?? await prepareRequest(turn.content, turn.clientMessageId);
      signal.throwIfAborted();
      setLocalTurn({ ...turn, request });
      return api.editorAi.send(projectId, episodeId, request, onEvent, signal);
    },
    onSuccess: async (history) => {
      if (stream.isAborted()) return;
      await client.cancelQueries({ queryKey, exact: true });
      client.setQueryData(queryKey, history);
      setLocalTurn(null);
      setSendError('');
    },
    onError: (error) => {
      if (stream.isAborted()) return;
      setSendError(messageOf(error));
      void client.invalidateQueries({ queryKey });
    },
    onSettled: () => { sending.current = false; },
  });
  const applyMutation = useMutation({
    mutationFn: ({ id, edit }: { id: string; edit: EditorAiEdit }) => onApply(id, edit),
    onSuccess: (_result, { id }) => setApplyErrors((errors) => ({ ...errors, [id]: '' })),
    onError: (error, { id }) => setApplyErrors((errors) => ({ ...errors, [id]: messageOf(error) })),
    onSettled: () => { applying.current = false; },
  });
  const pending = sendMutation.isPending || messages.some((message) => message.status === 'PENDING' && !(sendError && message.clientMessageId === localTurn?.clientMessageId));
  const localNotSaved = localTurn && !messages.some((message) => message.clientMessageId === localTurn.clientMessageId);
  const localAssistantMissing = localTurn && !messages.some((message) => message.role === 'assistant' && message.clientMessageId === localTurn.clientMessageId);
  const unsentFailure = Boolean(localNotSaved && sendError && !pending);
  const selected = Boolean(selection?.text);
  const selectionStale = Boolean(selected && selection && selection.content !== content);
  const busy = disabled || pending || applyMutation.isPending;

  useLayoutEffect(() => {
    if (open && follow.current && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [messages, localTurn, pending, open, stream.progress]);
  useLayoutEffect(() => {
    if (open) inputRef.current?.focus({ preventScroll: true });
  }, [open]);

  const send = (turn: Turn) => {
    if (busy || sending.current || applying.current) return;
    sending.current = true;
    follow.current = true;
    setAwayFromBottom(false);
    setLocalTurn(turn);
    setSendError('');
    sendMutation.mutate(turn);
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!open || !query.data || !draft.trim() || draft.trim().length > 20_000 || busy || sending.current || applying.current || unsentFailure || selectionStale) return;
    send({ content: draft.trim(), clientMessageId: createIdempotencyKey() });
    setDraft('');
  };
  const restoreInput = (value: string) => {
    setDraft((current) => current ? `${value}\n\n${current}` : value);
    setLocalTurn(null);
    setSendError('');
    inputRef.current?.focus();
  };

  if (!open) return null;
  return <aside className="editor-ai-panel" aria-label="편집 AI">
    <header className="editor-ai-heading">
      <div className="flex items-center gap-2"><PencilLine className="size-4 text-plum-600" aria-hidden="true" /><h2 className="text-sm font-bold">편집 AI</h2></div>
      <IconButton label="편집 AI 닫기" onClick={onClose}><X className="size-4" /></IconButton>
    </header>
    <div className="chat-history-wrap">
      <div ref={logRef} className="editor-ai-history" role="log" aria-label="회차 편집 AI 대화" aria-live="polite" aria-relevant="additions text"
        onScroll={() => {
          const element = logRef.current;
          if (!element) return;
          const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 64;
          follow.current = atBottom;
          setAwayFromBottom(!atBottom);
        }}>
        {query.isPending ? <Spinner label="편집 대화를 불러오는 중" /> : query.isError && !query.data
          ? <ErrorState message={messageOf(query.error)} onRetry={() => { void query.refetch(); }} /> : null}
        {query.data && !messages.length && !localTurn ? <div className="editor-ai-welcome">
          <Sparkles className="size-6 text-plum-600" aria-hidden="true" />
          <h3 className="font-story text-lg font-bold">이 문장부터, 함께 써요</h3>
          <p>새 장면을 쓰거나 문장을 다듬어 보세요.<br />선택하지 않으면 AI가 수정할 범위를 찾아요.<br />수정 전후를 비교하고 수락하면 본문에 적용돼요.</p>
          <div className="flex flex-wrap justify-center gap-2">
            {(selected ? ['선택한 부분의 긴장감을 높여줘', '대사를 더 자연스럽게 다듬어줘'] : ['도입부를 더 흥미롭게 다듬어줘', '다음 장면을 써줘']).map((suggestion) =>
              <Button key={suggestion} size="sm" variant="secondary" onClick={() => { setDraft(suggestion); inputRef.current?.focus(); }}>{suggestion}</Button>)}
          </div>
        </div> : null}
        {messages.map((message) => {
          const localAssistant = message.role === 'assistant' && message.clientMessageId === localTurn?.clientMessageId && (sendMutation.isPending || message.status !== 'COMPLETE');
          const streaming = localAssistant && sendMutation.isPending;
          const failed = !streaming && (message.status === 'FAILED' || (localAssistant && Boolean(sendError)));
          return <article key={message.id} className={`editor-ai-message editor-ai-message-${message.role}`} aria-label={message.role === 'user' ? '내 편집 요청' : '편집 AI 답변'}>
            <p className="chat-speaker">{message.role === 'user' ? '나' : '편집 AI'}</p>
            {message.request?.selection.text ? <details className="editor-ai-source"><summary>선택한 원문 · {characterCount(message.request.selection.text)}자</summary><p>{message.request.selection.text}</p></details> : null}
            {localAssistant ? <ConversationReply progress={stream.progress} pending={streaming} className="editor-ai-message-text" fallback="원고를 읽고 답변을 쓰고 있어요." />
              : message.status === 'PENDING' ? <p className="chat-processing" role="status"><Sparkles className="size-4 animate-pulse" />원고를 읽고 답변을 쓰고 있어요.</p>
                : message.status === 'COMPLETE' ? <p className="editor-ai-message-text">{message.content}</p> : null}
            {failed ? <>
              <p className="text-sm text-red-700" role="alert">{localAssistant && sendError ? sendError : message.error || '답변을 완료하지 못했습니다.'}</p>
              <div className="mt-2 flex flex-wrap gap-1">
                <Button size="sm" variant="secondary" disabled={busy} onClick={() => {
                  const request = messages.find((item) => item.role === 'user' && item.clientMessageId === message.clientMessageId)?.request;
                  if (request) send({ content: request.content, clientMessageId: request.clientMessageId, request });
                }}><RotateCcw className="size-3.5" />답변 다시 시도</Button>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => {
                  const user = messages.find((item) => item.role === 'user' && item.clientMessageId === message.clientMessageId);
                  if (user) restoreInput(user.content);
                }}>현재 원고로 다시 요청</Button>
              </div>
            </> : null}
            {!streaming && message.status === 'COMPLETE' && message.edit ? <EditCard edit={message.edit} stale={dirty || message.edit.baseRevision !== revision} disabled={busy}
              autoSelected={!messages.find((item) => item.role === 'user' && item.clientMessageId === message.clientMessageId)?.request?.selection.text}
              applying={applyMutation.isPending && applyMutation.variables?.id === message.id} error={applyErrors[message.id]}
              onApply={() => {
                if (applying.current || sending.current || busy) return;
                applying.current = true;
                applyMutation.mutate({ id: message.id, edit: message.edit! });
              }} /> : null}
          </article>;
        })}
        {localNotSaved ? <article className="editor-ai-message editor-ai-message-user"><p className="chat-speaker">나</p><p className="editor-ai-message-text">{localTurn.content}</p></article> : null}
        {localAssistantMissing ? <div className="editor-ai-message editor-ai-message-assistant" aria-label="편집 AI 답변">
          <p className="chat-speaker">편집 AI</p>
          <ConversationReply progress={stream.progress} pending={sendMutation.isPending} className="editor-ai-message-text" fallback="원고를 읽고 답변을 쓰고 있어요." />
          {!sendMutation.isPending ? <>
            <p className="text-sm text-red-700" role="alert">{sendError}</p>
            <div className="mt-2 flex flex-wrap gap-1">
              <Button size="sm" variant="secondary" disabled={busy} onClick={() => send(localTurn)}>전송 다시 시도</Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => restoreInput(localTurn.content)}>입력 수정</Button>
            </div>
          </> : null}
        </div> : null}
      </div>
      {awayFromBottom ? <Button className="chat-latest" variant="secondary" size="sm" onClick={() => {
        follow.current = true;
        setAwayFromBottom(false);
        if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
      }}><ArrowDown className="size-4" />최근 대화</Button> : null}
    </div>
    <form className="editor-ai-composer" onSubmit={submit}>
      <div className="editor-ai-selection">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {selected ? <TextSelect className="size-4 shrink-0" aria-hidden="true" /> : <Sparkles className="size-4 shrink-0" aria-hidden="true" />}
          <span>{selected ? `선택한 부분 · ${characterCount(selection!.text)}자` : 'AI가 수정 범위를 선택해요'}</span>
          {selected ? <span className="shrink-0 text-[10px] font-normal text-muted">고정됨</span> : null}
        </div>
        {selection ? <IconButton type="button" label="편집 AI 선택 해제" onClick={onClearSelection}><X className="size-3.5" /></IconButton> : null}
      </div>
      {selected ? <p className="editor-ai-selection-text" aria-label="편집 AI에 고정한 원문">{selection!.text}</p> : null}
      {selectionStale ? <p className="mb-2 text-xs text-red-700" role="alert">원고가 바뀌었어요. 수정할 부분을 다시 선택하거나 선택을 해제해 주세요.</p> : null}
      <label className="sr-only" htmlFor="editor-ai-input">편집 AI에게 보낼 메시지</label>
      <div className="editor-ai-input-wrap">
        <textarea id="editor-ai-input" ref={inputRef} rows={2} maxLength={20_000} value={draft}
          onChange={(event) => setDraft(event.target.value)} placeholder={selected ? '선택한 부분을 어떻게 바꿀까요?' : '함께 쓸 장면이나 다듬을 내용을 알려주세요.'}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }} />
        <IconButton label="편집 AI에 보내기" type="submit" disabled={!draft.trim() || busy || unsentFailure || selectionStale || !query.data}>
          <Send className="size-4" />
        </IconButton>
      </div>
    </form>
  </aside>;
}

function EditCard({ edit, autoSelected, stale, disabled, applying, error, onApply }: {
  edit: EditorAiEdit; autoSelected: boolean; stale: boolean; disabled: boolean; applying: boolean; error?: string; onApply: () => void;
}) {
  const applied = edit.status === 'APPLIED';
  return <section className="editor-ai-edit" aria-label="원고 수정안">
    <h3 className="text-sm font-bold">{edit.title}</h3>
    <p className="mt-1 text-xs text-muted">{edit.end > edit.start
      ? `${autoSelected ? 'AI가 고른 범위' : '선택한 범위'} · ${characterCount(edit.original)}자`
      : '새 본문 삽입'}</p>
    <div className="editor-ai-comparison">
      <section className="editor-ai-version editor-ai-before" aria-label="수정 전">
        <div className="editor-ai-version-heading"><h4>수정 전</h4><span>{characterCount(edit.original)}자</span></div>
        <p className="editor-ai-version-text">{edit.original || <span className="text-muted">이 위치에 새 본문을 삽입합니다.</span>}</p>
      </section>
      <section className="editor-ai-version editor-ai-after" aria-label="수정 후">
        <div className="editor-ai-version-heading"><h4>수정 후</h4><span>{characterCount(edit.replacement)}자</span></div>
        <p className="editor-ai-version-text">{edit.replacement || <span className="text-muted">이 범위의 본문을 삭제합니다.</span>}</p>
      </section>
    </div>
    {applied ? <p className="mt-3 flex items-center gap-1.5 text-xs font-semibold text-sage-700"><Check className="size-4" />적용됨</p>
      : <>
        <Button className="mt-3 w-full" size="sm" disabled={disabled || stale} busy={applying} onClick={onApply}>
          <Check className="size-4" />수락하고 적용
        </Button>
        <p className="mt-2 text-xs leading-5 text-muted">{stale
          ? '원고가 변경되어 적용할 수 없어요. 현재 원고를 기준으로 다시 요청해 주세요.'
          : '수락하기 전에는 본문이 바뀌지 않아요.'}</p>
      </>}
    {error ? <p className="mt-2 text-sm text-red-700" role="alert">{error}</p> : null}
  </section>;
}
