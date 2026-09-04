import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import {
  AlertTriangle,
  BookOpenText,
  CheckCircle2,
  Ellipsis,
  FilePlus2,
  LoaderCircle,
  Plus,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { Link, useOutletContext, useParams } from 'react-router-dom';
import { api, messageOf } from '../api/client';
import { AI_PHASE_LABELS, characterCount, createIdempotencyKey, formatRelativeDate } from '../lib';
import type { AiPhase, ContinuityIssue, Episode } from '../types';
import type { ProjectOutletContext } from '../components/AppShell';
import {
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  FieldError,
  IconButton,
  Sheet,
  SkeletonCards,
} from '../components/Ui';

export default function EpisodesPage() {
  const { projectId = '' } = useParams();
  const { project } = useOutletContext<ProjectOutletContext>();
  const queryClient = useQueryClient();
  const [creatorOpen, setCreatorOpen] = useState(false);
  const [deleting, setDeleting] = useState<Episode | null>(null);
  const episodesQuery = useQuery({
    queryKey: ['episodes', projectId],
    queryFn: () => api.episodes.list(projectId),
  });
  const deleteMutation = useMutation({
    mutationFn: (episode: Episode) => api.episodes.remove(projectId, episode.id, episode.revision),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['episodes', projectId] });
      queryClient.invalidateQueries({ queryKey: ['projects', projectId] });
      setDeleting(null);
    },
  });
  const episodes = [...(episodesQuery.data ?? [])].sort((a, b) => b.number - a.number);

  return (
    <div className="page-container">
      <header className="page-heading-row">
        <div>
          <p className="eyebrow">{project.genreTags.slice(0, 2).join(' · ')}</p>
          <h1 className="section-title">회차</h1>
          <p className="page-lead">{project.logline}</p>
        </div>
        <Button onClick={() => setCreatorOpen(true)}>
          <Plus className="size-4" /> 새 회차
        </Button>
      </header>

      {episodesQuery.isPending ? <SkeletonCards count={4} /> : null}
      {episodesQuery.isError ? (
        <ErrorState message={messageOf(episodesQuery.error)} onRetry={() => episodesQuery.refetch()} />
      ) : null}
      {!episodesQuery.isPending && !episodes.length ? (
        <EmptyState
          icon={<BookOpenText className="size-8" />}
          title="첫 회차가 기다리고 있어요"
          description="방향을 직접 정하거나 AI에게 제목과 전개 방향을 제안받아 시작하세요."
          action={<Button onClick={() => setCreatorOpen(true)}><FilePlus2 className="size-4" /> 첫 회차 만들기</Button>}
        />
      ) : null}

      {episodes.length ? (
        <section className="episode-list" aria-label="회차 목록">
          {episodes.map((episode) => {
            const summaryFresh = episode.summary?.sourceRevision === episode.revision && !episode.summary?.stale;
            return (
              <article className="episode-row" key={episode.id}>
                <Link className="episode-row-link" to={`${episode.id}`}>
                  <div className="episode-number">{episode.number}<small>화</small></div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2>{episode.title || '제목 없는 회차'}</h2>
                      {summaryFresh ? (
                        <Badge tone="sage"><CheckCircle2 className="size-3" /> 기억 최신</Badge>
                      ) : (
                        <Badge tone="warning"><AlertTriangle className="size-3" /> 기억 갱신 필요</Badge>
                      )}
                    </div>
                    <p className="mt-1 line-clamp-1 text-sm text-muted">{episode.direction || episode.summary?.events[0] || '전개 방향이 아직 없습니다.'}</p>
                    <p className="mt-3 text-xs text-muted">{characterCount(episode.content)}자 · {formatRelativeDate(episode.updatedAt)}</p>
                  </div>
                </Link>
                <DropdownMenu.Root>
                  <DropdownMenu.Trigger asChild>
                    <IconButton label={`${episode.number}화 메뉴`} className="shrink-0">
                      <Ellipsis className="size-5" />
                    </IconButton>
                  </DropdownMenu.Trigger>
                  <DropdownMenu.Portal>
                    <DropdownMenu.Content className="dropdown-content" align="end" sideOffset={6}>
                      <DropdownMenu.Item className="dropdown-item text-red-700" onSelect={() => setDeleting(episode)}>
                        <Trash2 className="size-4" /> 회차 삭제
                      </DropdownMenu.Item>
                    </DropdownMenu.Content>
                  </DropdownMenu.Portal>
                </DropdownMenu.Root>
              </article>
            );
          })}
        </section>
      ) : null}

      <CreateEpisodeSheet open={creatorOpen} onOpenChange={setCreatorOpen} projectId={projectId} />
      <ConfirmDialog
        open={Boolean(deleting)}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`${deleting?.number ?? ''}화를 삭제할까요?`}
        description="본문과 회차 요약이 삭제되고 검색 기억에서도 제외됩니다. 이 작업은 되돌릴 수 없습니다."
        onConfirm={() => deleting && deleteMutation.mutate(deleting)}
        busy={deleteMutation.isPending}
      />
    </div>
  );
}

