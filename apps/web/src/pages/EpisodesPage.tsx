import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import {
  AlertTriangle,
  ArrowRight,
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
          description="원하는 내용을 적거나 바로 다음으로 넘어가세요. AI가 제목과 전개 방향을 만들어요."
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

      {creatorOpen ? <CreateEpisodeSheet open={creatorOpen} onOpenChange={setCreatorOpen} projectId={projectId} /> : null}
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
  const [step, setStep] = useState<'request' | 'direction' | 'draft'>('request');
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
    mutationFn: ({ hint, signal }: { hint: string; signal: AbortSignal }) =>
      api.episodes.propose(projectId, hint || undefined, signal),
    onSuccess: (proposal, { signal }) => {
      if (signal.aborted) return;
      setTitle(proposal.title);
      setDirection(proposal.direction);
      setProposalConflicts(proposal.conflicts ?? []);
      setError('');
      setStep('direction');
    },
    onError: (reason, { signal }) => {
      if (!signal.aborted) setError(messageOf(reason));
    },
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

  useEffect(() => () => abortRef.current?.abort(), []);

  const next = () => {
    if (proposeMutation.isPending) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setError('');
    proposeMutation.mutate({ hint: hint.trim(), signal: controller.signal });
  };

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
    setStep('draft');
    setPhase('retrieving');
    try {
      const result = await api.episodes.generate(
        projectId,
        { title: title.trim(), direction: direction.trim() },
        (event, content) => {
          if (controller.signal.aborted) return;
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
      if (controller.signal.aborted) return;
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
  const needsReview = blocked || phase === 'cancelled' || phase === 'error';
  const footer = step === 'request' ? (
    <div className="action-row sm:justify-between">
      <Button variant="ghost" onClick={() => onOpenChange(false)}>취소</Button>
      <Button type="submit" form="episode-request-form" busy={proposeMutation.isPending}>
        {proposeMutation.isPending ? '만드는 중' : '다음'}
        {!proposeMutation.isPending ? <ArrowRight className="size-4" /> : null}
      </Button>
    </div>
  ) : step === 'direction' ? (
    <div className="action-row">
      <Button variant="ghost" disabled={createMutation.isPending} onClick={() => { setStep('request'); setError(''); }}>이전</Button>
      <Button variant="secondary" disabled={!title.trim() || !direction.trim()} busy={createMutation.isPending} onClick={() => createMutation.mutate(false)}>
        빈 회차로 시작
      </Button>
      <Button disabled={!title.trim() || !direction.trim() || createMutation.isPending} onClick={() => void generate()}>
        <Sparkles className="size-4" /> AI 초안 만들기
      </Button>
    </div>
  ) : isGenerating ? (
    <div className="action-row">
      <Button variant="secondary" onClick={() => abortRef.current?.abort()}>생성 중단</Button>
    </div>
  ) : (
    <div className="action-row">
      <Button variant="ghost" disabled={createMutation.isPending} onClick={() => { setStep('direction'); setPreview(''); setPhase('idle'); setError(''); }}>제목·방향 확인</Button>
      <Button variant="secondary" disabled={createMutation.isPending} onClick={() => void generate()}><Sparkles className="size-4" /> 다시 생성</Button>
      {preview ? (
        <Button busy={createMutation.isPending} onClick={() => createMutation.mutate(needsReview)}>
          {needsReview ? '검토 필요로 저장' : '초안 저장'}
        </Button>
      ) : null}
    </div>
  );

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next && createMutation.isPending) return;
        if (!next && isGenerating && !window.confirm('생성을 중단하고 닫을까요?')) return;
        if (!next) abortRef.current?.abort();
        onOpenChange(next);
      }}
      title="새 회차 만들기"
      description={step === 'request' ? '원하는 내용이 있으면 적어 주세요. 비워 두어도 괜찮아요.' : step === 'direction' ? 'AI가 제목과 전개 방향을 만들었어요. 필요하면 고친 뒤 시작하세요.' : '완성된 초안을 확인하고 저장하세요.'}
      footer={footer}
      wide
    >
      {step === 'request' ? (
        <form id="episode-request-form" onSubmit={(event) => { event.preventDefault(); next(); }}>
          <label className="field-label" htmlFor="episode-hint">이번 회차에 원하는 것 <span className="font-normal text-muted">(선택)</span></label>
          <textarea
            id="episode-hint"
            className="input mt-2"
            rows={8}
            maxLength={5000}
            value={hint}
            disabled={proposeMutation.isPending}
            onChange={(event) => setHint(event.target.value)}
            aria-describedby="episode-hint-help"
            placeholder="예: 주인공이 처음으로 능력을 들키는 회차"
          />
          <p id="episode-hint-help" className="field-hint">다음을 누르면 AI가 이야기의 흐름에 맞춰 제목과 전개 방향을 자동으로 만들어요.</p>
          {proposeMutation.isPending ? (
            <p className="generation-status mt-5" role="status">이전 회차와 설정을 확인하며 제목과 전개 방향을 만들고 있어요.</p>
          ) : null}
        </form>
      ) : step === 'draft' ? (
        <div className="generation-preview">
          <div className="generation-status" role="status" aria-live="polite">
            {isGenerating ? <LoaderCircle className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
            <span>{AI_PHASE_LABELS[phase]}</span>
          </div>
          {isGenerating ? (
            <article className="story-preview">{preview || '이야기의 흐름과 설정을 살펴보고 있어요…'}</article>
          ) : (
            <textarea className="story-preview editable" aria-label="AI 초안 수정" disabled={createMutation.isPending} value={preview} onChange={(event) => setPreview(event.target.value)} />
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
          <div>
            <label className="field-label" htmlFor="episode-title">회차 제목</label>
            <input id="episode-title" className="input" maxLength={200} disabled={createMutation.isPending} value={title} onChange={(event) => setTitle(event.target.value)} />
          </div>
          <div>
            <label className="field-label" htmlFor="episode-direction">전개 방향</label>
            <textarea id="episode-direction" className="input" rows={10} maxLength={20000} disabled={createMutation.isPending} value={direction} onChange={(event) => setDirection(event.target.value)} />
          </div>
          {proposalConflicts.length ? (
            <div className="warning-box" role="alert">
              <strong>확인할 설정 충돌</strong>
              <ul>{proposalConflicts.map((conflict, index) => <li key={`${conflict}-${index}`}>{conflict}</li>)}</ul>
            </div>
          ) : null}
        </div>
      )}
      <FieldError>{error}</FieldError>
    </Sheet>
  );
}
