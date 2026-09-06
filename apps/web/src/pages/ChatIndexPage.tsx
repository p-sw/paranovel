import { useQuery } from '@tanstack/react-query';
import { Navigate, useParams } from 'react-router-dom';
import { MessageCircle } from 'lucide-react';
import { api, messageOf } from '../api/client';
import { ChatHeading } from '../components/ChatHeading';
import { EmptyState, ErrorState, Spinner } from '../components/Ui';

export default function ChatIndexPage() {
  const { projectId = '' } = useParams();
  const query = useQuery({ queryKey: ['chat-threads', projectId], queryFn: () => api.chat.threads(projectId), staleTime: 0 });
  const latest = query.data?.[0];
  if (query.isPending || query.isFetching) return <Spinner label="대화를 불러오는 중" />;
  if (latest) return <Navigate to={`/projects/${projectId}/chat/${encodeURIComponent(latest.id)}`} replace />;

  return <div className="chat-page">
    <ChatHeading key={projectId} projectId={projectId} />
    <div className="chat-history">
      {query.isError ? <ErrorState message={messageOf(query.error)} onRetry={() => { void query.refetch(); }} />
        : <EmptyState icon={<MessageCircle className="size-8" aria-hidden="true" />} title="어떤 이야기를 함께 풀어 볼까요?"
          description="새 채팅을 열어 설정을 정리하거나 다음 아크를 계획해 보세요. 나눈 대화는 채팅 기록에 보관됩니다." />}
    </div>
  </div>;
}