function CreateEpisodeSheet({
  open,
  onOpenChange,
  projectId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
}) {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState('');
  const [direction, setDirection] = useState('');
  const [hint, setHint] = useState('');
  const [preview, setPreview] = useState('');
  const [phase, setPhase] = useState<AiPhase>('idle');
  const [issues, setIssues] = useState<ContinuityIssue[]>([]);
  const [proposalConflicts, setProposalConflicts] = useState<string[]>([]);
  const [blocked, setBlocked] = useState(false);
  const [error, setError] = useState('');
  const abortRef = useRef<AbortController | null>(null);
  const idempotencyKeyRef = useRef(createIdempotencyKey());

  const proposeMutation = useMutation({
    mutationFn: () => api.episodes.propose(projectId, hint.trim() || undefined),
    onSuccess: (proposal) => {
      setTitle(proposal.title);
      setDirection(proposal.direction);
      setProposalConflicts(proposal.conflicts ?? []);
      setError('');
    },
    onError: (reason) => setError(messageOf(reason)),
  });
  const createMutation = useMutation({
    mutationFn: (forceNeedsReview: boolean) => api.episodes.create(
      projectId,
      { title: title.trim(), direction: direction.trim(), content: preview, forceNeedsReview },
      idempotencyKeyRef.current,
    ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['episodes', projectId] });
      queryClient.invalidateQueries({ queryKey: ['projects', projectId] });
      onOpenChange(false);
    },
    onError: (reason) => setError(messageOf(reason)),
  });

  useEffect(() => {
    if (open) return;
    abortRef.current?.abort();
    setTitle('');
    setDirection('');
    setHint('');
    setPreview('');
    setPhase('idle');
    setIssues([]);
    setProposalConflicts([]);
    setBlocked(false);
    setError('');
    idempotencyKeyRef.current = createIdempotencyKey();
  }, [open]);

  const generate = async () => {
    if (!title.trim() || !direction.trim()) {
      setError('제목과 전개 방향을 먼저 확인해 주세요.');
      return;
    }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setPreview('');
    setIssues([]);
    setBlocked(false);
    setError('');
    setPhase('retrieving');
    try {
      const result = await api.episodes.generate(
        projectId,
        { title: title.trim(), direction: direction.trim() },
        (event, content) => {
          if (event.type === 'stage') {
            setPhase(event.stage === 'MEMORY' ? 'retrieving' : event.stage === 'WRITING' ? 'writing' : event.stage === 'REPAIRING' ? 'repairing' : 'checking');
          }
          if (event.type === 'delta' || event.type === 'reset') {
            setPhase('writing');
            setPreview(content);
          }
          if (event.type === 'done') {
            setPreview(event.content);
            setIssues(event.issues);
            setBlocked(event.blocked);
            setPhase('done');
          }
        },
        controller.signal,
      );
      setPreview(result.content);
      setIssues(result.issues);
      setBlocked(result.blocked);
      setPhase('done');
    } catch (reason) {
      if (controller.signal.aborted) setPhase('cancelled');
      else {
        setPhase('error');
        setError(messageOf(reason));
      }
    }
  };

  const isGenerating = ['retrieving', 'writing', 'checking', 'repairing'].includes(phase);
  const footer = preview && phase === 'done' ? (
    <div className="flex w-full flex-wrap items-center justify-end gap-2">
      <Button variant="secondary" onClick={() => { setPreview(''); setPhase('idle'); }}>다시 설정</Button>
      <Button variant="secondary" onClick={() => void generate()}><Sparkles className="size-4" /> 다시 생성</Button>
      <Button busy={createMutation.isPending} onClick={() => createMutation.mutate(blocked)}>
        {blocked ? '차단 이슈 확인 · 검토 필요로 저장' : '초안 저장'}
      </Button>
    </div>
  ) : (
    <div className="flex w-full flex-wrap items-center justify-between gap-2">
      {isGenerating ? (
        <Button variant="secondary" onClick={() => abortRef.current?.abort()}>생성 중단</Button>
      ) : (
        <Button
          variant="ghost"
          disabled={!title.trim()}
          busy={createMutation.isPending}
          onClick={() => createMutation.mutate(false)}
        >
          빈 회차로 시작
        </Button>
      )}
      <Button disabled={!title.trim() || !direction.trim() || isGenerating} onClick={generate}>
        <Sparkles className="size-4" /> AI 초안 만들기
      </Button>
    </div>
  );

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next && isGenerating && !window.confirm('생성을 중단하고 닫을까요?')) return;
        onOpenChange(next);
      }}
      title="새 회차 만들기"
      description="AI 제안은 저장 전에 언제든 고칠 수 있어요."
      footer={footer}
      wide
    >
      {preview || isGenerating || phase === 'cancelled' ? (
        <div className="generation-preview">
          <div className="generation-status" role="status" aria-live="polite">
            {isGenerating ? <LoaderCircle className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
            <span>{AI_PHASE_LABELS[phase]}</span>
          </div>
          {isGenerating ? (
            <article className="story-preview">{preview || '작성된 문장까지 안전하게 보존했어요.'}</article>
          ) : (
            <textarea className="story-preview editable" aria-label="AI 초안 수정" value={preview} onChange={(event) => setPreview(event.target.value)} />
          )}
          {issues.length ? (
            <div className={blocked ? 'warning-box danger' : 'warning-box'} role="alert">
              <strong>{blocked ? '저장 전 반드시 검토하세요' : '이어짐을 확인해 주세요'}</strong>
              <ul>{issues.map((issue, index) => <li key={`${issue.explanation}-${index}`}><b>{issue.severity === 'BLOCKING' ? '차단' : '주의'}:</b> {issue.explanation}</li>)}</ul>
            </div>
          ) : null}
        </div>
      ) : (
        <div className="space-y-6">
          <div className="proposal-box">
            <label className="field-label" htmlFor="episode-hint">이번 회차에 원하는 것 <span className="font-normal text-muted">(선택)</span></label>
            <div className="mt-2 flex flex-col gap-2 sm:flex-row">
              <input id="episode-hint" className="input" value={hint} onChange={(event) => setHint(event.target.value)} placeholder="예: 주인공이 처음으로 능력을 들키는 회차" />
              <Button variant="secondary" busy={proposeMutation.isPending} onClick={() => proposeMutation.mutate()}>
                <Sparkles className="size-4" /> 방향 제안
              </Button>
            </div>
          </div>
          <div>
            <label className="field-label" htmlFor="episode-title">회차 제목</label>
            <input id="episode-title" className="input" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="제목을 입력하세요" />
          </div>
          <div>
            <label className="field-label" htmlFor="episode-direction">전개 방향</label>
            <textarea id="episode-direction" className="input min-h-32 resize-y" value={direction} onChange={(event) => setDirection(event.target.value)} placeholder="이 회차에서 일어날 일과 감정의 흐름을 적어 주세요" />
          </div>
          {proposalConflicts.length ? (
            <div className="warning-box" role="alert">
              <strong>제안에서 확인할 설정 충돌</strong>
              <ul>{proposalConflicts.map((conflict, index) => <li key={`${conflict}-${index}`}>{conflict}</li>)}</ul>
            </div>
          ) : null}
        </div>
      )}
      <FieldError>{error}</FieldError>
    </Sheet>
  );
}
