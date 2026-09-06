import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DragDropProvider } from '@dnd-kit/react';
import { useSortable } from '@dnd-kit/react/sortable';
import { move } from '@dnd-kit/helpers';
import type { EpisodeOrder } from '@paranovel/contracts';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import {
  AlertTriangle,
  ArrowRight,
  BookOpenText,
  CheckCircle2,
  Ellipsis,
  FilePlus2,
  GripVertical,
  Pencil,
  Plus,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { Link, useOutletContext, useParams } from 'react-router-dom';
import { api, isConflict, messageOf } from '../api/client';
import { characterCount, createIdempotencyKey, formatRelativeDate } from '../lib';
import DraftPreview, { DraftGenerationStatus } from '../components/DraftPreview';
import ContinuityIssues from '../components/ContinuityIssues';
import { useContinuityRepair } from '../useContinuityRepair';
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

type EpisodeSlot = { id: string; episode: Episode | null };
type OrderDraft = { items: EpisodeSlot[]; revision: string };

function orderItems(order: EpisodeOrder): EpisodeSlot[] {
  const episodes = new Map(order.episodes.map((episode) => [episode.id, episode]));
  return order.slots.map((episodeId, index) => ({
    id: episodeId ? `episode:${episodeId}` : `empty:${index}`,
    episode: episodeId ? episodes.get(episodeId)! : null,
  })).reverse();
}

export default function EpisodesPage() {
  const { projectId = '' } = useParams();
  return <ProjectEpisodes key={projectId} projectId={projectId} />;
}

function ProjectEpisodes({ projectId }: { projectId: string }) {
  const { project } = useOutletContext<ProjectOutletContext>();
  const queryClient = useQueryClient();
  const [creatorOpen, setCreatorOpen] = useState(false);
  const [deleting, setDeleting] = useState<Episode | null>(null);
  const [draft, setDraft] = useState<OrderDraft | null>(null);
  const [dragging, setDragging] = useState(false);
  const orderQuery = useQuery({
    queryKey: ['episode-order', projectId],
    queryFn: () => api.episodes.order(projectId),
    enabled: !draft,
  });
  const invalidateEpisodes = () => {
    void queryClient.invalidateQueries({ queryKey: ['episodes', projectId] });
    void queryClient.invalidateQueries({ queryKey: ['scene', projectId] });
    void queryClient.invalidateQueries({ queryKey: ['arcs', projectId] });
    void queryClient.invalidateQueries({ queryKey: ['arc', projectId] });
    void queryClient.invalidateQueries({ queryKey: ['projects'] });
  };
  const deleteMutation = useMutation({
    mutationFn: (episode: Episode) => api.episodes.remove(projectId, episode.id, episode.revision),
    onSuccess: () => {
      invalidateEpisodes();
      void queryClient.invalidateQueries({ queryKey: ['episode-order', projectId] });
      setDeleting(null);
    },
  });
  const saveMutation = useMutation({
    mutationFn: (current: OrderDraft) => api.episodes.updateOrder(projectId, {
      slots: current.items.map((item) => item.episode?.id ?? null).reverse(),
      expectedRevision: current.revision,
    }),
    onSuccess: (order) => {
      queryClient.setQueryData(['episode-order', projectId], order);
      invalidateEpisodes();
      setDraft(null);
    },
  });
  const reloadMutation = useMutation({
    mutationFn: () => api.episodes.order(projectId),
    onSuccess: (order) => {
      queryClient.setQueryData(['episode-order', projectId], order);
      setDraft({ items: orderItems(order), revision: order.revision });
      saveMutation.reset();
    },
  });
  const items = draft?.items ?? (orderQuery.data ? orderItems(orderQuery.data) : []);
  const editing = draft !== null;
  const busy = saveMutation.isPending || reloadMutation.isPending;
  const locked = busy || dragging;
  const conflict = isConflict(saveMutation.error);
  const save = () => {
    if (draft && !locked && !conflict) saveMutation.mutate(draft);
  };
  const cancel = () => {
    setDraft(null);
    saveMutation.reset();
    reloadMutation.reset();
  };

  return (
    <div className="page-container">
      <header className="page-heading-row">
        <div>
          <p className="eyebrow">{project.genreTags.slice(0, 2).join(' · ')}</p>
          <h1 className="section-title">회차</h1>
          <p className="page-lead">{project.logline}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {editing ? (
            <>
              <Button variant="secondary" disabled={locked} onClick={cancel}>취소</Button>
              <Button busy={saveMutation.isPending} disabled={locked || conflict} onClick={save}>완료</Button>
            </>
          ) : (
            <Button
              variant="secondary"
              disabled={!orderQuery.data || !items.length || orderQuery.isFetching || deleteMutation.isPending}
              onClick={() => {
                if (!orderQuery.data) return;
                saveMutation.reset();
                reloadMutation.reset();
                setDraft({ items: orderItems(orderQuery.data), revision: orderQuery.data.revision });
              }}
            ><Pencil className="size-4" /> 수정</Button>
          )}
          <Button disabled={editing} onClick={() => setCreatorOpen(true)}>
            <Plus className="size-4" /> 새 회차
          </Button>
        </div>
      </header>

      {editing ? (
        <p className="mb-4 text-sm text-muted" id="episode-order-instructions">
          손잡이를 끌어 회차 번호를 바꾸세요. 빈 회차는 바로 삭제할 수 있어요.
          <span className="sr-only">키보드는 손잡이에서 Space 또는 Enter로 잡고, 위아래 방향키로 이동한 뒤 다시 눌러 놓으세요. Escape로 이동을 취소합니다.</span>
        </p>
      ) : null}
      {editing && (saveMutation.isError || reloadMutation.isError) ? (
        <div className="episode-order-error" role="alert">
          <p>{reloadMutation.isError ? messageOf(reloadMutation.error) : conflict
            ? '회차 목록이 다른 곳에서 변경됐어요. 최신 목록을 불러온 뒤 다시 수정해 주세요. 불러오면 현재 편집 내용은 초기화됩니다.'
            : messageOf(saveMutation.error)}</p>
          <Button
            variant="secondary" size="sm" disabled={locked} busy={reloadMutation.isPending}
            onClick={() => conflict ? reloadMutation.mutate() : save()}
          >{conflict ? '최신 목록 다시 불러오기' : '다시 시도'}</Button>
        </div>
      ) : null}
      {!editing && orderQuery.isPending ? <SkeletonCards count={4} /> : null}
      {!editing && orderQuery.isError ? (
        <ErrorState message={messageOf(orderQuery.error)} onRetry={() => orderQuery.refetch()} />
      ) : null}
      {!editing && orderQuery.isSuccess && !items.length ? (
        <EmptyState
          icon={<BookOpenText className="size-8" />}
          title="첫 회차가 기다리고 있어요"
          description="원하는 내용을 적거나 바로 다음으로 넘어가세요. AI가 제목과 전개 방향을 만들어요."
          action={<Button onClick={() => setCreatorOpen(true)}><FilePlus2 className="size-4" /> 첫 회차 만들기</Button>}
        />
      ) : null}
      {editing && !items.length ? (
        <p className="empty-state">모든 빈 회차를 삭제했어요. 완료를 누르면 저장됩니다.</p>
      ) : null}

      {items.length ? editing ? (
        <DragDropProvider
          onDragStart={() => setDragging(true)}
          onDragEnd={(event) => {
            setDragging(false);
            if (event.canceled) return;
            setDraft((current) => current ? { ...current, items: move(current.items, event) } : current);
          }}
        >
          <section className="episode-list episode-list-editing" aria-label="회차 목록" aria-busy={busy}>
            {items.map((item, index) => (
              <SortableEpisodeRow
                key={item.id} item={item} index={index} number={items.length - index} disabled={busy}
                deleteDisabled={locked}
                onRemove={() => setDraft((current) => current ? {
                  ...current, items: current.items.filter((slot) => slot.id !== item.id),
                } : current)}
              />
            ))}
          </section>
        </DragDropProvider>
      ) : (
        <section className="episode-list" aria-label="회차 목록">
          {items.map((item, index) => (
            <article className={`episode-row${item.episode ? '' : ' episode-placeholder'}`} key={item.id}>
              {item.episode ? (
                <Link className="episode-row-link" to={`${item.episode.id}`}>
                  <EpisodeRowContent episode={item.episode} number={items.length - index} />
                </Link>
              ) : (
                <div className="episode-row-content"><EpisodeRowContent episode={null} number={items.length - index} /></div>
              )}
              {item.episode ? (
                <DropdownMenu.Root>
                  <DropdownMenu.Trigger asChild>
                    <IconButton label={`${items.length - index}화 메뉴`} className="shrink-0">
                      <Ellipsis className="size-5" />
                    </IconButton>
                  </DropdownMenu.Trigger>
                  <DropdownMenu.Portal>
                    <DropdownMenu.Content className="dropdown-content" align="end" sideOffset={6}>
                      <DropdownMenu.Item className="dropdown-item text-red-700" onSelect={() => setDeleting(item.episode)}>
                        <Trash2 className="size-4" /> 회차 삭제
                      </DropdownMenu.Item>
                    </DropdownMenu.Content>
                  </DropdownMenu.Portal>
                </DropdownMenu.Root>
              ) : null}
            </article>
          ))}
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

function SortableEpisodeRow({ item, index, number, disabled, deleteDisabled, onRemove }: {
  item: EpisodeSlot;
  index: number;
  number: number;
  disabled: boolean;
  deleteDisabled: boolean;
  onRemove: () => void;
}) {
  const { ref, handleRef, isDragSource } = useSortable({ id: item.id, index, disabled });
  return (
    <article
      ref={ref}
      className={`episode-row episode-row-editing${item.episode ? '' : ' episode-placeholder'}${isDragSource ? ' episode-row-dragging' : ''}`}
    >
      <button
        ref={handleRef} type="button" className="icon-button episode-drag-handle" disabled={disabled}
        aria-label={`${number}화 ${item.episode?.title || '빈 회차'} 순서 이동`}
        aria-describedby="episode-order-instructions"
      ><GripVertical className="size-5" aria-hidden="true" /></button>
      <div className="episode-row-content"><EpisodeRowContent episode={item.episode} number={number} /></div>
      {!item.episode ? (
        <IconButton label={`${number}화 빈 회차 삭제`} disabled={deleteDisabled} className="shrink-0 text-red-700" onClick={onRemove}>
          <Trash2 className="size-4" />
        </IconButton>
      ) : null}
    </article>
  );
}

function EpisodeRowContent({ episode, number }: { episode: Episode | null; number: number }) {
  const summaryFresh = episode?.summary?.sourceRevision === episode?.revision && !episode?.summary?.stale;
  return (
    <>
      <div className="episode-number">{number}<small>화</small></div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <h2>{episode ? episode.title || '제목 없는 회차' : '빈 회차'}</h2>
          {episode ? summaryFresh ? (
            <Badge tone="sage"><CheckCircle2 className="size-3" /> 기억 최신</Badge>
          ) : (
            <Badge tone="warning"><AlertTriangle className="size-3" /> 기억 갱신 필요</Badge>
          ) : null}
        </div>
        <p className="mt-1 line-clamp-1 text-sm text-muted">{episode
          ? episode.direction || episode.summary?.events[0] || '전개 방향이 아직 없습니다.'
          : '작성된 내용이 없는 회차예요.'}</p>
        {episode ? <p className="mt-3 text-xs text-muted">{characterCount(episode.content)}자 · {formatRelativeDate(episode.updatedAt)}</p> : null}
      </div>
    </>
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
  const [instruction, setInstruction] = useState('');
  const [preview, setPreview] = useState('');
  const [phase, setPhase] = useState<AiPhase>('idle');
  const [issues, setIssues] = useState<ContinuityIssue[]>([]);
  const [proposalConflicts, setProposalConflicts] = useState<string[]>([]);
  const [blocked, setBlocked] = useState(false);
  const [error, setError] = useState('');
  const abortRef = useRef<AbortController | null>(null);
  const proposedHintRef = useRef<string | null>(null);
  const idempotencyKeyRef = useRef(createIdempotencyKey());

  const proposeMutation = useMutation({
    mutationFn: ({ hint, signal }: { hint: string; signal: AbortSignal }) =>
      api.episodes.propose(projectId, hint || undefined, signal),
    onSuccess: (proposal, { hint, signal }) => {
      if (signal.aborted) return;
      proposedHintRef.current = hint;
      setTitle(proposal.title);
      setDirection(proposal.direction);
      setProposalConflicts(proposal.conflicts ?? []);
      setInstruction('');
      setError('');
      setStep('direction');
    },
    onError: (reason, { signal }) => {
      if (!signal.aborted) setError(messageOf(reason));
    },
  });
  const refineMutation = useMutation({
    mutationFn: ({ input, signal }: {
      input: { title: string; direction: string; instruction: string };
      signal: AbortSignal;
    }) => api.episodes.refine(projectId, input, signal),
    onSuccess: (proposal, { signal }) => {
      if (signal.aborted) return;
      setTitle(proposal.title);
      setDirection(proposal.direction);
      setProposalConflicts(proposal.conflicts ?? []);
      setInstruction('');
      setError('');
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
      queryClient.invalidateQueries({ queryKey: ['episode-order', projectId] });
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      onOpenChange(false);
    },
    onError: (reason) => setError(messageOf(reason)),
  });
  const repair = useContinuityRepair({
    request: (issue, onEvent, signal) => api.episodes.repair(
      projectId,
      { title: title.trim(), direction: direction.trim(), content: preview, issue },
      onEvent,
      signal,
    ),
    onSuccess: (result) => {
      setPreview(result.content);
      setIssues(result.issues);
      setBlocked(result.blocked);
      setPhase('done');
    },
  });

  useEffect(() => () => abortRef.current?.abort(), []);

  const next = () => {
    if (proposeMutation.isPending || refineMutation.isPending || createMutation.isPending) return;
    if (proposedHintRef.current === hint.trim()) {
      setError('');
      setStep('direction');
      return;
    }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    refineMutation.reset();
    setError('');
    proposeMutation.mutate({ hint: hint.trim(), signal: controller.signal });
  };

  const refine = () => {
    if (refineMutation.isPending || createMutation.isPending) return;
    if (!title.trim() || !direction.trim() || !instruction.trim()) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setError('');
    refineMutation.mutate({
      input: { title, direction, instruction: instruction.trim() },
      signal: controller.signal,
    });
  };

  const generate = async () => {
    if (repair.isRepairing || createMutation.isPending || refineMutation.isPending) return;
    if (!title.trim() || !direction.trim()) {
      setError('제목과 전개 방향을 먼저 확인해 주세요.');
      return;
    }
    abortRef.current?.abort();
    repair.reset();
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
            setPhase((current) => current === 'repairing' || current === 'checking' ? current : 'writing');
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
      <Button variant="ghost" disabled={createMutation.isPending || refineMutation.isPending} onClick={() => { setStep('request'); setError(''); }}>이전</Button>
      <Button variant="secondary" disabled={!title.trim() || !direction.trim() || refineMutation.isPending} busy={createMutation.isPending} onClick={() => createMutation.mutate(false)}>
        빈 회차로 시작
      </Button>
      <Button disabled={!title.trim() || !direction.trim() || createMutation.isPending || refineMutation.isPending} onClick={() => void generate()}>
        <Sparkles className="size-4" /> AI 초안 만들기
      </Button>
    </div>
  ) : isGenerating || repair.isRepairing ? (
    <div className="action-row">
      <Button variant="secondary" onClick={() => repair.isRepairing ? repair.cancel() : abortRef.current?.abort()}>
        {repair.isRepairing ? '수정 중단' : '생성 중단'}
      </Button>
    </div>
  ) : (
    <div className="action-row">
      <Button variant="ghost" disabled={createMutation.isPending} onClick={() => { repair.reset(); setStep('direction'); setPreview(''); setIssues([]); setPhase('idle'); setError(''); }}>제목·방향 확인</Button>
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
        if (!next && repair.isRepairing && !window.confirm('수정을 중단하고 닫을까요?')) return;
        if (!next && isGenerating && !window.confirm('생성을 중단하고 닫을까요?')) return;
        if (!next) {
          abortRef.current?.abort();
          repair.reset();
        }
        onOpenChange(next);
      }}
      title="새 회차 만들기"
      description={step === 'request' ? '원하는 내용이 있으면 적어 주세요. 비워 두어도 괜찮아요.' : step === 'direction' ? '제목과 전개 방향을 직접 고치거나, 개선 요청을 적어 여러 번 다듬어 보세요.' : '완성된 초안을 확인하고 저장하세요.'}
      footer={footer}
      bodyHeader={step === 'draft' ? <DraftGenerationStatus phase={repair.phase ?? phase} /> : undefined}
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
          <DraftPreview
            label="AI 초안 수정"
            value={preview}
            onChange={setPreview}
            readOnly={isGenerating || repair.isRepairing}
            disabled={createMutation.isPending}
            placeholder="이야기의 흐름과 설정을 살펴보고 있어요…"
          />
          <ContinuityIssues
            issues={issues}
            blocked={blocked}
            heading={blocked ? '저장 전 반드시 검토하세요' : '이어짐을 확인해 주세요'}
            onRepair={(issue, index) => { setError(''); void repair.repair(issue, index); }}
            repairingIndex={repair.repairingIndex}
            disabled={isGenerating || createMutation.isPending || !preview.trim()}
          />
        </div>
      ) : (
        <div className="space-y-6">
          <div>
            <label className="field-label" htmlFor="episode-title">회차 제목</label>
            <input id="episode-title" className="input" maxLength={200} disabled={createMutation.isPending || refineMutation.isPending} value={title} onChange={(event) => setTitle(event.target.value)} />
          </div>
          <div>
            <label className="field-label" htmlFor="episode-direction">전개 방향</label>
            <textarea id="episode-direction" className="input" rows={10} maxLength={20000} disabled={createMutation.isPending || refineMutation.isPending} value={direction} onChange={(event) => setDirection(event.target.value)} />
          </div>
          {proposalConflicts.length ? (
            <div className="warning-box" role="alert">
              <strong>확인할 설정 충돌</strong>
              <ul>{proposalConflicts.map((conflict, index) => <li key={`${conflict}-${index}`}>{conflict}</li>)}</ul>
            </div>
          ) : null}
          <form onSubmit={(event) => { event.preventDefault(); refine(); }}>
            <label className="field-label" htmlFor="episode-refinement">개선 요청</label>
            <textarea
              id="episode-refinement"
              className="input"
              rows={3}
              maxLength={5000}
              value={instruction}
              disabled={createMutation.isPending || refineMutation.isPending}
              onChange={(event) => setInstruction(event.target.value)}
              aria-describedby="episode-refinement-help"
              placeholder="예: 제목은 그대로 두고, 마지막 장면의 긴장감만 높여 줘"
            />
            <p id="episode-refinement-help" className="field-hint">현재 제목과 전개 방향에서 요청한 부분만 다듬어요. 개선된 결과에 요청을 더해 계속 개선할 수 있어요.</p>
            <div className="action-row mt-3">
              <Button
                type="submit"
                variant="secondary"
                busy={refineMutation.isPending}
                disabled={!instruction.trim() || !title.trim() || !direction.trim() || createMutation.isPending}
              >
                {!refineMutation.isPending ? <Sparkles className="size-4" /> : null}
                {refineMutation.isPending ? '개선 중' : '개선'}
              </Button>
            </div>
            {refineMutation.isPending ? (
              <p className="generation-status mt-3" role="status">현재 제목과 전개 방향에 개선 요청을 반영하고 있어요.</p>
            ) : refineMutation.isSuccess ? (
              <p className="field-hint mt-3" role="status">개선 요청을 반영했어요. 더 다듬고 싶은 부분이 있으면 다시 요청해 주세요.</p>
            ) : null}
          </form>
        </div>
      )}
      <FieldError>{error}</FieldError>
      <FieldError>{repair.error}</FieldError>
    </Sheet>
  );
}
