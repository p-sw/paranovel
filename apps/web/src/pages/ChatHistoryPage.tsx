import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, ChevronRight, History, MessageCircle } from 'lucide-react';
import { api, messageOf } from '../api/client';
import { formatRelativeDate } from '../lib';
import { NewChatButton } from '../components/NewChatButton';
import { Badge, EmptyState, ErrorState, Spinner } from '../components/Ui';

export default function ChatHistoryPage() {
  const { projectId = '' } = useParams();
  const query = useQuery({
    queryKey: ['chat-threads', projectId],
    queryFn: () => api.chat.threads(projectId),
    staleTime: 0,
    refetchInterval: (query) => query.state.data?.some((thread) => thread.status === 'PENDING') ? 2_000 : false,
  });

  return <div className="page-container page-narrow">
    <Link className="mb-4 inline-flex min-h-11 items-center gap-2 text-sm font-semibold text-muted hover:text-ink" to={`/projects/${projectId}/chat`}>
      <ArrowLeft className="size-4" aria-hidden="true" />AI 채팅으로
    </Link>
    <header className="page-heading-row">
      <div><p className="eyebrow">함께 나눈 이야기</p><h1 className="section-title">채팅 기록</h1>
        <p className="page-lead">이전 채팅방을 열어 대화를 이어가세요.</p></div>
      <NewChatButton key={projectId} projectId={projectId} />
    </header>
    {query.isPending ? <Spinner label="채팅 기록을 불러오는 중" /> : null}
    {query.isError ? <ErrorState message={messageOf(query.error)} onRetry={() => { void query.refetch(); }} /> : null}
    {query.data?.length === 0 ? <EmptyState icon={<History className="size-8" aria-hidden="true" />} title="아직 채팅 기록이 없어요"
      description="새 채팅에서 이야기를 시작하면 이곳에서 다시 확인할 수 있어요." /> : null}
    {query.data?.length ? <ul className="space-y-3" aria-label="이전 채팅방">
      {query.data.map((thread) => <li key={thread.id}>
        <Link className="chat-thread-card" to={`/projects/${projectId}/chat/${encodeURIComponent(thread.id)}`}>
          <MessageCircle className="mt-1 size-5 shrink-0 text-plum-600" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <h2 className="truncate font-semibold text-ink" title={thread.title}>{thread.title}</h2>
            <p className="mt-2 line-clamp-2 break-words text-sm leading-6 text-muted">{thread.preview || '아직 메시지가 없는 채팅방입니다.'}</p>
            <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-muted">
              <time dateTime={thread.updatedAt} title={new Date(thread.updatedAt).toLocaleString('ko-KR')}>{formatRelativeDate(thread.updatedAt)}</time>
              <span>메시지 {thread.messageCount}개</span>
              {thread.status === 'PENDING' ? <Badge tone="plum">답변 중</Badge> : null}
              {thread.status === 'FAILED' ? <Badge tone="warning">답변 다시 시도 필요</Badge> : null}
            </div>
          </div>
          <ChevronRight className="mt-1 size-5 shrink-0 text-muted" aria-hidden="true" />
        </Link>
      </li>)}
    </ul> : null}
  </div>;
}
