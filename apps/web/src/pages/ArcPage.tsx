import { FormEvent, useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ChevronDown, Flag, GitBranch, History, Plus, Sparkles, Target, WandSparkles } from 'lucide-react';
import { useOutletContext, useParams } from 'react-router-dom';
import { api, messageOf } from '../api/client';
import type { Arc, ArcPlanProposal } from '../types';
import type { ProjectOutletContext } from '../components/AppShell';
import { Badge, Button, EmptyState, ErrorState, FieldError, Sheet, SkeletonCards } from '../components/Ui';

interface ArcDraft {
  title: string;
  startEpisode: number;
  endEpisode: number;
  goal: string;
  conflict: string;
  reversalPlan: Arc['reversalPlan'];
  status: Arc['status'];
}

const blankArc: ArcDraft = {
  title: '',
  startEpisode: 1,
  endEpisode: 10,
  goal: '',
  conflict: '',
  reversalPlan: [],
  status: 'ACTIVE',
};

export default function ArcPage() {
  const { projectId = '' } = useParams();
  const { project } = useOutletContext<ProjectOutletContext>();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<ArcDraft>(blankArc);
  const [editing, setEditing] = useState(false);
  const [creatingNew, setCreatingNew] = useState(false);
  const [reversalText, setReversalText] = useState('');
  const [plannerOpen, setPlannerOpen] = useState(false);
  const [plannerRequest, setPlannerRequest] = useState('');
  const [proposal, setProposal] = useState<ArcPlanProposal | null>(null);
  const [plannerError, setPlannerError] = useState('');
  const [error, setError] = useState('');
  const arcQuery = useQuery({ queryKey: ['arc', projectId, 'current'], queryFn: () => api.arcs.current(projectId) });
  const arcsQuery = useQuery({ queryKey: ['arcs', projectId], queryFn: () => api.arcs.list(projectId) });

  const loadArcIntoForm = (arc: Arc) => {
    setForm({
      title: arc.title,
      startEpisode: arc.startEpisode,
      endEpisode: arc.endEpisode,
      goal: arc.goal,
      conflict: arc.conflict,
      reversalPlan: arc.reversalPlan,
      status: arc.status,
    });
    setReversalText(arc.reversalPlan.map((beat) => `${beat.episode}화 — ${beat.description}`).join('\n'));
  };

  const beginNewArc = () => {
    const startEpisode = project.nextEpisodeNumber ?? (project.lastEpisodeNumber ?? 0) + 1;
    setForm({ ...blankArc, startEpisode, endEpisode: startEpisode + 9 });
    setReversalText('');
    setCreatingNew(true);
    setEditing(true);
    setError('');
  };

  useEffect(() => {
    if (arcQuery.data) {
      loadArcIntoForm(arcQuery.data);
    }
  }, [arcQuery.data]);

  const planMutation = useMutation({
    mutationFn: () => api.arcs.plan(projectId, plannerRequest),
    onSuccess: (next) => {
      setProposal(next);
      setPlannerError('');
    },
    onError: (reason) => setPlannerError(messageOf(reason)),
  });

  const useProposal = (mode: 'current' | 'new') => {
    if (!proposal) return;
    setForm({
      title: proposal.title,
      startEpisode: proposal.startEpisodeNumber,
      endEpisode: proposal.endEpisodeNumber,
      goal: proposal.goal,
      conflict: proposal.conflict,
      reversalPlan: proposal.reversalPlan,
      status: 'ACTIVE',
    });
    setReversalText(proposal.reversalPlan.map((beat) => `${beat.episode}화 — ${beat.description}`).join('\n'));
    setCreatingNew(mode === 'new' || !arcQuery.data);
    setEditing(true);
    setPlannerOpen(false);
  };

  const mutation = useMutation({
    mutationFn: () => {
      const reversalPlan = parseReversalPlan(reversalText);
      const payload = { ...form, reversalPlan, status: form.status };
      return arcQuery.data && !creatingNew
        ? api.arcs.update(projectId, arcQuery.data.id, { ...payload, expectedRevision: arcQuery.data.revision })
        : api.arcs.create(projectId, payload);
    },
    onSuccess: (arc) => {
      queryClient.setQueryData(['arc', projectId, 'current'], arc.status === 'ACTIVE' ? arc : null);
      queryClient.invalidateQueries({ queryKey: ['arcs', projectId] });
      queryClient.invalidateQueries({ queryKey: ['arc', projectId, 'current'] });
      setEditing(false);
      setCreatingNew(false);
      setError('');
    },
    onError: (reason) => setError(messageOf(reason)),
  });

  const activateMutation = useMutation({
    mutationFn: (arc: Arc) => api.arcs.update(projectId, arc.id, {
      expectedRevision: arc.revision,
      status: 'ACTIVE',
    }),
    onSuccess: (arc) => {
      queryClient.setQueryData(['arc', projectId, 'current'], arc);
      queryClient.invalidateQueries({ queryKey: ['arcs', projectId] });
      setError('');
    },
    onError: (reason) => setError(messageOf(reason)),
  });

  const validate = () => {
    const length = form.endEpisode - form.startEpisode + 1;
    if (!form.title.trim() || !form.goal.trim() || !form.conflict.trim()) return '제목, 목표와 갈등을 모두 입력해 주세요.';
    if (length < 5 || length > 20) return '아크는 5화에서 20화 사이로 계획해 주세요.';
    return '';
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const issue = validate();
    if (issue) return setError(issue);
    mutation.mutate();
  };

  if (arcQuery.isPending) return <div className="page-container"><SkeletonCards count={2} /></div>;
  if (arcQuery.isError) return <div className="page-container"><ErrorState message={messageOf(arcQuery.error)} onRetry={() => arcQuery.refetch()} /></div>;

  const arc = arcQuery.data;
  const previousArcs = (arcsQuery.data ?? []).filter((item) => item.id !== arc?.id);
  const currentEpisode = project.lastEpisodeNumber ?? 0;
  const total = Math.max(1, form.endEpisode - form.startEpisode + 1);
  const progress = Math.max(0, Math.min(100, ((currentEpisode - form.startEpisode + 1) / total) * 100));

  return (
    <div className="page-container page-narrow">
      <header className="page-heading-row">
        <div><p className="eyebrow">5–20화의 큰 흐름</p><h1 className="section-title">현재 아크</h1><p className="page-lead">매 회차가 향해야 할 목표와 반전을 고정합니다.</p></div>
        <div className="page-actions">
          <Button variant="secondary" onClick={() => setPlannerOpen(true)}><WandSparkles className="size-4" /> AI로 아크 제안</Button>
          {arc && !editing ? <Button variant="secondary" onClick={() => { loadArcIntoForm(arc); setCreatingNew(false); setEditing(true); }}>아크 편집</Button> : null}
          {arc && !editing ? <Button onClick={beginNewArc}><Plus className="size-4" /> 새 아크</Button> : null}
        </div>
      </header>

      {!arc && !editing ? (
        <EmptyState
          icon={<GitBranch className="size-8" />}
          title="현재 아크가 비어 있어요"
          description="이번 5–20화가 어디로 향할지 정하면 AI가 곁가지를 줄이고 핵심 갈등을 따라갑니다."
          action={<Button onClick={beginNewArc}><Plus className="size-4" /> 아크 계획하기</Button>}
        />
      ) : null}

      {arc && !editing ? (
        <article className="arc-overview">
          <div className="arc-hero">
            <div><Badge tone="plum">{arc.startEpisode}–{arc.endEpisode}화</Badge><h2>{arc.title}</h2></div>
            <div className="arc-progress-label"><strong>{Math.round(progress)}%</strong><span>현재 {currentEpisode || arc.startEpisode}화</span></div>
          </div>
          <div className="progress-track" aria-label={`아크 진행률 ${Math.round(progress)}%`}><span style={{ width: `${progress}%` }} /></div>
          <div className="arc-sections">
            <section><div className="arc-section-icon"><Target className="size-5" /></div><div><span>아크 목표</span><p>{arc.goal}</p></div></section>
            <section><div className="arc-section-icon conflict"><GitBranch className="size-5" /></div><div><span>핵심 갈등</span><p>{arc.conflict}</p></div></section>
            <section><div className="arc-section-icon twist"><Sparkles className="size-5" /></div><div><span>회차별 반전</span><p className="whitespace-pre-wrap">{arc.reversalPlan.map((beat) => `${beat.episode}화 — ${beat.description}`).join('\n') || '아직 정한 반전이 없습니다.'}</p></div></section>
          </div>
        </article>
      ) : null}

      {editing ? (
        <form className="form-card" onSubmit={submit}>
          <div className="form-card-heading"><Flag className="size-5" /><div><h2>{creatingNew ? '새 아크 계획' : '현재 아크 편집'}</h2><p>전체 범위는 시작과 끝을 포함해 5–20화여야 합니다.</p></div></div>
          {creatingNew && arc ? <p className="mt-4 rounded-xl bg-plum-50 p-3 text-sm leading-6 text-plum-700">새 아크를 진행 중으로 저장하면 ‘{arc.title}’은 삭제되지 않고 보관된 이전 기록으로 이동합니다.</p> : null}
          <div className="mt-6 space-y-5">
            <div><label className="field-label" htmlFor="arc-title">아크 제목</label><input id="arc-title" className="input" value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} placeholder="예: 왕도의 그림자" /></div>
            <div className="grid grid-cols-2 gap-3">
              <div><label className="field-label" htmlFor="arc-start">시작 회차</label><input id="arc-start" type="number" min={1} className="input" value={form.startEpisode} onChange={(event) => setForm({ ...form, startEpisode: Number(event.target.value) })} /></div>
              <div><label className="field-label" htmlFor="arc-end">끝 회차</label><input id="arc-end" type="number" min={1} className="input" value={form.endEpisode} onChange={(event) => setForm({ ...form, endEpisode: Number(event.target.value) })} /></div>
            </div>
            <div><label className="field-label" htmlFor="arc-goal">목표</label><textarea id="arc-goal" className="input" value={form.goal} onChange={(event) => setForm({ ...form, goal: event.target.value })} placeholder="아크가 끝날 때 주인공과 세계가 어떻게 달라져야 하나요?" /></div>
            <div><label className="field-label" htmlFor="arc-conflict">핵심 갈등</label><textarea id="arc-conflict" className="input" value={form.conflict} onChange={(event) => setForm({ ...form, conflict: event.target.value })} placeholder="무엇이 목표 달성을 가로막나요?" /></div>
            <div><label className="field-label" htmlFor="arc-twist">회차별 반전</label><textarea id="arc-twist" className="input" value={reversalText} onChange={(event) => setReversalText(event.target.value)} placeholder={'예: 8화 — 조력자의 정체가 드러난다\n10화 — 적의 목적이 복수였음이 밝혀진다'} /><p className="field-hint">각 줄을 ‘8화 — 반전 내용’ 형식으로 적어 주세요.</p></div>
          </div>
          <FieldError>{error}</FieldError>
          <div className="action-row mt-6"><Button type="button" variant="ghost" onClick={() => { if (arc) loadArcIntoForm(arc); setCreatingNew(false); setEditing(false); }}>취소</Button><Button type="submit" busy={mutation.isPending}>{creatingNew ? '새 아크 시작' : '아크 저장'}</Button></div>
        </form>
      ) : null}

      {previousArcs.length ? (
        <section className="mt-8" aria-labelledby="arc-history-title">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div><p className="eyebrow">삭제되지 않는 계획 기록</p><h2 id="arc-history-title" className="mt-1 font-story text-xl font-bold">이전·대기 아크</h2></div>
            <Badge tone="neutral"><History className="size-3" /> {previousArcs.length}개</Badge>
          </div>
          <div className="space-y-3">
            {previousArcs.map((pastArc) => (
              <article className="rounded-2xl border border-line bg-surface p-4 shadow-sm" key={pastArc.id}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><Badge tone="neutral">{pastArc.startEpisode}–{pastArc.endEpisode}화</Badge><ArcStatusBadge status={pastArc.status} /></div><h3 className="mt-2 font-story text-lg font-bold">{pastArc.title}</h3><p className="mt-1 line-clamp-2 text-sm leading-6 text-muted">{pastArc.goal}</p></div>
                  {pastArc.status !== 'ACTIVE' ? <Button size="sm" variant="secondary" busy={activateMutation.isPending && activateMutation.variables?.id === pastArc.id} onClick={() => { if (window.confirm(`‘${pastArc.title}’을 현재 아크로 전환할까요? 기존 현재 아크는 보관된 이전 기록으로 이동합니다.`)) activateMutation.mutate(pastArc); }}>현재 아크로 전환</Button> : null}
                </div>
                <details className="group mt-3">
                  <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-lg px-2 text-sm font-semibold text-plum-700 hover:bg-plum-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-plum-500 [&::-webkit-details-marker]:hidden">
                    <ChevronDown aria-hidden="true" className="size-4 shrink-0 transition-transform group-open:rotate-180" />
                    <span className="sr-only">{pastArc.title} </span>
                    <span className="group-open:hidden">자세히 보기</span>
                    <span className="hidden group-open:inline">접기</span>
                  </summary>
                  <dl className="mt-3 space-y-4 border-t border-line pt-4 text-sm">
                    <div><dt className="font-bold">아크 목표</dt><dd className="mt-1 whitespace-pre-wrap break-words leading-7">{pastArc.goal}</dd></div>
                    <div><dt className="font-bold">핵심 갈등</dt><dd className="mt-1 whitespace-pre-wrap break-words leading-7">{pastArc.conflict}</dd></div>
                    <div><dt className="font-bold">회차별 반전</dt><dd className="mt-1 whitespace-pre-wrap break-words leading-7">{pastArc.reversalPlan.map((beat) => `${beat.episode}화 — ${beat.description}`).join('\n') || '아직 정한 반전이 없습니다.'}</dd></div>
                  </dl>
                </details>
              </article>
            ))}
          </div>
        </section>
      ) : null}
      {arcsQuery.isError ? <FieldError>이전·대기 아크 기록을 불러오지 못했습니다.</FieldError> : null}

      <Sheet
        open={plannerOpen}
        onOpenChange={(open) => {
          setPlannerOpen(open);
          if (!open) {
            setProposal(null);
            setPlannerError('');
          }
        }}
        title="AI로 아크 제안"
        description="정사, 최근 회차 기억과 미회수 떡밥을 바탕으로 5–20화 계획을 만듭니다. 검토하기 전에는 저장되지 않아요."
        wide
        footer={proposal ? (
          <div className="action-row">
            <Button variant="secondary" busy={planMutation.isPending} onClick={() => planMutation.mutate()}><Sparkles className="size-4" /> 다시 제안</Button>
            {arc ? <Button variant="secondary" onClick={() => useProposal('current')}>현재 아크 수정안으로</Button> : null}
            <Button onClick={() => useProposal('new')}>{arc ? '새 아크로 불러오기' : '편집 폼에 불러오기'}</Button>
          </div>
        ) : (
          <div className="action-row">
            <Button variant="ghost" onClick={() => setPlannerOpen(false)}>취소</Button>
            <Button busy={planMutation.isPending} onClick={() => planMutation.mutate()}><WandSparkles className="size-4" /> 제안 만들기</Button>
          </div>
        )}
      >
        {proposal ? (
          <div className="space-y-5">
            <section className="proposal-box">
              <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-story text-xl font-bold">{proposal.title}</h3><Badge tone="plum">{proposal.startEpisodeNumber}–{proposal.endEpisodeNumber}화</Badge></div>
              <dl className="mt-4 space-y-3 text-sm"><div><dt className="font-bold">목표</dt><dd className="mt-1 leading-6 text-muted">{proposal.goal}</dd></div><div><dt className="font-bold">갈등</dt><dd className="mt-1 leading-6 text-muted">{proposal.conflict}</dd></div><div><dt className="font-bold">회차별 반전</dt><dd className="mt-1 whitespace-pre-wrap leading-6 text-muted">{proposal.reversalPlan.map((beat) => `${beat.episode}화 — ${beat.description}`).join('\n') || '아직 정한 반전이 없습니다.'}</dd></div></dl>
            </section>
            {proposal.conflicts.length ? <div className="warning-box" role="alert"><strong className="flex items-center gap-2"><AlertTriangle className="size-4" /> 기존 설정과 확인할 충돌</strong><ul>{proposal.conflicts.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}</ul></div> : null}
            <section><h3 className="field-label">회차별 방향 제안</h3><div className="mt-2 space-y-2">{proposal.episodeDirections.map((item) => <article className="rounded-xl border border-line bg-paper p-3" key={item.episode}><div className="flex gap-2 text-sm font-bold"><span className="text-plum-600">{item.episode}화</span><span>{item.title}</span></div><p className="mt-1 text-sm leading-6 text-muted">{item.direction}</p></article>)}</div></section>
          </div>
        ) : (
          <div>
            <label className="field-label" htmlFor="arc-plan-request">원하는 흐름 <span className="font-normal text-muted">(선택)</span></label>
            <textarea id="arc-plan-request" className="input mt-2" value={plannerRequest} onChange={(event) => setPlannerRequest(event.target.value)} placeholder="예: 주인공이 동료의 배신을 의심하지만 마지막에는 더 큰 적의 존재가 드러나게 해 줘" />
            <p className="field-hint">비워 두면 현재 기억과 아크 진행 상황만으로 제안합니다.</p>
          </div>
        )}
        <FieldError>{plannerError}</FieldError>
      </Sheet>
    </div>
  );
}

function ArcStatusBadge({ status }: { status: Arc['status'] }) {
  const labels: Record<Arc['status'], string> = {
    ACTIVE: '진행 중',
    PLANNED: '이전·대기',
    COMPLETE: '완료',
    ARCHIVED: '보관',
  };
  return <Badge tone={status === 'COMPLETE' ? 'sage' : status === 'ARCHIVED' ? 'warning' : 'neutral'}>{labels[status]}</Badge>;
}

function parseReversalPlan(value: string): Arc['reversalPlan'] {
  return value.split('\n').map((line) => line.trim()).filter(Boolean).map((line, index) => {
    const match = line.match(/^(\d+)\s*화?\s*[—–:\-]?\s*(.+)$/);
    return match
      ? { episode: Number(match[1]), description: match[2].trim() }
      : { episode: index + 1, description: line };
  });
}
