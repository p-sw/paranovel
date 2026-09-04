import {
  ChangeEvent,
  MutableRefObject,
  PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Tabs from '@radix-ui/react-tabs';
import {
  AlertTriangle,
  BookOpen,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  FileCheck2,
  History,
  Info,
  ListChecks,
  LoaderCircle,
  MapPin,
  PanelRightOpen,
  RefreshCw,
  Sparkles,
  Square,
  WandSparkles,
} from 'lucide-react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError, isConflict, messageOf } from '../api/client';
import { AI_PHASE_LABELS, characterCount, createIdempotencyKey, cx } from '../lib';
import { rangeStillMatches, replaceUtf16Range } from '../editorText';
import type {
  AiPhase,
  ContinuityIssue,
  CurrentScene,
  Episode,
  ImprovementCandidate,
  SaveState,
  SelectionSnapshot,
} from '../types';
import { Badge, Button, ErrorState, FieldError, IconButton, Sheet, Spinner } from '../components/Ui';
import CandidateEditor from '../components/CandidateEditor';
import { defaultCandidateSelection } from '../candidateSelection';
import {
  clearEpisodeDraftBackup,
  readEpisodeDraftBackup,
  shouldOfferEpisodeBackup,
  writeEpisodeDraftBackup,
  type EpisodeDraftBackup,
} from '../episodeBackup';

type Draft = Pick<Episode, 'title' | 'direction' | 'content'>;

const emptyDraft: Draft = { title: '', direction: '', content: '' };

export default function EpisodeEditorPage() {
  const { projectId = '', episodeId = '' } = useParams();
  // React Router reuses the route element when only a path parameter changes.
  // Key the actual workspace so refs, selections and delayed saves can never
  // leak from one episode into another.
  return <EpisodeEditorWorkspace key={`${projectId}:${episodeId}`} projectId={projectId} episodeId={episodeId} />;
}

function EpisodeEditorWorkspace({ projectId, episodeId }: { projectId: string; episodeId: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const draftRef = useRef<Draft>(emptyDraft);
  const savedRef = useRef<Draft>(emptyDraft);
  const revisionRef = useRef(0);
  const saveInFlightRef = useRef<Promise<Episode | null> | null>(null);
  const dirtyWhileSavingRef = useRef(false);
  const initializedRef = useRef(false);
  const recoveryPendingRef = useRef(false);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [revision, setRevision] = useState(0);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [saveError, setSaveError] = useState('');
  const [selection, setSelection] = useState<SelectionSnapshot | null>(null);
  const [continuationOpen, setContinuationOpen] = useState(false);
  const [replacementOpen, setReplacementOpen] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const [recoveryBackup, setRecoveryBackup] = useState<EpisodeDraftBackup | null>(null);
  const [lastReplacement, setLastReplacement] = useState<{
    start: number;
    original: string;
    replacement: string;
  } | null>(null);

  const episodeQuery = useQuery({
    queryKey: ['episodes', projectId, episodeId],
    queryFn: () => api.episodes.get(projectId, episodeId),
  });
  const episodeListQuery = useQuery({
    queryKey: ['episodes', projectId],
    queryFn: () => api.episodes.list(projectId),
  });

  useEffect(() => {
    if (!episodeQuery.data || episodeQuery.isFetching || initializedRef.current) return;
    const initial = {
      title: episodeQuery.data.title,
      direction: episodeQuery.data.direction,
      content: episodeQuery.data.content,
    };
    setDraft(initial);
    draftRef.current = initial;
    savedRef.current = initial;
    revisionRef.current = episodeQuery.data.revision;
    setRevision(episodeQuery.data.revision);
    const backup = readEpisodeDraftBackup(episodeId);
    const canRecover = Boolean(backup && shouldOfferEpisodeBackup(backup, episodeQuery.data));
    recoveryPendingRef.current = canRecover;
    setRecoveryBackup(canRecover ? backup : null);
    if (backup && !canRecover) clearEpisodeDraftBackup(episodeId);
    initializedRef.current = true;
  }, [episodeId, episodeQuery.data, episodeQuery.isFetching]);

  const updateDraft = (patch: Partial<Draft>) => {
    setDraft((current) => {
      const next = { ...current, ...patch };
      draftRef.current = next;
      if (saveInFlightRef.current) dirtyWhileSavingRef.current = true;
      return next;
    });
  };

  const saveNow = useCallback(async (): Promise<Episode | null> => {
    if (!initializedRef.current) return null;
    if (saveInFlightRef.current) {
      dirtyWhileSavingRef.current = true;
      await saveInFlightRef.current;
      return saveNow();
    }
    const snapshot = { ...draftRef.current };
    if (
      snapshot.title === savedRef.current.title &&
      snapshot.direction === savedRef.current.direction &&
      snapshot.content === savedRef.current.content
    ) {
      return episodeQuery.data
        ? { ...episodeQuery.data, ...draftRef.current, revision: revisionRef.current }
        : null;
    }
    setSaveState('saving');
    setSaveError('');
    dirtyWhileSavingRef.current = false;
    const request = api.episodes.update(projectId, episodeId, {
      expectedRevision: revisionRef.current,
      title: snapshot.title,
      direction: snapshot.direction,
      content: snapshot.content,
    });
    saveInFlightRef.current = request;
    try {
      const updated = await request;
      revisionRef.current = updated.revision;
      setRevision(updated.revision);
      savedRef.current = snapshot;
      setSaveState('saved');
      const current = draftRef.current;
      const hasNewerLocalChanges =
        current.title !== snapshot.title ||
        current.direction !== snapshot.direction ||
        current.content !== snapshot.content;
      if (hasNewerLocalChanges) {
        writeEpisodeDraftBackup(episodeId, {
          ...current,
          savedAt: new Date().toISOString(),
          baseRevision: updated.revision,
        });
      } else {
        clearEpisodeDraftBackup(episodeId);
      }
      queryClient.setQueryData(['episodes', projectId, episodeId], updated);
      queryClient.invalidateQueries({ queryKey: ['episodes', projectId], exact: true });
      return updated;
    } catch (reason) {
      setSaveState('error');
      setSaveError(
        isConflict(reason)
          ? '다른 곳에서 원고가 변경되었습니다. 새로고침해 최신 원고를 확인해 주세요.'
          : messageOf(reason),
      );
      throw reason;
    } finally {
      saveInFlightRef.current = null;
      if (dirtyWhileSavingRef.current) window.setTimeout(() => void saveNow(), 0);
    }
  }, [episodeId, episodeQuery.data, projectId, queryClient]);

  const latestSaveNowRef = useRef(saveNow);
  latestSaveNowRef.current = saveNow;

  useEffect(() => () => {
    const current = draftRef.current;
    const saved = savedRef.current;
    const dirty = current.title !== saved.title || current.direction !== saved.direction || current.content !== saved.content;
    if (initializedRef.current && dirty) {
      // Route changes unmount this keyed workspace. Let the already-scoped
      // request finish in the background; localStorage remains the fallback
      // if the network request cannot complete.
      void latestSaveNowRef.current().catch(() => undefined);
    }
  }, []);

  useEffect(() => {
    if (!initializedRef.current || recoveryPendingRef.current) return;
    if (
      draft.title !== draftRef.current.title ||
      draft.direction !== draftRef.current.direction ||
      draft.content !== draftRef.current.content
    ) return;
    const saved = savedRef.current;
    const dirty = draft.title !== saved.title || draft.direction !== saved.direction || draft.content !== saved.content;
    if (!dirty) {
      clearEpisodeDraftBackup(episodeId);
      return;
    }
    writeEpisodeDraftBackup(episodeId, {
      ...draft,
      savedAt: new Date().toISOString(),
      baseRevision: revisionRef.current,
    });
    const timeout = window.setTimeout(() => void saveNow(), 750);
    return () => window.clearTimeout(timeout);
  }, [draft, episodeId, recoveryBackup, saveNow]);

  const captureSelection = useCallback(() => {
    const element = textareaRef.current;
    if (!element) return null;
    const start = element.selectionStart;
    const end = element.selectionEnd;
    const snapshot: SelectionSnapshot = {
      start,
      end,
      text: draftRef.current.content.slice(start, end),
      content: draftRef.current.content,
      revision: revisionRef.current,
    };
    setSelection(snapshot);
    return snapshot;
  }, []);

  const episodes = [...(episodeListQuery.data ?? [])].sort((a, b) => a.number - b.number);
  const currentIndex = episodes.findIndex((item) => item.id === episodeId);
  const previous = currentIndex > 0 ? episodes[currentIndex - 1] : null;
  const next = currentIndex >= 0 && currentIndex < episodes.length - 1 ? episodes[currentIndex + 1] : null;
  const episode = episodeQuery.data;

  if (episodeQuery.isPending) return <Spinner label="원고를 여는 중" />;
  if (episodeQuery.isError || !episode) {
    return <ErrorState message={messageOf(episodeQuery.error)} onRetry={() => episodeQuery.refetch()} />;
  }
  if (!initializedRef.current) return <Spinner label="최신 원고와 로컬 백업을 확인하는 중" />;

  const selected = Boolean(selection && selection.end > selection.start && selection.text);
  const isBusy = continuationOpen;
  const editorLocked = isBusy || Boolean(recoveryBackup);

  const restoreBackup = () => {
    if (!recoveryBackup) return;
    const recovered = {
      title: recoveryBackup.title,
      direction: recoveryBackup.direction,
      content: recoveryBackup.content,
    };
    draftRef.current = recovered;
    setDraft(recovered);
    setSelection(null);
    recoveryPendingRef.current = false;
    setRecoveryBackup(null);
    setSaveState('idle');
    setSaveError('');
  };

  const discardBackup = () => {
    clearEpisodeDraftBackup(episodeId);
    recoveryPendingRef.current = false;
    setRecoveryBackup(null);
  };

  return (
    <div className="editor-page">
      <aside className="episode-rail" aria-label="회차 빠른 이동">
        <div className="episode-rail-title">회차</div>
        <nav>
          {episodes.map((item) => (
            <Link
              key={item.id}
              to={`/projects/${projectId}/episodes/${item.id}`}
              className={cx('episode-rail-item', item.id === episodeId && 'active')}
              onClick={(event) => {
                if (item.id === episodeId || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                event.preventDefault();
                void saveNow().then(() => navigate(`/projects/${projectId}/episodes/${item.id}`)).catch(() => undefined);
              }}
            >
              <span>{item.number}</span>
              <span className="truncate">{item.title || '제목 없음'}</span>
            </Link>
          ))}
        </nav>
      </aside>

      <section className="editor-center">
        <header className="editor-toolbar">
          <div className="flex items-center gap-1">
            <IconButton label="이전 회차" disabled={!previous} onClick={() => previous && void saveNow().then(() => navigate(`../${previous.id}`)).catch(() => undefined)}>
              <ChevronLeft className="size-5" />
            </IconButton>
            <span className="whitespace-nowrap text-xs font-semibold text-muted">{episode.number}화</span>
            <IconButton label="다음 회차" disabled={!next} onClick={() => next && void saveNow().then(() => navigate(`../${next.id}`)).catch(() => undefined)}>
              <ChevronRight className="size-5" />
            </IconButton>
          </div>
          <SaveIndicator state={saveState} error={saveError} onRetry={() => void saveNow()} />
            <IconButton label="장면과 기억 보기" className="editor-context-toggle" onClick={() => setContextOpen(true)}>
            <PanelRightOpen className="size-5" />
          </IconButton>
        </header>

        {recoveryBackup ? (
          <section className="draft-recovery-banner" role="alert" aria-labelledby="draft-recovery-title">
            <AlertTriangle className="size-5 shrink-0" />
            <div className="min-w-0 flex-1">
              <strong id="draft-recovery-title">저장되지 않은 이 회차의 원고를 찾았어요</strong>
              <p>{new Date(recoveryBackup.savedAt).toLocaleString('ko-KR')} 백업 · {characterCount(recoveryBackup.content)}자. 서버 원고를 유지할지 백업을 복구할지 선택해 주세요.</p>
            </div>
            <div className="flex shrink-0 gap-2">
              <Button size="sm" variant="ghost" onClick={discardBackup}>버리기</Button>
              <Button size="sm" onClick={restoreBackup}>백업 복구</Button>
            </div>
          </section>
        ) : null}

        <div className="editor-paper">
          <input
            className="editor-title-input"
            aria-label="회차 제목"
            value={draft.title}
            onChange={(event) => updateDraft({ title: event.target.value })}
            placeholder="회차 제목"
            disabled={editorLocked}
          />
          <textarea
            ref={textareaRef}
            className="story-editor"
            aria-label="회차 본문"
            value={draft.content}
            placeholder="첫 문장을 써 보세요. 이곳은 서식 없는 원고 편집기입니다."
            spellCheck
            disabled={editorLocked}
            onChange={(event: ChangeEvent<HTMLTextAreaElement>) => updateDraft({ content: event.target.value })}
            onSelect={captureSelection}
            onPointerUp={captureSelection}
            onKeyUp={captureSelection}
          />
        </div>

        <footer className="editor-actionbar">
          <div className="hidden text-xs text-muted sm:block">{characterCount(draft.content)}자</div>
          {selected ? (
            <Button
              className="editor-ai-action"
              disabled={Boolean(recoveryBackup)}
              onPointerDown={(event: ReactPointerEvent<HTMLButtonElement>) => {
                event.preventDefault();
                captureSelection();
                setReplacementOpen(true);
              }}
              onClick={() => setReplacementOpen(true)}
            >
              <WandSparkles className="size-4" /> 선택문 개선 · {characterCount(selection!.text)}자
            </Button>
          ) : (
            <Button
              className="editor-ai-action"
              disabled={Boolean(recoveryBackup)}
              onPointerDown={(event: ReactPointerEvent<HTMLButtonElement>) => {
                event.preventDefault();
                captureSelection();
                setContinuationOpen(true);
              }}
              onClick={() => {
                captureSelection();
                setContinuationOpen(true);
              }}
            >
              <Sparkles className="size-4" /> 커서에서 이어쓰기
            </Button>
          )}
          <IconButton label="장면과 기억 보기" className="sm:hidden" onClick={() => setContextOpen(true)}>
            <PanelRightOpen className="size-5" />
          </IconButton>
        </footer>
      </section>

      <aside className="editor-context-panel">
        <ContextPanel projectId={projectId} episode={{ ...episode, ...draft, revision }} onDirectionChange={(direction) => updateDraft({ direction })} onFinalize={async () => {
          await saveNow();
          const finalized = await api.episodes.finalize(projectId, episodeId, revisionRef.current);
          revisionRef.current = finalized.revision;
          setRevision(finalized.revision);
          queryClient.setQueryData(['episodes', projectId, episodeId], finalized);
          queryClient.invalidateQueries({ queryKey: ['episodes', projectId] });
          queryClient.invalidateQueries({ queryKey: ['scene', projectId, episodeId] });
        }} />
      </aside>

      <Sheet open={contextOpen} onOpenChange={setContextOpen} title="장면과 기억" wide>
        <ContextPanel projectId={projectId} episode={{ ...episode, ...draft, revision }} onDirectionChange={(direction) => updateDraft({ direction })} onFinalize={async () => {
          await saveNow();
          const finalized = await api.episodes.finalize(projectId, episodeId, revisionRef.current);
          revisionRef.current = finalized.revision;
          setRevision(finalized.revision);
          queryClient.setQueryData(['episodes', projectId, episodeId], finalized);
          queryClient.invalidateQueries({ queryKey: ['scene', projectId, episodeId] });
        }} />
      </Sheet>

      <ContinuationSheet
        open={continuationOpen}
        onOpenChange={setContinuationOpen}
        projectId={projectId}
        episodeId={episodeId}
        selection={selection}
        draftRef={draftRef}
        revisionRef={revisionRef}
        saveNow={saveNow}
        onApplied={(updated, cursorOffset) => {
          const nextDraft = { title: updated.title, direction: updated.direction, content: updated.content };
          setDraft(nextDraft);
          draftRef.current = nextDraft;
          savedRef.current = nextDraft;
          revisionRef.current = updated.revision;
          setRevision(updated.revision);
          queryClient.setQueryData(['episodes', projectId, episodeId], updated);
          requestAnimationFrame(() => {
            textareaRef.current?.focus();
            textareaRef.current?.setSelectionRange(cursorOffset, cursorOffset);
          });
        }}
      />

      <ReplacementSheet
        open={replacementOpen}
        onOpenChange={setReplacementOpen}
        projectId={projectId}
        episodeId={episodeId}
        selection={selection}
        saveNow={saveNow}
        onApplied={(updated, candidates, snapshot, replacement) => {
          const nextDraft = { title: updated.title, direction: updated.direction, content: updated.content };
          setDraft(nextDraft);
          draftRef.current = nextDraft;
          savedRef.current = nextDraft;
          revisionRef.current = updated.revision;
          setRevision(updated.revision);
          setLastReplacement({ start: snapshot.start, original: snapshot.text, replacement });
          queryClient.setQueryData(['episodes', projectId, episodeId], updated);
          queryClient.invalidateQueries({ queryKey: ['improvements', projectId] });
        }}
      />

      {lastReplacement ? (
        <div className="undo-toast" role="status">
          <Check className="size-4 text-sage-700" />
          <span>선택문을 교체했어요.</span>
          <button
            type="button"
            onClick={async () => {
              try {
                const current = draftRef.current.content;
                const start = lastReplacement.start;
                const end = start + lastReplacement.replacement.length;
                if (!rangeStillMatches(current, start, end, lastReplacement.replacement)) throw new Error('되돌릴 문장이 이미 변경되었습니다.');
                const result = await api.episodes.update(projectId, episodeId, {
                  expectedRevision: revisionRef.current,
                  content: replaceUtf16Range(current, start, end, lastReplacement.original),
                });
                const nextDraft = { title: result.title, direction: result.direction, content: result.content };
                setDraft(nextDraft);
                draftRef.current = nextDraft;
                savedRef.current = nextDraft;
                revisionRef.current = result.revision;
                setRevision(result.revision);
                setLastReplacement(null);
              } catch (reason) {
                setSaveError(messageOf(reason));
              }
            }}
          >되돌리기</button>
          <button type="button" aria-label="알림 닫기" onClick={() => setLastReplacement(null)}>×</button>
        </div>
      ) : null}
    </div>
  );
}

function SaveIndicator({ state, error, onRetry }: { state: SaveState; error: string; onRetry: () => void }) {
  if (state === 'saving') return <span className="save-indicator" role="status"><LoaderCircle className="size-3.5 animate-spin" /> 저장 중</span>;
  if (state === 'error') return <button className="save-indicator error" onClick={onRetry} title={error}><RefreshCw className="size-3.5" /> 저장 실패 · 재시도</button>;
  if (state === 'saved') return <span className="save-indicator" role="status"><Check className="size-3.5" /> 저장됨</span>;
  return <span className="save-indicator">초안</span>;
}

function ContextPanel({
  projectId,
  episode,
  onDirectionChange,
  onFinalize,
}: {
  projectId: string;
  episode: Episode;
  onDirectionChange: (value: string) => void;
  onFinalize: () => Promise<void>;
}) {
  const [finalizing, setFinalizing] = useState(false);
  const [error, setError] = useState('');
  const [finalizeIssues, setFinalizeIssues] = useState<ContinuityIssue[]>([]);
  const summary = episode.summary;
  const fresh = summary?.sourceRevision === episode.revision && !summary?.stale;

  return (
    <Tabs.Root defaultValue="scene" className="context-tabs">
      <Tabs.List className="tabs-list" aria-label="회차 컨텍스트">
        <Tabs.Trigger className="tabs-trigger" value="scene"><MapPin className="size-4" /> 장면</Tabs.Trigger>
        <Tabs.Trigger className="tabs-trigger" value="memory"><History className="size-4" /> 회차 기억</Tabs.Trigger>
      </Tabs.List>
      <Tabs.Content value="scene" className="context-tab-content">
        <div className="flex items-center justify-between gap-2">
          <h2 className="panel-title">이번 회차 방향</h2>
          <Badge tone="plum">AI 컨텍스트</Badge>
        </div>
        <textarea
          className="input mt-3 min-h-40 resize-y"
          aria-label="이번 회차 전개 방향"
          value={episode.direction}
          onChange={(event) => onDirectionChange(event.target.value)}
          placeholder="장면 목표와 갈등을 적어 주세요"
        />
        <SceneFields projectId={projectId} episode={episode} />
        <div className="info-box mt-5">
          <Info className="mt-0.5 size-4 shrink-0" />
          <p>이어쓰기는 현재 커서 앞 문단과 이 방향, 현재 아크, 관련 정사와 개선점을 함께 참고해요.</p>
        </div>
        <div className="mt-6">
          <h3 className="field-label">직전 문단</h3>
          <p className="excerpt-box">{lastParagraph(episode.content) || '본문을 쓰면 커서 앞 문단이 자동으로 사용됩니다.'}</p>
        </div>
      </Tabs.Content>
      <Tabs.Content value="memory" className="context-tab-content">
        <div className="flex items-center justify-between gap-2">
          <h2 className="panel-title">회차 기억</h2>
          <Badge tone={fresh ? 'sage' : 'warning'}>{fresh ? '최신' : '갱신 필요'}</Badge>
        </div>
        {summary ? (
          <div className="memory-sections">
            <MemorySection title="주요 사건" items={summary.events} />
            <MemorySection title="감정 변화" items={summary.emotionalChanges.map((item) => `${item.character}: ${item.from} → ${item.to} · ${item.cause}`)} />
            <MemorySection title="새 떡밥" items={summary.newForeshadowing} />
            <MemorySection title="회수한 떡밥" items={summary.resolvedForeshadowing} />
          </div>
        ) : (
          <p className="mt-5 text-sm leading-6 text-muted">회차를 완성하면 사건과 감정 변화, 떡밥을 정리해 다음 집필에 사용합니다.</p>
        )}
        <Button
          className="mt-6 w-full"
          variant={fresh ? 'secondary' : 'primary'}
          busy={finalizing}
          onClick={async () => {
            setFinalizing(true);
            setError('');
            setFinalizeIssues([]);
            try {
              await onFinalize();
            } catch (reason) {
              setFinalizeIssues(continuityIssuesFromError(reason));
              setError(messageOf(reason));
            } finally {
              setFinalizing(false);
            }
          }}
        >
          <FileCheck2 className="size-4" /> {fresh ? '기억 다시 정리' : '회차 완료 · 기억 정리'}
        </Button>
        {finalizeIssues.length ? <div className="warning-box danger mt-3" role="alert"><strong>정합성 차단 이슈를 먼저 고쳐 주세요</strong><ul>{finalizeIssues.map((issue, index) => <li key={`${issue.explanation}-${index}`}>{issue.explanation}</li>)}</ul></div> : null}
        <FieldError>{error}</FieldError>
      </Tabs.Content>
    </Tabs.Root>
  );
}

function continuityIssuesFromError(reason: unknown): ContinuityIssue[] {
  if (!(reason instanceof ApiError) || reason.status !== 422 || !reason.details || typeof reason.details !== 'object') return [];
  const envelope = reason.details as { details?: { issues?: unknown } };
  return Array.isArray(envelope.details?.issues)
    ? envelope.details.issues.filter((item): item is ContinuityIssue => Boolean(item && typeof item === 'object' && 'explanation' in item))
    : [];
}

function SceneFields({ projectId, episode }: { projectId: string; episode: Episode }) {
  const queryClient = useQueryClient();
  const sceneQuery = useQuery({
    queryKey: ['scene', projectId, episode.id],
    queryFn: () => api.scenes.get(projectId, episode.id),
  });
  const [scene, setScene] = useState<CurrentScene | null>(null);
  const [charactersText, setCharactersText] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!sceneQuery.data) return;
    setScene(sceneQuery.data);
    setCharactersText(sceneQuery.data.characters.join(', '));
  }, [sceneQuery.data]);

  const saveMutation = useMutation({
    mutationFn: () => api.scenes.update(projectId, episode.id, {
      expectedRevision: episode.revision,
      location: scene?.location ?? null,
      time: scene?.time ?? null,
      pointOfView: scene?.pointOfView ?? null,
      characters: charactersText.split(',').map((item) => item.trim()).filter(Boolean),
      goal: scene?.goal ?? null,
    }),
    onSuccess: (updated) => {
      setScene(updated);
      queryClient.setQueryData(['scene', projectId, episode.id], updated);
      setError('');
    },
    onError: (reason) => setError(isConflict(reason) ? '본문이 변경되었습니다. 장면 정보를 다시 확인해 주세요.' : messageOf(reason)),
  });

  if (sceneQuery.isPending) return <div className="mt-6 flex items-center gap-2 text-sm text-muted"><LoaderCircle className="size-4 animate-spin" /> 장면 정보를 불러오는 중</div>;
  if (sceneQuery.isError) return <div className="mt-6"><FieldError>{messageOf(sceneQuery.error)}</FieldError><Button variant="ghost" size="sm" onClick={() => sceneQuery.refetch()}>다시 시도</Button></div>;
  if (!scene) return null;

  return (
    <section className="scene-fields">
      <div className="flex items-center justify-between">
        <h3 className="panel-title">현재 장면</h3>
        {scene.sourceRevision === episode.revision ? <Badge tone="sage">본문과 동기화</Badge> : <Badge tone="warning">검토 필요</Badge>}
      </div>
      <div className="scene-field-grid">
        <label><span>장소</span><input className="input" value={scene.location ?? ''} onChange={(event) => setScene({ ...scene, location: event.target.value })} placeholder="예: 북부 성벽" /></label>
        <label><span>시간</span><input className="input" value={scene.time ?? ''} onChange={(event) => setScene({ ...scene, time: event.target.value })} placeholder="예: 해 질 무렵" /></label>
        <label><span>시점</span><input className="input" value={scene.pointOfView ?? ''} onChange={(event) => setScene({ ...scene, pointOfView: event.target.value })} placeholder="예: 리안 3인칭 제한" /></label>
        <label><span>등장인물</span><input className="input" value={charactersText} onChange={(event) => setCharactersText(event.target.value)} placeholder="쉼표로 구분" /></label>
        <label className="scene-goal"><span>장면 목표</span><textarea className="input min-h-20 resize-y" value={scene.goal ?? ''} onChange={(event) => setScene({ ...scene, goal: event.target.value })} placeholder="이 장면이 끝날 때 달라져야 하는 것" /></label>
      </div>
      <Button className="mt-3 w-full" variant="secondary" size="sm" busy={saveMutation.isPending} onClick={() => saveMutation.mutate()}>장면 정보 저장</Button>
      <FieldError>{error}</FieldError>
    </section>
  );
}

