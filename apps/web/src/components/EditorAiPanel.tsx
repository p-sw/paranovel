import { useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, Check, CornerDownLeft, PencilLine, RotateCcw, Send, Sparkles, TextSelect, X } from 'lucide-react';
import type { EditorAiEdit, EditorAiInput } from '@paranovel/contracts';
import { api, messageOf } from '../api/client';
import { characterCount, createIdempotencyKey } from '../lib';
import type { SelectionSnapshot } from '../types';
import { Button, ErrorState, IconButton, Spinner } from './Ui';

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
  const queryKey = ['editor-ai', projectId, episodeId];
  const query = useQuery({
    queryKey, queryFn: () => api.editorAi.history(projectId, episodeId), enabled: open, staleTime: 0,
    refetchInterval: (query) => query.state.data?.messages.some((message) => message.status === 'PENDING') ? 2_000 : false,
  });
  const messages = query.data?.messages ?? [];
  const sendMutation = useMutation({
    mutationFn: async (turn: Turn) => {
      const request = turn.request ?? await prepareRequest(turn.content, turn.clientMessageId);
      setLocalTurn({ ...turn, request });
      return api.editorAi.send(projectId, episodeId, request);
    },
    onSuccess: async (history) => {
      await client.cancelQueries({ queryKey, exact: true });
      client.setQueryData(queryKey, history);
      setLocalTurn(null);
      setSendError('');
    },
    onError: (error) => {
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
  const pending = sendMutation.isPending || messages.some((message) => message.status === 'PENDING');
  const localNotSaved = localTurn && !messages.some((message) => message.clientMessageId === localTurn.clientMessageId);
  const unsentFailure = Boolean(localNotSaved && sendError && !pending);
  const selected = Boolean(selection?.text);
  const selectionStale = Boolean(selection && selection.content !== content);
  const busy = disabled || pending || applyMutation.isPending;

  useLayoutEffect(() => {
    if (open && follow.current && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [messages, localTurn, pending, open]);
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
          <p>새 장면을 쓰거나 문장을 다듬어 보세요.<br />본문을 선택하면 그 부분을 수정할 수 있어요.</p>
          <div className="flex flex-wrap justify-center gap-2">
            {(selected ? ['선택한 부분의 긴장감을 높여줘', '대사를 더 자연스럽게 다듬어줘'] : ['다음 장면을 써줘', '이번 회차의 전개를 함께 고민해줘']).map((suggestion) =>
              <Button key={suggestion} size="sm" variant="secondary" onClick={() => { setDraft(suggestion); inputRef.current?.focus(); }}>{suggestion}</Button>)}
          </div>
        </div> : null}
        {messages.map((message) => <article key={message.id} className={`editor-ai-message editor-ai-message-${message.role}`} aria-label={message.role === 'user' ? '내 편집 요청' : '편집 AI 답변'}>
          <p className="chat-speaker">{message.role === 'user' ? '나' : '편집 AI'}</p>
          {message.request?.selection.text ? <details className="editor-ai-source"><summary>선택한 원문 · {characterCount(message.request.selection.text)}자</summary><p>{message.request.selection.text}</p></details> : null}
          {message.status === 'PENDING' ? <p className="chat-processing" role="status"><Sparkles className="size-4 animate-pulse" />원고를 읽고 답변을 쓰고 있어요.</p>
            : message.status === 'FAILED' ? <>
              <p className="text-sm text-red-700" role="alert">{localTurn?.clientMessageId === message.clientMessageId && sendError ? sendError : message.error || '답변을 완료하지 못했습니다.'}</p>
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
            </> : <p className="editor-ai-message-text">{message.content}</p>}
          {message.edit ? <EditCard edit={message.edit} stale={dirty || message.edit.baseRevision !== revision} disabled={busy}
            applying={applyMutation.isPending && applyMutation.variables?.id === message.id} error={applyErrors[message.id]}
            onApply={() => {
              if (applying.current || sending.current || busy) return;
              applying.current = true;
              applyMutation.mutate({ id: message.id, edit: message.edit! });
            }} /> : null}
        </article>)}
        {localNotSaved ? <>
          <article className="editor-ai-message editor-ai-message-user"><p className="chat-speaker">나</p><p className="editor-ai-message-text">{localTurn.content}</p></article>
          <div className="editor-ai-message editor-ai-message-assistant">
            {pending ? <p className="chat-processing" role="status"><Sparkles className="size-4 animate-pulse" />원고를 읽고 답변을 쓰고 있어요.</p> : <>
              <p className="text-sm text-red-700" role="alert">{sendError}</p>
              <div className="mt-2 flex flex-wrap gap-1">
                <Button size="sm" variant="secondary" disabled={busy} onClick={() => send(localTurn)}>전송 다시 시도</Button>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => restoreInput(localTurn.content)}>입력 수정</Button>
              </div>
            </>}
          </div>
        </> : null}
        {sendError && !localNotSaved && !messages.some((message) => message.status === 'FAILED') ? <p role="alert" className="text-sm text-red-700">{sendError}</p> : null}
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
          {selected ? <TextSelect className="size-4 shrink-0" aria-hidden="true" /> : <CornerDownLeft className="size-4 shrink-0" aria-hidden="true" />}
          <span>{selected ? `선택한 부분 · ${characterCount(selection!.text)}자` : selection ? '커서 위치에서 이어쓰기' : '원고 끝에서 이어쓰기'}</span>
        </div>
        {selection ? <IconButton type="button" label="편집 AI 선택 해제" onClick={onClearSelection}><X className="size-3.5" /></IconButton> : null}
      </div>
      {selected ? <p className="editor-ai-selection-text">{selection!.text}</p> : null}
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

function EditCard({ edit, stale, disabled, applying, error, onApply }: {
  edit: EditorAiEdit; stale: boolean; disabled: boolean; applying: boolean; error?: string; onApply: () => void;
}) {
  const applied = edit.status === 'APPLIED';
  return <section className="editor-ai-edit" aria-label="원고 수정안">
    <h3 className="text-sm font-bold">{edit.title}</h3>
    {edit.original ? <details className="editor-ai-source"><summary>원문 보기</summary><p>{edit.original}</p></details> : null}
    <p className="editor-ai-replacement">{edit.replacement || '선택한 부분을 삭제합니다.'}</p>
    {applied ? <p className="mt-3 flex items-center gap-1.5 text-xs font-semibold text-sage-700"><Check className="size-4" />적용됨</p>
      : <>
        <Button className="mt-3 w-full" size="sm" disabled={disabled || stale} busy={applying} onClick={onApply}>
          <Check className="size-4" />{edit.end > edit.start ? '선택한 부분에 적용' : '원고에 삽입'}
        </Button>
        {stale ? <p className="mt-2 text-xs leading-5 text-muted">원고가 변경되어 적용할 수 없어요. 현재 원고를 기준으로 다시 요청해 주세요.</p> : null}
      </>}
    {error ? <p className="mt-2 text-sm text-red-700" role="alert">{error}</p> : null}
  </section>;
}
