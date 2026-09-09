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
  ChevronDown,
  Ellipsis,
  FilePlus2,
  GitBranch,
  GripVertical,
  Library,
  Pencil,
  Plus,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { Link, useNavigate, useOutletContext, useParams, useSearchParams } from 'react-router-dom';
import { api, isConflict, messageOf } from '../api/client';
import { MILESTONE_TYPE_LABELS } from '../arcPlan';
import { characterCount, createIdempotencyKey, formatRelativeDate } from '../lib';
import type { Arc, CreateSideStoryGroupInput, Episode, SideStoryCollection, SideStoryGroup } from '../types';
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
type SideStoryCreatorState = { initialEpisode: Episode | null; initialGroupId: string | null };

function isSideStory(episode: Episode): boolean {
  return episode.kind === 'SIDE_STORY';
}

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
  const [sideStoryCreator, setSideStoryCreator] = useState<SideStoryCreatorState | null>(null);
  const [resumingEpisode, setResumingEpisode] = useState<Episode | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const [pendingCanonCount, setPendingCanonCount] = useState(0);
  const [deleting, setDeleting] = useState<Episode | null>(null);
  const [draft, setDraft] = useState<OrderDraft | null>(null);
  const [dragging, setDragging] = useState(false);
  const orderQuery = useQuery({
    queryKey: ['episode-order', projectId],
    queryFn: () => api.episodes.order(projectId),
    enabled: !draft,
  });
  const sideStoriesQuery = useQuery({
    queryKey: ['side-stories', projectId],
    queryFn: () => api.sideStories.list(projectId),
  });
  const checkCanonMutation = useMutation({
    mutationFn: async () => {
      const entries = await queryClient.fetchQuery({
        queryKey: ['canon', projectId],
        queryFn: () => api.canon.list(projectId),
        staleTime: 0,
        retry: false,
      });
      return entries.filter((entry) => entry.status === 'PENDING').length;
    },
    onSuccess: (count) => {
      setPendingCanonCount(count);
      if (!count) {
        setResumingEpisode(null);
        setCreatorOpen(true);
      }
    },
  });
  const invalidateEpisodes = () => {
    void queryClient.invalidateQueries({ queryKey: ['episodes', projectId] });
    void queryClient.invalidateQueries({ queryKey: ['episode-flow', projectId] });
    void queryClient.invalidateQueries({ queryKey: ['scene', projectId] });
    void queryClient.invalidateQueries({ queryKey: ['arcs', projectId] });
    void queryClient.invalidateQueries({ queryKey: ['arc', projectId] });
    void queryClient.invalidateQueries({ queryKey: ['side-stories', projectId] });
    void queryClient.invalidateQueries({ queryKey: ['side-story-groups', projectId] });
    void queryClient.invalidateQueries({ queryKey: ['side-story-group', projectId] });
    void queryClient.invalidateQueries({ queryKey: ['projects'] });
  };
  const deleteMutation = useMutation({
    mutationFn: (episode: Episode) => api.episodes.remove(projectId, episode.id, episode.revision),
    onSuccess: (_result, episode) => {
      if (isSideStory(episode)) {
        void queryClient.invalidateQueries({ queryKey: ['side-stories', projectId] });
        if (episode.sideStoryGroupId) {
          void queryClient.invalidateQueries({ queryKey: ['side-story-group', projectId, episode.sideStoryGroupId] });
          void queryClient.invalidateQueries({ queryKey: ['side-story-groups', projectId] });
        }
      } else {
        invalidateEpisodes();
        void queryClient.invalidateQueries({ queryKey: ['episode-order', projectId] });
      }
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
  useEffect(() => {
    const resumeId = searchParams.get('resume');
    if (!resumeId || !orderQuery.data || orderQuery.isFetching) return;
    const episode = orderQuery.data.episodes.find((item) => item.id === resumeId);
    if (episode?.status === 'INCOMPLETE') {
      setResumingEpisode(episode);
      setCreatorOpen(true);
    }
    setSearchParams((params) => {
      params.delete('resume');
      return params;
    }, { replace: true });
  }, [orderQuery.data, orderQuery.isFetching, searchParams, setSearchParams]);
  useEffect(() => {
    const resumeId = searchParams.get('resumeSideStory');
    if (!resumeId || !sideStoriesQuery.data || sideStoriesQuery.isFetching) return;
    const episodes = [
      ...sideStoriesQuery.data.standalone,
      ...sideStoriesQuery.data.groups.flatMap((group) => group.episodes),
    ];
    const episode = episodes.find((item) => item.id === resumeId);
    if (episode?.status === 'INCOMPLETE') {
      setSideStoryCreator({ initialEpisode: episode, initialGroupId: episode.sideStoryGroupId ?? null });
    }
    setSearchParams((params) => {
      params.delete('resumeSideStory');
      return params;
    }, { replace: true });
  }, [searchParams, setSearchParams, sideStoriesQuery.data, sideStoriesQuery.isFetching]);

  const items = draft?.items ?? (orderQuery.data ? orderItems(orderQuery.data) : []);
  const editing = draft !== null;
  const busy = saveMutation.isPending || reloadMutation.isPending;
  const locked = busy || dragging;
  const conflict = isConflict(saveMutation.error);
  const openCreator = () => {
    if (!editing && !checkCanonMutation.isPending) checkCanonMutation.mutate();
  };
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
              disabled={!orderQuery.data || !items.length || orderQuery.isFetching || deleteMutation.isPending || checkCanonMutation.isPending}
              onClick={() => {
                if (!orderQuery.data) return;
                saveMutation.reset();
                reloadMutation.reset();
                setDraft({ items: orderItems(orderQuery.data), revision: orderQuery.data.revision });
              }}
            ><Pencil className="size-4" /> 수정</Button>
          )}
          <Button disabled={editing} busy={checkCanonMutation.isPending} onClick={openCreator}>
            <Plus className="size-4" /> 새 회차
          </Button>
          <Button
            variant="secondary"
            disabled={editing || sideStoriesQuery.isFetching}
            onClick={() => setSideStoryCreator({ initialEpisode: null, initialGroupId: null })}
          >
            <FilePlus2 className="size-4" /> 새 외전
          </Button>
        </div>
      </header>

      {checkCanonMutation.isError ? (
        <ErrorState
          message={`검토 중인 정사를 확인하지 못했어요. ${messageOf(checkCanonMutation.error)}`}
          onRetry={openCreator}
        />
      ) : null}
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
          action={<Button busy={checkCanonMutation.isPending} onClick={openCreator}><FilePlus2 className="size-4" /> 첫 회차 만들기</Button>}
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
              {item.episode?.status === 'INCOMPLETE' ? (
                <button type="button" className="episode-row-link text-left" onClick={() => {
                  setResumingEpisode(item.episode);
                  setCreatorOpen(true);
                }}>
                  <EpisodeRowContent episode={item.episode} number={items.length - index} />
                </button>
              ) : item.episode ? (
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

      {!editing ? <SideStorySection
        projectId={projectId}
        mainEpisodes={orderQuery.data?.episodes ?? []}
        data={sideStoriesQuery.data}
        pending={sideStoriesQuery.isPending}
        error={sideStoriesQuery.isError ? messageOf(sideStoriesQuery.error) : ''}
        onRetry={() => sideStoriesQuery.refetch()}
        onCreate={(groupId = null) => setSideStoryCreator({ initialEpisode: null, initialGroupId: groupId })}
        onResume={(episode) => setSideStoryCreator({ initialEpisode: episode, initialGroupId: episode.sideStoryGroupId ?? null })}
        onDelete={setDeleting}
      /> : null}

      {creatorOpen ? <CreateEpisodeSheet open={creatorOpen} onOpenChange={setCreatorOpen} projectId={projectId} initialEpisode={resumingEpisode} /> : null}
      {sideStoryCreator ? (
        <CreateSideStorySheet
          key={sideStoryCreator.initialEpisode?.id ?? `new:${sideStoryCreator.initialGroupId ?? 'standalone'}`}
          open
          onOpenChange={(open) => { if (!open) setSideStoryCreator(null); }}
          projectId={projectId}
          initialEpisode={sideStoryCreator.initialEpisode}
          initialGroupId={sideStoryCreator.initialGroupId}
          mainEpisodes={orderQuery.data?.episodes ?? []}
          groups={sideStoriesQuery.data?.groups ?? []}
        />
      ) : null}
      <ConfirmDialog
        open={pendingCanonCount > 0}
        onOpenChange={(open) => !open && setPendingCanonCount(0)}
        title="검토 중인 정사가 있어요"
        description={`검토 중인 정사 ${pendingCanonCount}개는 승인 전까지 새 회차 집필의 정사 자료에 포함되지 않아요. 먼저 정사를 검토하거나 그대로 회차 만들기를 진행할 수 있어요.`}
        confirmLabel="계속 만들기"
        confirmVariant="primary"
        extraAction={<Link className="button button-secondary button-md" to={`/projects/${projectId}/canon?status=PENDING`}>정사 검토하기</Link>}
        onConfirm={() => {
          setPendingCanonCount(0);
          setResumingEpisode(null);
          setCreatorOpen(true);
        }}
      />
      <ConfirmDialog
        open={Boolean(deleting)}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`${deleting ? episodeLabel(deleting) : ''} 삭제할까요?`}
        description="본문과 요약이 삭제되고 검색 기억에서도 제외됩니다. 이 작업은 되돌릴 수 없습니다."
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
          {episode?.status === 'INCOMPLETE' ? (
            <Badge tone="warning">미완성</Badge>
          ) : episode ? summaryFresh ? (
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

function episodeLabel(episode: Episode): string {
  if (isSideStory(episode)) return episode.number ? `외전 ${episode.number}화` : '단편 외전';
  return `${episode.number ?? ''}화`;
}

function SideStorySection({
  projectId,
  mainEpisodes,
  data,
  pending,
  error,
  onRetry,
  onCreate,
  onResume,
  onDelete,
}: {
  projectId: string;
  mainEpisodes: Episode[];
  data?: SideStoryCollection;
  pending: boolean;
  error: string;
  onRetry: () => void;
  onCreate: (groupId?: string | null) => void;
  onResume: (episode: Episode) => void;
  onDelete: (episode: Episode) => void;
}) {
  const standalone = [...(data?.standalone ?? [])].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const groups = data?.groups ?? [];
  return (
    <section className="side-story-section" aria-labelledby="side-story-heading">
      <div className="side-story-section-heading">
        <div>
          <p className="eyebrow">본편과 독립된 이야기</p>
          <h2 className="section-title text-2xl" id="side-story-heading">외전</h2>
        </div>
        <Button variant="secondary" size="sm" onClick={() => onCreate()}>
          <Plus className="size-4" /> 새 외전
        </Button>
      </div>
      {pending ? <SkeletonCards count={2} /> : null}
      {error ? <ErrorState message={error} onRetry={onRetry} /> : null}
      {!pending && !error && !standalone.length && !groups.length ? (
        <div className="side-story-empty">
          <BookOpenText className="size-5" />
          <p>아직 외전이 없어요. 정사만 바탕으로 시작하거나 본편의 한 회차에서 갈라진 이야기를 써 보세요.</p>
        </div>
      ) : null}

      {standalone.length ? (
        <section className="side-story-block" aria-label="단편 외전 목록">
          <div className="side-story-block-heading">
            <div><h3>단편 외전</h3><p>그룹 흐름과 번호 없이 독립적으로 쓰는 이야기</p></div>
          </div>
          <div className="episode-list">
            {standalone.map((episode) => (
              <SideStoryRow key={episode.id} projectId={projectId} episode={episode} onResume={onResume} onDelete={onDelete} />
            ))}
          </div>
        </section>
      ) : null}

      {groups.map((group) => (
        <SideStoryGroupBlock
          key={group.id}
          projectId={projectId}
          group={group}
          mainEpisodes={mainEpisodes}
          onCreate={() => onCreate(group.id)}
          onResume={onResume}
          onDelete={onDelete}
        />
      ))}
    </section>
  );
}

function SideStoryGroupBlock({
  projectId,
  group,
  mainEpisodes,
  onCreate,
  onResume,
  onDelete,
}: {
  projectId: string;
  group: SideStoryGroup & { episodes: Episode[] };
  mainEpisodes: Episode[];
  onCreate: () => void;
  onResume: (episode: Episode) => void;
  onDelete: (episode: Episode) => void;
}) {
  const anchor = mainEpisodes.find((episode) => episode.id === group.branchFromEpisodeId);
  const episodes = [...group.episodes].sort((a, b) => (b.number ?? 0) - (a.number ?? 0));
  return (
    <section className="side-story-block side-story-group" aria-labelledby={`side-story-group-${group.id}`}>
      <div className="side-story-group-heading">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 id={`side-story-group-${group.id}`}>{group.title}</h3>
            <Badge tone="plum">외전 그룹</Badge>
          </div>
          {group.description ? <p className="mt-1 text-sm leading-6 text-muted">{group.description}</p> : null}
        </div>
        <Button variant="secondary" size="sm" onClick={onCreate}><Plus className="size-4" /> 이 그룹에 새 외전</Button>
      </div>
      <div className="side-story-context-grid">
        <div><GitBranch className="size-4" /><span><strong>분기</strong>{anchor ? `${anchor.number}화 · ${anchor.title}` : group.branchFromEpisodeId ? '선택한 본편 회차' : '프로젝트 정사만'}</span></div>
        <div><Library className="size-4" /><span><strong>그룹 정사</strong>{group.canon.length ? `${group.canon.length}개` : '등록된 정사 없음'}</span></div>
        <div><BookOpenText className="size-4" /><span><strong>그룹 아크</strong>{group.arc?.title ?? '아크 없음'}</span></div>
      </div>
      {group.arc ? (
        <>
          <p className="side-story-arc-summary">{group.arc.goal} · {group.arc.conflict}</p>
          <SideStoryArcDetails arc={group.arc} groupTitle={group.title} />
        </>
      ) : null}
      {episodes.length ? (
        <div className="episode-list" aria-label={`${group.title} 외전 목록`}>
          {episodes.map((episode) => (
            <SideStoryRow key={episode.id} projectId={projectId} episode={episode} onResume={onResume} onDelete={onDelete} />
          ))}
        </div>
      ) : <p className="side-story-empty compact">이 그룹의 첫 외전을 만들어 흐름을 시작하세요.</p>}
    </section>
  );
}

function SideStoryArcDetails({ arc, groupTitle }: { arc: Arc; groupTitle: string }) {
  const milestones = [...(arc.milestones ?? [])].sort((left, right) => left.episode - right.episode);
  const episodeDirections = [...(arc.episodeDirections ?? [])].sort((left, right) => left.episode - right.episode);
  return (
    <details className="group mt-3 rounded-xl border border-line bg-paper">
      <summary
        aria-label={`${groupTitle} 회차별 아크 계획`}
        className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-3 py-2 text-sm font-bold text-plum-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-plum-500 [&::-webkit-details-marker]:hidden"
      >
        <ChevronDown aria-hidden="true" className="size-4 shrink-0 transition-transform group-open:rotate-180" />
        <span>회차별 아크 계획</span>
        <span className="ml-auto text-xs font-medium text-muted">{arc.startEpisode}–{arc.endEpisode}화</span>
      </summary>
      <div className="grid gap-4 border-t border-line px-3 py-3 text-sm lg:grid-cols-2">
        <section aria-label={`${groupTitle} 마일스톤`}>
          <h4 className="font-bold">마일스톤</h4>
          {milestones.length ? (
            <ul className="mt-2 space-y-2">
              {milestones.map((milestone, index) => (
                <li className="leading-6" key={milestone.id ?? `${milestone.episode}-${milestone.type}-${index}`}>
                  <strong>{milestone.episode}화 · {MILESTONE_TYPE_LABELS[milestone.type]}</strong>
                  <span className="block whitespace-pre-wrap text-muted">{milestone.description}</span>
                </li>
              ))}
            </ul>
          ) : <p className="mt-2 text-muted">등록된 마일스톤이 없습니다.</p>}
        </section>
        <section aria-label={`${groupTitle} 회차별 전개`}>
          <h4 className="font-bold">회차별 전개</h4>
          {episodeDirections.length ? (
            <ol className="mt-2 space-y-2">
              {episodeDirections.map((item) => (
                <li className="leading-6" key={item.episode}>
                  <strong>{item.episode}화 · {item.title}</strong>
                  <span className="block whitespace-pre-wrap text-muted">{item.direction}</span>
                </li>
              ))}
            </ol>
          ) : <p className="mt-2 text-muted">등록된 회차별 전개가 없습니다.</p>}
        </section>
      </div>
    </details>
  );
}

function SideStoryRow({
  projectId,
  episode,
  onResume,
  onDelete,
}: {
  projectId: string;
  episode: Episode;
  onResume: (episode: Episode) => void;
  onDelete: (episode: Episode) => void;
}) {
  const label = episodeLabel(episode);
  const content = (
    <>
      <div className={`episode-number side-story-number${episode.number ? '' : ' standalone'}`}>
        {episode.number ? <>{episode.number}<small>화</small></> : <span>단편</span>}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <h4>{episode.title || '제목 없는 외전'}</h4>
          {episode.status === 'INCOMPLETE' ? <Badge tone="warning">미완성</Badge> : null}
        </div>
        <p className="mt-1 line-clamp-1 text-sm text-muted">{episode.direction || '전개 방향이 아직 없습니다.'}</p>
        <p className="mt-3 text-xs text-muted">{label} · {characterCount(episode.content)}자 · {formatRelativeDate(episode.updatedAt)}</p>
      </div>
    </>
  );
  return (
    <article className="episode-row">
      {episode.status === 'INCOMPLETE' ? (
        <button type="button" className="episode-row-link text-left" onClick={() => onResume(episode)}>{content}</button>
      ) : (
        <Link className="episode-row-link" to={`/projects/${projectId}/episodes/${episode.id}`}>{content}</Link>
      )}
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <IconButton label={`${label} 메뉴`} className="shrink-0"><Ellipsis className="size-5" /></IconButton>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content className="dropdown-content" align="end" sideOffset={6}>
            <DropdownMenu.Item className="dropdown-item text-red-700" onSelect={() => onDelete(episode)}>
              <Trash2 className="size-4" /> 외전 삭제
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </article>
  );
}

type SideStoryTarget = 'STANDALONE' | 'EXISTING_GROUP' | 'NEW_GROUP';
type SideStoryOrigin = 'CANON_ONLY' | 'EPISODE';

function CreateSideStorySheet({
  open,
  onOpenChange,
  projectId,
  initialEpisode,
  initialGroupId,
  mainEpisodes,
  groups,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  initialEpisode: Episode | null;
  initialGroupId: string | null;
  mainEpisodes: Episode[];
  groups: SideStoryGroup[];
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const orderedMainEpisodes = [...mainEpisodes].sort((a, b) => (a.number ?? 0) - (b.number ?? 0));
  const [step, setStep] = useState<'setup' | 'request' | 'direction'>(initialEpisode ? 'direction' : initialGroupId ? 'request' : 'setup');
  const [target, setTarget] = useState<SideStoryTarget>(initialGroupId ? 'EXISTING_GROUP' : 'STANDALONE');
  const [selectedGroupId, setSelectedGroupId] = useState(initialGroupId ?? '');
  const [origin, setOrigin] = useState<SideStoryOrigin>(initialEpisode?.branchFromEpisodeId ? 'EPISODE' : 'CANON_ONLY');
  const [branchFromEpisodeId, setBranchFromEpisodeId] = useState(initialEpisode?.branchFromEpisodeId ?? '');
  const [groupTitle, setGroupTitle] = useState('');
  const [groupDescription, setGroupDescription] = useState('');
  const [groupCanon, setGroupCanon] = useState('');
  const [arcTitle, setArcTitle] = useState('');
  const [arcGoal, setArcGoal] = useState('');
  const [arcConflict, setArcConflict] = useState('');
  const [arcEndEpisode, setArcEndEpisode] = useState('');
  const [createdGroup, setCreatedGroup] = useState<SideStoryGroup | null>(null);
  const [title, setTitle] = useState(initialEpisode?.title ?? '');
  const [direction, setDirection] = useState(initialEpisode?.direction ?? '');
  const [hint, setHint] = useState('');
  const [instruction, setInstruction] = useState('');
  const [proposalConflicts, setProposalConflicts] = useState<string[]>([]);
  const [error, setError] = useState('');
  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(false);
  const proposedHintRef = useRef<string | null>(initialEpisode ? '' : null);
  const episodeRef = useRef(initialEpisode);
  const idempotencyKeyRef = useRef(createIdempotencyKey());
  const groupIdempotencyKeyRef = useRef(createIdempotencyKey());
  const groupCreateInputRef = useRef<CreateSideStoryGroupInput | null>(null);
  const createInputRef = useRef<{
    title: string;
    direction: string;
    content: string;
    incomplete: boolean;
    groupId: string | null;
    branchFromEpisodeId: string | null;
  } | null>(null);

  const groupId = initialEpisode?.sideStoryGroupId ?? createdGroup?.id ?? (target === 'EXISTING_GROUP' ? selectedGroupId || null : null);
  const branchId = groupId ? null : origin === 'EPISODE' ? branchFromEpisodeId || null : null;
  const virtualContext = {
    kind: 'SIDE_STORY' as const,
    sideStoryGroupId: groupId,
    branchFromEpisodeId: branchId,
  };

  const cacheEpisode = (episode: Episode) => {
    episodeRef.current = episode;
    queryClient.setQueryData(['episodes', projectId, episode.id], episode);
    void queryClient.invalidateQueries({ queryKey: ['side-stories', projectId] });
    if (episode.sideStoryGroupId) {
      void queryClient.invalidateQueries({ queryKey: ['side-story-group', projectId, episode.sideStoryGroupId] });
      void queryClient.invalidateQueries({ queryKey: ['side-story-groups', projectId] });
    }
  };
  const groupMutation = useMutation({
    mutationFn: (input: CreateSideStoryGroupInput) =>
      api.sideStoryGroups.create(projectId, input, groupIdempotencyKeyRef.current),
    onSuccess: (group) => {
      setCreatedGroup(group);
      setSelectedGroupId(group.id);
      void queryClient.invalidateQueries({ queryKey: ['side-stories', projectId] });
      void queryClient.invalidateQueries({ queryKey: ['side-story-groups', projectId] });
    },
    onError: (reason) => setError(messageOf(reason)),
  });
  const saveMutation = useMutation({
    mutationFn: async ({ title, direction, incomplete = true }: { title: string; direction: string; incomplete?: boolean }) => {
      const plan = { title: title.trim(), direction: direction.trim() };
      if (!plan.title || !plan.direction) throw new Error('제목과 전개 방향을 먼저 확인해 주세요.');
      let episode = episodeRef.current;
      if (!episode) {
        createInputRef.current ??= {
          ...plan,
          content: '',
          incomplete: true,
          groupId,
          branchFromEpisodeId: branchId,
        };
        episode = await api.sideStories.create(projectId, createInputRef.current, idempotencyKeyRef.current);
        cacheEpisode(episode);
      }
      if (episode.title !== plan.title || episode.direction !== plan.direction || (episode.status === 'INCOMPLETE') !== incomplete) {
        episode = await api.episodes.update(projectId, episode.id, {
          ...plan,
          expectedRevision: episode.revision,
          incomplete,
        });
        cacheEpisode(episode);
      }
      return episode;
    },
    onError: (reason) => setError(messageOf(reason)),
  });
  const planContext = () => episodeRef.current ? {
    episodeId: episodeRef.current.id,
    expectedRevision: episodeRef.current.revision,
  } : virtualContext;
  const proposeMutation = useMutation({
    mutationFn: ({ hint, signal }: { hint: string; signal: AbortSignal }) =>
      api.episodes.propose(projectId, hint || undefined, signal, planContext()),
    onSuccess: async (proposal, { hint, signal }) => {
      if (signal.aborted) return;
      proposedHintRef.current = hint;
      setTitle(proposal.title);
      setDirection(proposal.direction);
      setProposalConflicts(proposal.conflicts ?? []);
      setInstruction('');
      setError('');
      setStep('direction');
      await saveMutation.mutateAsync(proposal).catch(() => undefined);
    },
    onError: (reason, { signal }) => { if (!signal.aborted) setError(messageOf(reason)); },
  });
  const refineMutation = useMutation({
    mutationFn: ({ input, signal }: {
      input: { title: string; direction: string; instruction: string };
      signal: AbortSignal;
    }) => api.episodes.refine(projectId, { ...input, ...planContext() }, signal),
    onSuccess: async (proposal, { signal }) => {
      if (signal.aborted) return;
      setTitle(proposal.title);
      setDirection(proposal.direction);
      setProposalConflicts(proposal.conflicts ?? []);
      setInstruction('');
      setError('');
      await saveMutation.mutateAsync(proposal).catch(() => undefined);
    },
    onError: (reason, { signal }) => { if (!signal.aborted) setError(messageOf(reason)); },
  });

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; abortRef.current?.abort(); };
  }, []);

  const busy = groupMutation.isPending || proposeMutation.isPending || refineMutation.isPending || saveMutation.isPending;
  const groupSetupLocked = Boolean(groupCreateInputRef.current);
  const setupValid = target === 'STANDALONE'
    ? origin === 'CANON_ONLY' || Boolean(branchFromEpisodeId)
    : target === 'EXISTING_GROUP'
      ? Boolean(selectedGroupId)
      : Boolean(groupTitle.trim() && groupCanon.trim() && arcTitle.trim() && arcGoal.trim() && arcConflict.trim()
        && (origin === 'CANON_ONLY' || branchFromEpisodeId));
  const completeSetup = async () => {
    if (busy || !setupValid) return;
    setError('');
    if (target === 'NEW_GROUP' && !createdGroup) {
      const parsedEndEpisode = Number.parseInt(arcEndEpisode, 10);
      const endEpisodeNumber = Number.isFinite(parsedEndEpisode) && parsedEndEpisode > 0 ? parsedEndEpisode : 5;
      groupCreateInputRef.current ??= {
        title: groupTitle.trim(),
        description: groupDescription.trim() || undefined,
        branchFromEpisodeId: origin === 'EPISODE' ? branchFromEpisodeId : null,
        canon: groupCanon.trim(),
        arc: {
          title: arcTitle.trim(),
          goal: arcGoal.trim(),
          conflict: arcConflict.trim(),
          endEpisodeNumber,
          milestones: [{ episode: endEpisodeNumber, type: 'GOAL', description: arcGoal.trim() }],
        },
      };
      try {
        await groupMutation.mutateAsync(groupCreateInputRef.current);
      } catch {
        return;
      }
    }
    setStep('request');
  };
  const next = () => {
    if (busy) return;
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
    if (busy || !title.trim() || !direction.trim() || !instruction.trim()) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setError('');
    refineMutation.mutate({ input: { title, direction, instruction: instruction.trim() }, signal: controller.signal });
  };
  const close = async () => {
    if (saveMutation.isPending || groupMutation.isPending) return;
    abortRef.current?.abort();
    setError('');
    if (proposedHintRef.current !== null) {
      try { await saveMutation.mutateAsync({ title, direction }); } catch { return; }
    }
    onOpenChange(false);
  };
  const startWriting = async (generateEpisode: boolean) => {
    if (busy) return;
    setError('');
    try {
      const episode = await saveMutation.mutateAsync({ title, direction, incomplete: generateEpisode });
      if (!mountedRef.current) return;
      navigate(`/projects/${projectId}/episodes/${episode.id}`, {
        state: generateEpisode ? { generateEpisode: true } : null,
      });
    } catch {
      // Keep the scoped plan open for retry.
    }
  };

  const setupFooter = (
    <div className="action-row sm:justify-between">
      <Button variant="ghost" disabled={busy} onClick={() => void close()}>취소</Button>
      <Button busy={groupMutation.isPending} disabled={busy || !setupValid} onClick={() => void completeSetup()}>
        {groupMutation.isPending ? '그룹 만드는 중' : '다음'}{!groupMutation.isPending ? <ArrowRight className="size-4" /> : null}
      </Button>
    </div>
  );
  const setupLocked = Boolean(initialEpisode || createdGroup || episodeRef.current || createInputRef.current);
  const requestFooter = (
    <div className="action-row sm:justify-between">
      <Button
        variant="ghost"
        disabled={busy}
        onClick={() => initialGroupId || setupLocked ? void close() : setStep('setup')}
      >
        {initialGroupId || setupLocked ? '나중에 계속하기' : '이전'}
      </Button>
      <Button type="submit" form="side-story-request-form" busy={proposeMutation.isPending} disabled={busy}>
        {proposeMutation.isPending ? '만드는 중' : '다음'}{!proposeMutation.isPending ? <ArrowRight className="size-4" /> : null}
      </Button>
    </div>
  );
  const directionFooter = (
    <div className="action-row">
      {!initialEpisode ? <Button variant="ghost" disabled={busy} onClick={() => { setStep('request'); setError(''); }}>이전</Button> : null}
      <Button variant="secondary" disabled={busy || !title.trim() || !direction.trim()} onClick={() => void startWriting(false)}>빈 외전으로 시작</Button>
      <Button busy={saveMutation.isPending} disabled={busy || !title.trim() || !direction.trim()} onClick={() => void startWriting(true)}>
        <Sparkles className="size-4" /> AI 외전 작성
      </Button>
    </div>
  );

  return (
    <Sheet
      open={open}
      onOpenChange={(nextOpen) => { if (!nextOpen) void close(); }}
      title={initialEpisode ? '미완성 외전 이어서 만들기' : '새 외전 만들기'}
      description={step === 'setup'
        ? '외전의 흐름과 설정 범위를 정하세요. 본편 회차 번호와 흐름에는 영향을 주지 않습니다.'
        : step === 'request'
          ? '외전에 원하는 내용을 적어 주세요. 비워 두어도 괜찮아요.'
          : '제목과 전개 방향을 확인하세요. 외전은 선택한 범위 안에서만 이어집니다.'}
      footer={step === 'setup' ? setupFooter : step === 'request' ? requestFooter : directionFooter}
      wide
    >
      {step === 'setup' ? (
        <div className="space-y-7">
          {groupSetupLocked ? (
            <p className="field-hint" role="status">
              첫 그룹 생성 요청과 같은 내용으로 다시 시도합니다. 내용을 바꾸려면 닫고 새로 시작해 주세요.
            </p>
          ) : null}
          <fieldset>
            <legend className="field-label">외전 구성</legend>
            <div className="mt-2 grid gap-2 sm:grid-cols-3">
              {([
                ['STANDALONE', '단편 외전', '번호와 그룹 흐름 없이 씁니다.'],
                ['EXISTING_GROUP', '기존 그룹', '그룹의 이전 외전과 정사·아크를 잇습니다.'],
                ['NEW_GROUP', '새 그룹', '독립된 연속 외전 흐름을 만듭니다.'],
              ] as const).map(([value, label, description]) => (
                <label className={`option-card${target === value ? ' selected' : ''}`} key={value}>
                  <input type="radio" name="side-story-target" value={value} checked={target === value} disabled={busy || groupSetupLocked || (value === 'EXISTING_GROUP' && !groups.length)} onChange={() => { setTarget(value); setError(''); }} />
                  <span><strong>{label}</strong><small>{description}</small></span>
                </label>
              ))}
            </div>
          </fieldset>

          {target === 'EXISTING_GROUP' ? (
            <div>
              <label className="field-label" htmlFor="side-story-group">외전 그룹</label>
              <select id="side-story-group" className="input mt-2" value={selectedGroupId} disabled={busy || groupSetupLocked} onChange={(event) => setSelectedGroupId(event.target.value)}>
                <option value="">그룹을 선택하세요</option>
                {groups.map((group) => <option key={group.id} value={group.id}>{group.title} · 다음 외전 {group.nextEpisodeNumber}화</option>)}
              </select>
              <p className="field-hint">이 그룹의 이전 외전, 그룹 정사와 아크만 흐름으로 사용합니다.</p>
            </div>
          ) : null}

          {target === 'NEW_GROUP' ? (
            <div className="space-y-4 rounded-2xl border border-line bg-paper p-4">
              <div>
                <label className="field-label" htmlFor="side-story-group-title">그룹 이름</label>
                <input id="side-story-group-title" className="input mt-2" maxLength={200} value={groupTitle} disabled={busy || groupSetupLocked} onChange={(event) => setGroupTitle(event.target.value)} />
              </div>
              <div>
                <label className="field-label" htmlFor="side-story-group-description">그룹 설명 <span className="font-normal text-muted">(선택)</span></label>
                <textarea id="side-story-group-description" className="input mt-2" rows={2} maxLength={5000} value={groupDescription} disabled={busy || groupSetupLocked} onChange={(event) => setGroupDescription(event.target.value)} />
              </div>
              <div>
                <label className="field-label" htmlFor="side-story-group-canon">그룹 정사</label>
                <textarea id="side-story-group-canon" className="input mt-2" rows={4} maxLength={20000} value={groupCanon} disabled={busy || groupSetupLocked} onChange={(event) => setGroupCanon(event.target.value)} placeholder="이 외전 그룹 안에서만 사실로 유지할 설정" />
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <label><span className="field-label">아크 제목</span><input className="input mt-2" value={arcTitle} disabled={busy || groupSetupLocked} onChange={(event) => setArcTitle(event.target.value)} /></label>
                <label><span className="field-label">예상 종료 외전 <span className="font-normal text-muted">(선택)</span></span><input className="input mt-2" type="number" min={1} value={arcEndEpisode} disabled={busy || groupSetupLocked} onChange={(event) => setArcEndEpisode(event.target.value)} /></label>
                <label><span className="field-label">아크 목표</span><textarea className="input mt-2" rows={3} value={arcGoal} disabled={busy || groupSetupLocked} onChange={(event) => setArcGoal(event.target.value)} /></label>
                <label><span className="field-label">중심 갈등</span><textarea className="input mt-2" rows={3} value={arcConflict} disabled={busy || groupSetupLocked} onChange={(event) => setArcConflict(event.target.value)} /></label>
              </div>
            </div>
          ) : null}

          {target !== 'EXISTING_GROUP' ? (
            <fieldset>
              <legend className="field-label">시작 기준</legend>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                <label className={`option-card${origin === 'CANON_ONLY' ? ' selected' : ''}`}>
                  <input type="radio" name="side-story-origin" checked={origin === 'CANON_ONLY'} disabled={busy || groupSetupLocked} onChange={() => setOrigin('CANON_ONLY')} />
                  <span><strong>정사만 참고</strong><small>본편 흐름 없이 프로젝트 설정에서 새로 시작합니다.</small></span>
                </label>
                <label className={`option-card${origin === 'EPISODE' ? ' selected' : ''}`}>
                  <input type="radio" name="side-story-origin" checked={origin === 'EPISODE'} disabled={busy || groupSetupLocked || !orderedMainEpisodes.length} onChange={() => setOrigin('EPISODE')} />
                  <span><strong>본편 회차에서 이어쓰기</strong><small>고른 회차의 끝 장면에서 분기합니다.</small></span>
                </label>
              </div>
              {origin === 'EPISODE' ? (
                <div className="mt-3">
                  <label className="sr-only" htmlFor="side-story-branch">이어 쓸 본편 회차</label>
                  <select id="side-story-branch" aria-label="이어 쓸 본편 회차" className="input" value={branchFromEpisodeId} disabled={busy || groupSetupLocked} onChange={(event) => setBranchFromEpisodeId(event.target.value)}>
                    <option value="">본편 회차를 선택하세요</option>
                    {orderedMainEpisodes.map((episode) => <option key={episode.id} value={episode.id}>{episode.number}화 · {episode.title}</option>)}
                  </select>
                </div>
              ) : null}
            </fieldset>
          ) : null}
        </div>
      ) : step === 'request' ? (
        <form id="side-story-request-form" onSubmit={(event) => { event.preventDefault(); next(); }}>
          {createdGroup ? (
            <p className="field-hint mb-4" role="status">
              <strong>{createdGroup.title}</strong> 그룹은 이미 저장되었습니다. 여기서 닫아도 외전 그룹 목록에 남습니다.
            </p>
          ) : null}
          <label className="field-label" htmlFor="side-story-hint">외전에 원하는 것 <span className="font-normal text-muted">(선택)</span></label>
          <textarea id="side-story-hint" className="input mt-2" rows={8} maxLength={5000} value={hint} disabled={busy} onChange={(event) => setHint(event.target.value)} placeholder="예: 8화 뒤, 조연 둘만 남은 밤의 이야기" />
          <p className="field-hint">AI가 선택한 정사와 외전 범위 안에서 제목과 전개 방향을 만들어요.</p>
          {proposeMutation.isPending ? <p className="generation-status mt-5" role="status">외전에 허용된 설정과 흐름만 확인하고 있어요.</p> : null}
        </form>
      ) : (
        <div className="space-y-6">
          <div><label className="field-label" htmlFor="side-story-title">외전 제목</label><input id="side-story-title" className="input" maxLength={200} disabled={busy} value={title} onChange={(event) => setTitle(event.target.value)} /></div>
          <div><label className="field-label" htmlFor="side-story-direction">외전 전개 방향</label><textarea id="side-story-direction" className="input" rows={10} maxLength={20000} disabled={busy} value={direction} onChange={(event) => setDirection(event.target.value)} /></div>
          {proposalConflicts.length ? <div className="warning-box" role="alert"><strong>확인할 설정 충돌</strong><ul>{proposalConflicts.map((conflict, index) => <li key={`${conflict}-${index}`}>{conflict}</li>)}</ul></div> : null}
          <form onSubmit={(event) => { event.preventDefault(); refine(); }}>
            <label className="field-label" htmlFor="side-story-refinement">개선 요청</label>
            <textarea id="side-story-refinement" className="input" rows={3} maxLength={5000} value={instruction} disabled={busy} onChange={(event) => setInstruction(event.target.value)} />
            <div className="action-row mt-3"><Button type="submit" variant="secondary" busy={refineMutation.isPending} disabled={busy || !instruction.trim() || !title.trim() || !direction.trim()}><Sparkles className="size-4" /> {refineMutation.isPending ? '개선 중' : '개선'}</Button></div>
          </form>
        </div>
      )}
      <FieldError>{error}</FieldError>
    </Sheet>
  );
}

function CreateEpisodeSheet({
  open,
  onOpenChange,
  projectId,
  initialEpisode,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  initialEpisode: Episode | null;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [step, setStep] = useState<'request' | 'direction'>(initialEpisode ? 'direction' : 'request');
  const [title, setTitle] = useState(initialEpisode?.title ?? '');
  const [direction, setDirection] = useState(initialEpisode?.direction ?? '');
  const [hint, setHint] = useState('');
  const [instruction, setInstruction] = useState('');
  const [proposalConflicts, setProposalConflicts] = useState<string[]>([]);
  const [error, setError] = useState('');
  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(false);
  const proposedHintRef = useRef<string | null>(initialEpisode ? '' : null);
  const episodeRef = useRef(initialEpisode);
  const idempotencyKeyRef = useRef(createIdempotencyKey());
  // Keep the first create payload stable if its response is lost. Later edits
  // are applied to the returned episode instead of creating another record.
  const createInputRef = useRef<{ title: string; direction: string; content: string; incomplete: boolean } | null>(null);

  const cacheEpisode = (episode: Episode) => {
    episodeRef.current = episode;
    queryClient.setQueryData(['episodes', projectId, episode.id], episode);
    void queryClient.invalidateQueries({ queryKey: ['episodes', projectId], exact: true });
    void queryClient.invalidateQueries({ queryKey: ['episode-order', projectId] });
    void queryClient.invalidateQueries({ queryKey: ['projects'] });
  };
  const saveMutation = useMutation({
    mutationFn: async ({ title, direction, incomplete = true }: { title: string; direction: string; incomplete?: boolean }) => {
      const plan = { title: title.trim(), direction: direction.trim() };
      if (!plan.title || !plan.direction) throw new Error('제목과 전개 방향을 먼저 확인해 주세요.');
      let episode = episodeRef.current;
      if (!episode) {
        createInputRef.current ??= { ...plan, content: '', incomplete: true };
        episode = await api.episodes.create(projectId, createInputRef.current, idempotencyKeyRef.current);
        cacheEpisode(episode);
      }
      if (episode.title !== plan.title || episode.direction !== plan.direction || (episode.status === 'INCOMPLETE') !== incomplete) {
        episode = await api.episodes.update(projectId, episode.id, {
          ...plan, expectedRevision: episode.revision, incomplete,
        });
        cacheEpisode(episode);
      }
      return episode;
    },
    onError: (reason) => setError(messageOf(reason)),
  });
  const planContext = () => episodeRef.current ? {
    episodeId: episodeRef.current.id, expectedRevision: episodeRef.current.revision,
  } : undefined;
  const proposeMutation = useMutation({
    mutationFn: ({ hint, signal }: { hint: string; signal: AbortSignal }) =>
      api.episodes.propose(projectId, hint || undefined, signal, planContext()),
    onSuccess: async (proposal, { hint, signal }) => {
      if (signal.aborted) return;
      proposedHintRef.current = hint;
      setTitle(proposal.title);
      setDirection(proposal.direction);
      setProposalConflicts(proposal.conflicts ?? []);
      setInstruction('');
      setError('');
      setStep('direction');
      await saveMutation.mutateAsync(proposal).catch(() => undefined);
    },
    onError: (reason, { signal }) => {
      if (!signal.aborted) setError(messageOf(reason));
    },
  });
  const refineMutation = useMutation({
    mutationFn: ({ input, signal }: {
      input: { title: string; direction: string; instruction: string };
      signal: AbortSignal;
    }) => api.episodes.refine(projectId, { ...input, ...planContext() }, signal),
    onSuccess: async (proposal, { signal }) => {
      if (signal.aborted) return;
      setTitle(proposal.title);
      setDirection(proposal.direction);
      setProposalConflicts(proposal.conflicts ?? []);
      setInstruction('');
      setError('');
      await saveMutation.mutateAsync(proposal).catch(() => undefined);
    },
    onError: (reason, { signal }) => {
      if (!signal.aborted) setError(messageOf(reason));
    },
  });

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
    };
  }, []);

  const busy = proposeMutation.isPending || refineMutation.isPending || saveMutation.isPending;
  const next = () => {
    if (busy) return;
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
    if (busy || !title.trim() || !direction.trim() || !instruction.trim()) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setError('');
    refineMutation.mutate({ input: { title, direction, instruction: instruction.trim() }, signal: controller.signal });
  };
  const close = async () => {
    if (saveMutation.isPending) return;
    abortRef.current?.abort();
    setError('');
    if (proposedHintRef.current !== null) {
      try {
        await saveMutation.mutateAsync({ title, direction });
      } catch {
        return;
      }
    }
    onOpenChange(false);
  };
  const startWriting = async (generateEpisode: boolean) => {
    if (busy) return;
    setError('');
    try {
      const episode = await saveMutation.mutateAsync({ title, direction, incomplete: generateEpisode });
      if (!mountedRef.current) return;
      navigate(`/projects/${projectId}/episodes/${episode.id}`, {
        state: generateEpisode ? { generateEpisode: true } : null,
      });
    } catch {
      // Keep the saved plan and dialog available for retry.
    }
  };

  return (
    <Sheet
      open={open}
      onOpenChange={(nextOpen) => { if (!nextOpen) void close(); }}
      title="새 회차 만들기"
      description={step === 'request' ? '원하는 내용이 있으면 적어 주세요. 비워 두어도 괜찮아요.' : '제목과 전개 방향을 직접 고치거나, 개선 요청을 적어 여러 번 다듬어 보세요. 닫아도 미완성 회차에서 이어갈 수 있어요.'}
      footer={step === 'request' ? (
        <div className="action-row sm:justify-between">
          <Button variant="ghost" disabled={saveMutation.isPending} onClick={() => void close()}>취소</Button>
          <Button type="submit" form="episode-request-form" busy={proposeMutation.isPending} disabled={busy}>
            {proposeMutation.isPending ? '만드는 중' : '다음'}
            {!proposeMutation.isPending ? <ArrowRight className="size-4" /> : null}
          </Button>
        </div>
      ) : (
        <div className="action-row">
          <Button variant="ghost" disabled={busy} onClick={() => { setStep('request'); setError(''); }}>이전</Button>
          <Button variant="secondary" disabled={busy || !title.trim() || !direction.trim()} onClick={() => void startWriting(false)}>빈 회차로 시작</Button>
          <Button busy={saveMutation.isPending} disabled={busy || !title.trim() || !direction.trim()} onClick={() => void startWriting(true)}>
            <Sparkles className="size-4" /> AI 회차 작성
          </Button>
        </div>
      )}
      wide
    >
      {step === 'request' ? (
        <form id="episode-request-form" onSubmit={(event) => { event.preventDefault(); next(); }}>
          <label className="field-label" htmlFor="episode-hint">이번 회차에 원하는 것 <span className="font-normal text-muted">(선택)</span></label>
          <textarea
            id="episode-hint" className="input mt-2" rows={8} maxLength={5000} value={hint} disabled={busy}
            onChange={(event) => setHint(event.target.value)} aria-describedby="episode-hint-help"
            placeholder="예: 주인공이 처음으로 능력을 들키는 회차"
          />
          <p id="episode-hint-help" className="field-hint">다음을 누르면 AI가 이야기의 흐름에 맞춰 제목과 전개 방향을 자동으로 만들어요.</p>
          {proposeMutation.isPending ? <p className="generation-status mt-5" role="status">이전 회차와 설정을 확인하며 제목과 전개 방향을 만들고 있어요.</p> : null}
        </form>
      ) : (
        <div className="space-y-6">
          <div>
            <label className="field-label" htmlFor="episode-title">회차 제목</label>
            <input id="episode-title" className="input" maxLength={200} disabled={busy} value={title} onChange={(event) => setTitle(event.target.value)} />
          </div>
          <div>
            <label className="field-label" htmlFor="episode-direction">전개 방향</label>
            <textarea id="episode-direction" className="input" rows={10} maxLength={20000} disabled={busy} value={direction} onChange={(event) => setDirection(event.target.value)} />
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
              id="episode-refinement" className="input" rows={3} maxLength={5000} value={instruction} disabled={busy}
              onChange={(event) => setInstruction(event.target.value)} aria-describedby="episode-refinement-help"
              placeholder="예: 제목은 그대로 두고, 마지막 장면의 긴장감만 높여 줘"
            />
            <p id="episode-refinement-help" className="field-hint">현재 제목과 전개 방향에서 요청한 부분만 다듬어요. 개선된 결과에 요청을 더해 계속 개선할 수 있어요.</p>
            <div className="action-row mt-3">
              <Button type="submit" variant="secondary" busy={refineMutation.isPending} disabled={busy || !instruction.trim() || !title.trim() || !direction.trim()}>
                {!refineMutation.isPending ? <Sparkles className="size-4" /> : null}
                {refineMutation.isPending ? '개선 중' : '개선'}
              </Button>
            </div>
            {refineMutation.isPending ? (
              <p className="generation-status mt-3" role="status">현재 제목과 전개 방향에 개선 요청을 반영하고 있어요.</p>
            ) : refineMutation.isSuccess ? <p className="field-hint mt-3" role="status">개선 요청을 반영했어요. 더 다듬고 싶은 부분이 있으면 다시 요청해 주세요.</p> : null}
          </form>
        </div>
      )}
      <FieldError>{error}</FieldError>
    </Sheet>
  );
}