function MemorySection({ title, items }: { title: string; items: string[] }) {
  if (!items.length) return null;
  return <section><h3>{title}</h3><ul>{items.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}</ul></section>;
}

function lastParagraph(content: string): string {
  return content.trim().split(/\n\s*\n/).filter(Boolean).at(-1)?.slice(-320) ?? '';
}

function ContinuationSheet({
  open,
  onOpenChange,
  projectId,
  episodeId,
  selection,
  draftRef,
  revisionRef,
  saveNow,
  onApplied,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  episodeId: string;
  selection: SelectionSnapshot | null;
  draftRef: MutableRefObject<Draft>;
  revisionRef: MutableRefObject<number>;
  saveNow: () => Promise<Episode | null>;
  onApplied: (episode: Episode, cursorOffset: number) => void;
}) {
  const [phase, setPhase] = useState<AiPhase>('idle');
  const [preview, setPreview] = useState('');
  const [issues, setIssues] = useState<ContinuityIssue[]>([]);
  const [blocked, setBlocked] = useState(false);
  const [error, setError] = useState('');
  const abortRef = useRef<AbortController | null>(null);
  const requestRef = useRef<{ content: string; cursor: number; revision: number } | null>(null);
  const active = ['retrieving', 'writing', 'checking', 'repairing'].includes(phase);

  useEffect(() => {
    if (open) return;
    abortRef.current?.abort();
    setPhase('idle');
    setPreview('');
    setIssues([]);
    setBlocked(false);
    setError('');
    requestRef.current = null;
  }, [open]);

  const generate = async () => {
    setError('');
    setPreview('');
    setIssues([]);
    setBlocked(false);
    setPhase('retrieving');
    try {
      await saveNow();
      const content = draftRef.current.content;
      const cursor = Math.min(selection?.start ?? content.length, content.length);
      requestRef.current = { content, cursor, revision: revisionRef.current };
      const controller = new AbortController();
      abortRef.current = controller;
      const result = await api.episodes.continue(
        projectId,
        episodeId,
        { expectedRevision: revisionRef.current, cursorOffset: cursor },
        (event, accumulated) => {
          if (event.type === 'stage') {
            setPhase(event.stage === 'MEMORY' ? 'retrieving' : event.stage === 'WRITING' ? 'writing' : event.stage === 'REPAIRING' ? 'repairing' : 'checking');
          }
          if (event.type === 'delta' || event.type === 'reset') {
            setPhase('writing');
            setPreview(accumulated);
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
      if (abortRef.current?.signal.aborted) setPhase('cancelled');
      else {
        setPhase('error');
        setError(messageOf(reason));
      }
    }
  };

  const apply = async () => {
    const request = requestRef.current;
    if (!request || !preview) return;
    if (draftRef.current.content !== request.content || revisionRef.current !== request.revision) {
      setPhase('error');
      setError('생성 중 원고가 바뀌었습니다. 최신 커서에서 다시 생성해 주세요.');
      return;
    }
    setPhase('checking');
    try {
      const nextContent = replaceUtf16Range(request.content, request.cursor, request.cursor, preview);
      const updated = await api.episodes.update(projectId, episodeId, {
        expectedRevision: request.revision,
        content: nextContent,
        forceNeedsReview: blocked || undefined,
      });
      onApplied(updated, request.cursor + preview.length);
      onOpenChange(false);
    } catch (reason) {
      setPhase('error');
      setError(isConflict(reason) ? '원고 버전이 달라졌습니다. 닫은 뒤 최신 원고에서 다시 시도해 주세요.' : messageOf(reason));
    }
  };

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next && active && !window.confirm('생성을 중단하고 닫을까요?')) return;
        if (!next) abortRef.current?.abort();
        onOpenChange(next);
      }}
      title="커서에서 이어쓰기"
      description="정사, 아크, 회차 기억과 개선점을 확인한 뒤 문장을 제안합니다."
      wide
      footer={
        <div className="flex w-full items-center justify-between gap-2">
          {active ? (
            <Button variant="secondary" onClick={() => abortRef.current?.abort()}><Square className="size-3.5 fill-current" /> 중단</Button>
          ) : (
            <Button variant="ghost" onClick={() => onOpenChange(false)}>취소</Button>
          )}
          {phase === 'idle' || phase === 'error' ? (
            <Button onClick={generate}><Sparkles className="size-4" /> {phase === 'error' ? '다시 생성' : '이어쓰기 시작'}</Button>
          ) : null}
          {(phase === 'done' || phase === 'cancelled') && preview ? (
            <div className="flex gap-2"><Button variant="secondary" onClick={generate}><Sparkles className="size-4" /> 다시 생성</Button><Button onClick={apply}>{phase === 'cancelled' ? '부분 문장 사용' : blocked ? '이슈 확인 · 검토 필요로 삽입' : '커서에 삽입'}</Button></div>
          ) : null}
        </div>
      }
    >
      {phase === 'idle' ? (
        <div className="ai-ready-card">
          <div className="assistant-avatar"><Sparkles className="size-5" /></div>
          <div>
            <h3>현재 커서부터 자연스럽게 이어갈게요</h3>
            <p>원고는 바로 바뀌지 않습니다. 제안을 읽고 삽입 여부를 결정하세요.</p>
          </div>
        </div>
      ) : (
        <div className="generation-preview">
          <div className="generation-status" role="status" aria-live="polite">
            {active ? <LoaderCircle className="size-4 animate-spin" /> : phase === 'done' ? <CheckCircle2 className="size-4" /> : <AlertTriangle className="size-4" />}
            <span>{AI_PHASE_LABELS[phase]}</span>
          </div>
          {active ? (
            <article className="story-preview">{preview || '본문과 관련 기억을 살피고 있습니다…'}</article>
          ) : (
            <textarea className="story-preview editable" aria-label="이어쓰기 제안 수정" value={preview} onChange={(event) => setPreview(event.target.value)} />
          )}
          {phase === 'checking' ? <p className="checking-note"><ListChecks className="size-4" /> 설정 충돌과 인물 일관성을 마지막으로 확인하고 있어요.</p> : null}
          {issues.length ? (
            <div className={blocked ? 'warning-box danger' : 'warning-box'} role="alert"><strong>{blocked ? '차단 이슈가 남아 있어요' : '삽입 전에 확인하세요'}</strong><ul>{issues.map((issue, index) => <li key={`${issue.explanation}-${index}`}><b>{issue.severity === 'BLOCKING' ? '차단' : '주의'}:</b> {issue.explanation}</li>)}</ul></div>
          ) : null}
        </div>
      )}
      <FieldError>{error}</FieldError>
    </Sheet>
  );
}

