import { Link } from 'react-router-dom';
import { History } from 'lucide-react';
import { NewChatButton } from './NewChatButton';

export function ChatHeading({ projectId, title }: { projectId: string; title?: string }) {
  return <header className="chat-heading">
    <h1 className="min-w-0 truncate text-sm font-bold" title={title}>{title && title !== '새 채팅' ? title : 'AI 채팅'}</h1>
    <div className="flex shrink-0 items-center gap-2">
      <Link className="button button-secondary button-md" to={`/projects/${projectId}/chat/history`}><History className="size-4" aria-hidden="true" />채팅 기록</Link>
      <NewChatButton projectId={projectId} />
    </div>
  </header>;
}
