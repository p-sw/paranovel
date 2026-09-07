import { useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { ArrowDown, MessageCircle, RotateCcw, Send, Sparkles } from 'lucide-react';
import type { ChatHistory, ChatMessage } from '@paranovel/contracts';
import { api, isConflict, messageOf } from '../api/client';
import { createIdempotencyKey } from '../lib';
import { Button, ErrorState, Spinner } from '../components/Ui';
import { ChatProposalCard } from '../components/ChatProposalCard';
import { ChatHeading } from '../components/ChatHeading';
import { ConversationReply } from '../components/ConversationReply';
import { useConversationStream } from '../useConversationStream';

type Turn = { content: string; clientMessageId: string };
const suggestions = ['현재 설정에서 모순되는 부분을 찾아줘', '다음 아크를 계획해 줘', '최근 회차를 분석하고 개선점을 제안해 줘'];

export default function ChatPage() {
  const { projectId = '', threadId = '' } = useParams();
  return <ProjectChat key={`${projectId}:${threadId}`} projectId={projectId} threadId={threadId} />;
}

function ProjectChat({ projectId, threadId }: { projectId: string; threadId: string }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState('');
  const [localTurn, setLocalTurn] = useState<Turn | null>(null);
  const [sendError, setSendError] = useState('');
  const [applyErrors, setApplyErrors] = useState<Record<string, string>>({});
  const [awayFromBottom, setAwayFromBottom] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const followRef = useRef(true);
  const sendingRef = useRef(false);
  const applyingRef = useRef(false);
  const stream = useConversationStream(`${projectId}:${threadId}`);
  const queryKey = ['chat', projectId, threadId];
  const historyQuery = useQuery({
    queryKey,
    queryFn: () => api.chat.history(projectId, threadId),
    staleTime: 0,
    refetchInterval: (query) => query.state.data?.messages.some((message) => message.status === 'PENDING') ? 2_000 : false,
  });
  const messages = historyQuery.data?.messages ?? [];
  const sendMutation = useMutation({
    mutationFn: (turn: Turn) => {
      const { onEvent, signal } = stream.start();
      return api.chat.send(projectId, turn, threadId, onEvent, signal);
    },
    onSuccess: async (history) => {
      if (stream.isAborted()) return;
      await queryClient.cancelQueries({ queryKey, exact: true });
      queryClient.setQueryData(queryKey, history);
      setLocalTurn(null);
      setSendError('');
    },
    onError: (error) => {
      if (stream.isAborted()) return;
      setSendError(messageOf(error));
      void queryClient.invalidateQueries({ queryKey });
    },
    onSettled: () => {
      sendingRef.current = false;
      void queryClient.invalidateQueries({ queryKey: ['chat-threads', projectId] });
    },
  });
  const applyMutation = useMutation({
    mutationFn: (proposalId: string) => api.chat.apply(projectId, proposalId),
    onSuccess: async ({ proposal }) => {
      await queryClient.cancelQueries({ queryKey, exact: true });
      queryClient.setQueryData<ChatHistory>(queryKey, (history) => history ? {
        ...history,
        messages: history.messages.map((message) => ({
          ...message, proposals: message.proposals.map((item) => item.id === proposal.id ? proposal : item),
        })),
      } : history);
      setApplyErrors((previous) => ({ ...previous, [proposal.id]: '' }));
      for (const key of [['projects'], ['canon', projectId], ['arc', projectId], ['arcs', projectId], ['improvements']]) {
        void queryClient.invalidateQueries({ queryKey: key });
      }
    },
    onError: (error, proposalId) => setApplyErrors((previous) => ({
      ...previous,
      [proposalId]: isConflict(error)
        ? '대상 내용이 변경되어 이 제안을 적용할 수 없습니다. 채팅에서 최신 내용을 기준으로 다시 요청해 주세요.'
        : messageOf(error),
    })),
    onSettled: () => { applyingRef.current = false; },
  });
  const pending = sendMutation.isPending || messages.some((message) => message.status === 'PENDING' && !(sendError && message.clientMessageId === localTurn?.clientMessageId));
  const localNotSaved = localTurn && !messages.some((message) => message.clientMessageId === localTurn.clientMessageId);
  const localAssistantMissing = localTurn && !messages.some((message) => message.role === 'assistant' && message.clientMessageId === localTurn.clientMessageId);
  const unsavedFailure = Boolean(localNotSaved && sendError && !sendMutation.isPending);

  useLayoutEffect(() => {
    if (followRef.current && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [messages, localTurn, sendError, pending, stream.progress]);

  const send = (turn: Turn) => {
    if (sendingRef.current || pending || applyingRef.current) return;
    sendingRef.current = true;
    followRef.current = true;
    setAwayFromBottom(false);
    setLocalTurn(turn);
    setSendError('');
    sendMutation.mutate(turn);
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const content = draft.trim();
    if (!content || pending || sendingRef.current || applyMutation.isPending || unsavedFailure || content.length > 20_000) return;
    setDraft('');
    send({ content, clientMessageId: createIdempotencyKey() });
  };
  const retryMessage = (message: ChatMessage) => {
    const user = messages.find((item) => item.role === 'user' && item.clientMessageId === message.clientMessageId);
    if (user) send({ content: user.content, clientMessageId: user.clientMessageId });
  };
  const scrollToBottom = () => {
    followRef.current = true;
    setAwayFromBottom(false);
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  };

  if (historyQuery.isPending || (historyQuery.isError && !historyQuery.data)) return <div className="chat-page">
    <ChatHeading projectId={projectId} />
    {historyQuery.isPending ? <Spinner label="대화를 불러오는 중" />
      : <ErrorState message={messageOf(historyQuery.error)} onRetry={() => { void historyQuery.refetch(); }} />}
  </div>;

  return <div className="chat-page">
    <ChatHeading projectId={projectId} title={historyQuery.data?.thread?.title} />
    <div className="chat-history-wrap">
      <div ref={logRef} className="chat-history" role="log" aria-label="프로젝트 AI 대화" aria-live="polite" aria-relevant="additions text"
        onScroll={() => {
          const element = logRef.current;
          if (!element) return;
          const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 64;
          followRef.current = atBottom;
          setAwayFromBottom(!atBottom);
        }}>
        {!messages.length && !localTurn ? <div className="chat-welcome">
          <MessageCircle className="size-9 text-plum-600" aria-hidden="true" />
          <h2 className="font-story text-xl font-bold">어떤 이야기를 함께 풀어 볼까요?</h2>
          <p className="text-sm leading-6 text-muted">기존 회차를 살펴보며 설정을 정리하거나 다음 아크를 계획할 수 있어요.</p>
          <div className="flex flex-col gap-2">{suggestions.map((suggestion) => <Button key={suggestion} variant="secondary" onClick={() => { setDraft(suggestion); inputRef.current?.focus(); }}>{suggestion}</Button>)}</div>
        </div> : null}
        {messages.map((message) => {
          const localAssistant = message.role === 'assistant' && message.clientMessageId === localTurn?.clientMessageId && (sendMutation.isPending || message.status !== 'COMPLETE');
          const streaming = localAssistant && sendMutation.isPending;
          const failed = !streaming && (message.status === 'FAILED' || (localAssistant && Boolean(sendError)));
          return <article key={message.id} className={`chat-message chat-message-${message.role}`} aria-label={message.role === 'user' ? '내 메시지' : 'AI 답변'}>
            <p className="chat-speaker">{message.role === 'user' ? '나' : 'AI'}</p>
            {localAssistant ? <ConversationReply progress={stream.progress} pending={streaming} className="chat-message-text" fallback="작품 정보를 확인하며 답변을 준비하고 있어요." />
              : message.content ? <p className="chat-message-text">{message.content}</p> : null}
            {!localAssistant && message.status === 'PENDING' && message.role === 'assistant' ? <p className="chat-processing" role="status"><Sparkles className="size-4 animate-pulse" />작품 정보를 확인하며 답변을 준비하고 있어요.</p> : null}
            {failed ? <div className="mt-3">
              <p className="text-sm text-red-700" role="alert">{localAssistant && sendError ? sendError : message.error || '답변을 만들지 못했습니다. 다시 시도해 주세요.'}</p>
              <Button className="mt-2" variant="secondary" disabled={pending || applyMutation.isPending} onClick={() => retryMessage(message)}><RotateCcw className="size-4" />답변 다시 시도</Button>
            </div> : null}
            {!streaming && message.status === 'COMPLETE' ? message.proposals.map((proposal) => <ChatProposalCard key={proposal.id} proposal={proposal}
              busy={applyMutation.isPending && applyMutation.variables === proposal.id}
              disabled={pending || applyMutation.isPending}
              error={applyErrors[proposal.id]}
              onApply={() => {
                if (applyingRef.current || sendingRef.current || pending) return;
                applyingRef.current = true;
                applyMutation.mutate(proposal.id);
              }} />) : null}
          </article>;
        })}
        {localNotSaved ? <article className="chat-message chat-message-user" aria-label="내 메시지"><p className="chat-speaker">나</p><p className="chat-message-text">{localTurn.content}</p></article> : null}
        {localAssistantMissing ? <div className="chat-message chat-message-assistant" aria-label="AI 답변">
          <p className="chat-speaker">AI</p>
          <ConversationReply progress={stream.progress} pending={sendMutation.isPending} className="chat-message-text" fallback="작품 정보를 확인하며 답변을 준비하고 있어요." />
          {!sendMutation.isPending ? <>
            <p className="text-sm text-red-700" role="alert">{sendError || '메시지를 전송하지 못했습니다.'}</p>
            <Button className="mt-2" variant="secondary" disabled={pending || applyMutation.isPending} onClick={() => send(localTurn)}><RotateCcw className="size-4" />전송 다시 시도</Button>
            <Button className="ml-2 mt-2" variant="ghost" disabled={pending || applyMutation.isPending} onClick={() => {
              setDraft((previous) => previous ? `${localTurn.content}\n\n${previous}` : localTurn.content);
              setLocalTurn(null);
              setSendError('');
              inputRef.current?.focus();
            }}>입력 수정</Button>
          </> : null}
        </div> : null}
      </div>
      {awayFromBottom ? <Button className="chat-latest" variant="secondary" size="sm" onClick={scrollToBottom}><ArrowDown className="size-4" />최근 대화</Button> : null}
    </div>
    <form className="chat-composer" onSubmit={submit}>
      <label className="sr-only" htmlFor="chat-message">AI에게 보낼 메시지</label>
      <textarea ref={inputRef} id="chat-message" className="input" rows={3} maxLength={20_000} value={draft}
        onChange={(event) => setDraft(event.target.value)} placeholder="설정이나 아크에 대해 질문하거나 변경을 요청하세요."
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) {
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }
        }} />
      <div className="mt-2 flex items-center justify-between gap-3">
        <p className="text-xs leading-5 text-muted">Enter로 전송 · Shift+Enter로 줄바꿈</p>
        <Button type="submit" disabled={!draft.trim() || pending || applyMutation.isPending || unsavedFailure || draft.trim().length > 20_000} busy={sendMutation.isPending}><Send className="size-4" />보내기</Button>
      </div>
    </form>
  </div>;
}