function ReplacementSheet({
  open,
  onOpenChange,
  projectId,
  episodeId,
  selection,
  saveNow,
  onApplied,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  episodeId: string;
  selection: SelectionSnapshot | null;
  saveNow: () => Promise<Episode | null>;
  onApplied: (
    episode: Episode,
    candidates: ImprovementCandidate[],
    snapshot: SelectionSnapshot,
    replacement: string,
  ) => void;
}) {
  const [replacement, setReplacement] = useState('');
  const [candidates, setCandidates] = useState<ImprovementCandidate[]>([]);
  const [selectedCandidates, setSelectedCandidates] = useState<number[]>([]);
  const [applied, setApplied] = useState(false);
  const [applying, setApplying] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [error, setError] = useState('');
  const queryClient = useQueryClient();
  const acceptanceAttemptRef = useRef<{ fingerprint: string; key: string } | null>(null);

  useEffect(() => {
    if (!open) {
      setCandidates([]);
      setSelectedCandidates([]);
      acceptanceAttemptRef.current = null;
      setApplied(false);
      setAnalyzing(false);
      setError('');
      return;
    }
    setReplacement(selection?.text ?? '');
  }, [open, selection]);

  const acceptMutation = useMutation({
    mutationFn: () => {
      const payload = {
        projectId,
        candidates: candidates.filter((_, index) => selectedCandidates.includes(index)),
      };
      const fingerprint = JSON.stringify(payload);
      if (acceptanceAttemptRef.current?.fingerprint !== fingerprint) {
        acceptanceAttemptRef.current = { fingerprint, key: createIdempotencyKey() };
      }
      return api.improvements.accept(payload, acceptanceAttemptRef.current.key);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['improvements', projectId] });
      onOpenChange(false);
    },
    onError: (reason) => setError(messageOf(reason)),
  });

  // The server revision can advance when the debounced draft is flushed. Read it from
  // the latest episode returned by saveNow rather than trusting the captured revision.
  const applyReplacement = async () => {
    if (!selection || !replacement.trim() || replacement === selection.text) return;
    setApplying(true);
    setError('');
    try {
      const saved = await saveNow();
      if (!saved) throw new Error('원고를 저장하지 못했습니다.');
      if (!rangeStillMatches(saved.content, selection.start, selection.end, selection.text)) {
        throw new Error('선택한 문장이 이미 바뀌었습니다. 닫은 뒤 다시 선택해 주세요.');
      }
      const result = await api.episodes.replaceSelection(projectId, episodeId, {
        expectedRevision: saved.revision,
        start: selection.start,
        end: selection.end,
        selectedText: selection.text,
        replacement,
      });
      onApplied(result.episode, [], selection, replacement);
      setApplied(true);
      setAnalyzing(true);
      try {
        const analysis = await api.improvements.candidates({
          source: 'EDITOR',
          projectId,
          original: selection.text,
          revised: replacement,
        });
        setCandidates(analysis.candidates);
        setSelectedCandidates(defaultCandidateSelection(analysis.candidates));
        acceptanceAttemptRef.current = null;
      } catch (analysisError) {
        setError(`본문은 적용했지만 개선점 분석에 실패했습니다: ${messageOf(analysisError)}`);
      } finally {
        setAnalyzing(false);
      }
    } catch (reason) {
      setError(isConflict(reason) ? '선택한 원문이 달라졌습니다. 닫은 뒤 다시 선택해 주세요.' : messageOf(reason));
    } finally {
      setApplying(false);
    }
  };

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={applied ? '개선점으로 남길까요?' : '선택문 개선'}
      description={applied ? '선택한 규칙은 이 프로젝트의 모든 AI 집필에 반영됩니다.' : '직접 원하는 문장으로 고치면, AI가 그 차이에서 취향을 배웁니다.'}
      wide
      footer={
        applied ? (
          <div className="flex w-full justify-end gap-2">
            <Button variant="secondary" onClick={() => onOpenChange(false)}>이번만 적용</Button>
            {candidates.length ? <Button busy={acceptMutation.isPending} disabled={!selectedCandidates.length} onClick={() => acceptMutation.mutate()}>선택한 개선점 저장</Button> : null}
          </div>
        ) : (
          <div className="flex w-full justify-end gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>취소</Button>
            <Button
              busy={applying}
              disabled={!selection || !replacement.trim() || replacement === selection.text}
              onClick={() => void applyReplacement()}
            >본문에 적용</Button>
          </div>
        )
      }
    >
      {!applied ? (
        <div className="comparison-grid">
          <section className="compare-pane original">
            <span className="compare-label">원문</span>
            <p>{selection?.text || '개선할 문장을 다시 선택해 주세요.'}</p>
          </section>
          <section className="compare-pane revised">
            <label className="compare-label" htmlFor="replacement-text">내가 원하는 문장</label>
            <textarea
              id="replacement-text"
              className="comparison-textarea"
              value={replacement}
              onChange={(event) => setReplacement(event.target.value)}
              autoFocus
            />
          </section>
        </div>
      ) : analyzing ? (
        <div className="state-box min-h-48"><LoaderCircle className="size-6 animate-spin text-plum-600" /><p>수정 차이에서 반복할 개선점을 찾는 중</p></div>
      ) : candidates.length ? (
        <div className="candidate-list">
          {candidates.map((candidate, index) => <CandidateEditor
            key={index}
            candidate={candidate}
            checked={selectedCandidates.includes(index)}
            onCheckedChange={(checked) => setSelectedCandidates((current) => checked ? [...new Set([...current, index])] : current.filter((item) => item !== index))}
            onChange={(updated) => setCandidates((current) => current.map((item, itemIndex) => itemIndex === index ? updated : item))}
          />)}
        </div>
      ) : (
        <div className="success-state"><CheckCircle2 className="size-8" /><p>문장을 바꿨어요. 이번 수정에서는 별도로 저장할 규칙을 찾지 못했습니다.</p></div>
      )}
      <FieldError>{error}</FieldError>
    </Sheet>
  );
}
