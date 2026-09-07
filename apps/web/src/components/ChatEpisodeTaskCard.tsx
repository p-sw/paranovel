import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ArrowUpRight, Check, Sparkles } from 'lucide-react';
import type { ChatEpisodeTask } from '@paranovel/contracts';
import { api } from '../api/client';
import { characterCount } from '../lib';
import { Badge } from './Ui';
import { EditorAiEditCard } from './EditorAiEditCard';

const labels: Record<ChatEpisodeTask['kind'], string> = {
  DIRECTION: '회차 구상', WRITE: '회차 집필', EDIT: '회차 편집',
};
const stages = {
  MEMORY: '작품 정보를 읽고 있어요.', WRITING: '본문을 쓰고 있어요.',
  CHECKING: '설정과 이야기의 흐름을 확인하고 있어요.', REPAIRING: '본문을 다듬고 있어요.',
};

export function ChatEpisodeTaskCard({ task, disabled, applying, error, onApply }: {
  task: ChatEpisodeTask;
  disabled: boolean;
  applying: boolean;
  error?: string;
  onApply: () => void;
}) {
  const edit = task.editorMessage?.edit;
  const episodeQuery = useQuery({
    queryKey: ['episodes', task.projectId, task.episodeId],
    queryFn: () => api.episodes.get(task.projectId, task.episodeId!),
    enabled: task.kind === 'EDIT' && task.status === 'COMPLETE' && Boolean(task.episodeId && edit && edit.status !== 'APPLIED'),
    staleTime: 0,
  });
  const stale = Boolean(edit && episodeQuery.data && edit.baseRevision !== episodeQuery.data.revision);
  const pending = task.status === 'PENDING';
  return <section className="chat-proposal" aria-label={`${labels[task.kind]}: ${task.title}`}>
    <div className="flex flex-wrap items-center gap-2">
      <Badge tone="plum">{labels[task.kind]}</Badge>
      {task.status === 'COMPLETE' ? <Badge tone="sage"><Check className="mr-1 size-3" />{task.kind === 'EDIT'
        ? edit?.status === 'APPLIED' ? '수정 적용됨' : '수정안 준비됨'
        : task.kind === 'WRITE' ? '회차 저장됨' : '구상 완료'}</Badge> : null}
      {task.status === 'FAILED' ? <Badge tone="danger">작업 실패</Badge> : null}
      {task.blocked ? <Badge tone="warning">검토 필요</Badge> : null}
    </div>
    <h3 className="mt-3 font-bold text-ink">{task.title}</h3>
    {pending ? <p className="chat-processing" role="status"><Sparkles className="size-4 animate-pulse" aria-hidden="true" />{
      task.stage ? stages[task.stage] : task.kind === 'EDIT' ? '편집 AI가 원고 수정안을 만들고 있어요.' : task.kind === 'DIRECTION' ? '다음 회차의 방향을 구상하고 있어요.' : '집필 AI가 회차를 쓰고 있어요.'
    }</p> : null}
    {task.direction ? <div className="mt-3">
      <h4 className="text-xs font-semibold text-muted">회차 방향</h4>
      <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-6">{task.direction}</p>
    </div> : null}
    {task.kind === 'DIRECTION' && task.status === 'COMPLETE' ? <p className="mt-3 text-xs leading-5 text-muted">대화로 방향을 더 다듬거나, 이 방향으로 회차를 써 달라고 요청해 보세요.</p> : null}
    {task.kind === 'DIRECTION' && task.content ? <div className="warning-box mt-3">
      <strong>구상 참고 사항</strong>
      <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-6">{task.content}</p>
    </div> : null}
    {task.content && task.kind === 'WRITE' ? <details className="mt-3" open={pending || undefined}>
      <summary className="cursor-pointer text-sm font-semibold">{pending ? '작성 중인 본문' : '회차 본문'} · {characterCount(task.content)}자</summary>
      <p className="mt-2 max-h-96 overflow-y-auto whitespace-pre-wrap break-words font-story text-sm leading-7">{task.content}</p>
    </details> : null}
    {task.issues.length ? <div className={task.blocked ? 'warning-box danger mt-3' : 'warning-box mt-3'} role="alert">
      <strong>설정과 흐름 확인 결과</strong>
      <ul>{task.issues.map((issue, index) => <li key={index}>
        <p><b>{issue.severity === 'BLOCKING' ? '차단' : '주의'}:</b> {issue.explanation}</p>
        {issue.excerpt ? <p className="mt-1 text-sm">위치: <q>{issue.excerpt}</q></p> : null}
        {issue.repairInstruction ? <p className="mt-1 text-sm">수정 방향: {issue.repairInstruction}</p> : null}
      </li>)}</ul>
      {task.episodeId ? <p className="mt-2 text-sm">에디터에서 본문을 확인하고, 대화로 추가 수정을 요청할 수 있어요.</p> : null}
    </div> : null}
    {task.kind === 'EDIT' && task.status === 'COMPLETE' && edit ? <EditorAiEditCard edit={edit} autoSelected
      stale={stale} disabled={disabled || !task.episodeId} applying={applying} error={error} onApply={onApply} /> : null}
    {task.error ? <p className="mt-3 text-sm text-red-700" role="alert">{task.error}</p> : null}
    {task.episodeId ? <div className="mt-4">
      <Link className="button button-secondary button-sm" to={`/projects/${task.projectId}/episodes/${task.episodeId}`}>
        <ArrowUpRight className="size-4" aria-hidden="true" />에디터에서 열기
      </Link>
    </div> : null}
  </section>;
}
