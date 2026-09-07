import { Sparkles } from 'lucide-react';
import type { ConversationProgress } from '../useConversationStream';

export function ConversationReply({ progress, pending, fallback, className }: {
  progress: ConversationProgress; pending: boolean; fallback: string; className: string;
}) {
  const toolCount = Object.keys(progress.tools).length;
  const episodeTaskCount = Object.values(progress.episodeTasks).filter((task) => task.status === 'PENDING').length;
  return <>
    {progress.text ? <p className={className}>{progress.text}</p> : null}
    {pending ? <p className="chat-processing" role="status"><Sparkles className="size-4 animate-pulse" />{
      episodeTaskCount ? `회차 작업 ${episodeTaskCount}개를 진행하고 있어요.`
        : toolCount ? `도구 ${toolCount}개를 사용하고 있어요.` : progress.text ? '답변을 쓰고 있어요.' : fallback
    }</p> : null}
  </>;
}
