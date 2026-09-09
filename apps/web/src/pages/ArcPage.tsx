import { type FormEvent, type ReactNode, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  Archive,
  ChevronDown,
  Clock3,
  Flag,
  GitBranch,
  History,
  Pencil,
  Plus,
  Sparkles,
  Target,
  Trash2,
  WandSparkles,
} from 'lucide-react';
import { useOutletContext, useParams } from 'react-router-dom';
import { api, messageOf } from '../api/client';
import {
  episodeDirectionsForRange,
  episodeDirectionsIssue,
  MILESTONE_TYPE_LABELS,
  MILESTONE_TYPES,
} from '../arcPlan';
import type { Arc, ArcMilestone, ArcPlanProposal } from '../types';
import type { ProjectOutletContext } from '../components/AppShell';
import { Badge, Button, EmptyState, ErrorState, FieldError, Sheet, SkeletonCards } from '../components/Ui';

interface ArcDraft {
  title: string;
  startEpisode: number;
  endEpisode: number;
  goal: string;
  conflict: string;
  milestones: Arc['milestones'];
  episodeDirections: Arc['episodeDirections'];
  status: Arc['status'];
}

type EditorTarget =
  | { mode: 'new' }
  | { mode: 'edit'; arc: Arc }
  | null;

const blankArc = (startEpisode = 1, endEpisode = 10): ArcDraft => ({
  title: '',
  startEpisode,
  endEpisode,
  goal: '',
  conflict: '',
  milestones: [{ episode: endEpisode, type: 'GOAL', description: '' }],
  episodeDirections: episodeDirectionsForRange(startEpisode, endEpisode),
  status: 'PLANNED',
});

const byStartEpisode = (left: Arc, right: Arc) =>
  left.startEpisode - right.startEpisode || left.endEpisode - right.endEpisode;

export default function ArcPage() {
  const { projectId = '' } = useParams();
  const { project } = useOutletContext<ProjectOutletContext>();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<ArcDraft>(() => blankArc());
  const [editorTarget, setEditorTarget] = useState<EditorTarget>(null);
  const [plannerOpen, setPlannerOpen] = useState(false);
  const [plannerRequest, setPlannerRequest] = useState('');
  const [proposal, setProposal] = useState<ArcPlanProposal | null>(null);
  const [plannerError, setPlannerError] = useState('');
  const [error, setError] = useState('');
  const plannerGeneration = useRef(0);
  const arcQuery = useQuery({ queryKey: ['arc', projectId, 'current'], queryFn: () => api.arcs.current(projectId) });
  const arcsQuery = useQuery({ queryKey: ['arcs', projectId], queryFn: () => api.arcs.list(projectId) });

  const allArcs = [...(arcsQuery.data ?? [])].sort(byStartEpisode);
  const currentArc = allArcs.find((arc) => arc.status === 'ACTIVE') ?? arcQuery.data ?? null;
  const plannedArcs = allArcs.filter((arc) => arc.status === 'PLANNED');
  const completedArcs = allArcs.filter((arc) => arc.status === 'COMPLETE').reverse();
  const archivedArcs = allArcs.filter((arc) => arc.status === 'ARCHIVED').reverse();
  const editing = editorTarget !== null;
  const nextArcRange = findNextArcRange(allArcs, currentArc, project.targetEpisode ?? null, project.nextEpisodeNumber ?? 1);
  const completedEnd = allArcs
    .filter((arc) => arc.status === 'COMPLETE')
    .reduce((latest, arc) => Math.max(latest, arc.endEpisode), 0);
  const nextActivationEpisode = currentArc
    ? currentArc.endEpisode + 1
    : Math.max(completedEnd + 1, project.nextEpisodeNumber ?? 1);
  const canActivateFirstPlanned = plannedArcs[0]?.startEpisode === nextActivationEpisode;

  const loadArcIntoForm = (arc: Arc) => {
    setForm({
      title: arc.title,
      startEpisode: arc.startEpisode,
      endEpisode: arc.endEpisode,
      goal: arc.goal,
      conflict: arc.conflict,
      milestones: arc.milestones,
      episodeDirections: episodeDirectionsForRange(arc.startEpisode, arc.endEpisode, arc.episodeDirections),
      status: arc.status,
    });
  };

  const closeEditor = () => {
    setEditorTarget(null);
    setForm(blankArc());
    setError('');
  };

  const beginEditArc = (arc: Arc) => {
    if (!['ACTIVE', 'PLANNED'].includes(arc.status)) return;
    if (arc.status === 'ACTIVE' && !window.confirm(
      `‘${arc.title}’은 현재 진행 중인 아크입니다. 이미 집필한 흐름과 어긋날 수 있습니다. 그래도 편집할까요?`,
    )) return;
    loadArcIntoForm(arc);
    setEditorTarget({ mode: 'edit', arc });
    setError('');
  };

  const beginNewArc = () => {
    if (!nextArcRange) {
      setError('목표 완결 회차까지 이미 아크가 계획되어 있습니다. 기존 대기 아크를 편집해 주세요.');
      return;
    }
    setForm(blankArc(nextArcRange.startEpisode, nextArcRange.endEpisode));
    setEditorTarget({ mode: 'new' });
    setError('');
  };

  const refreshArcs = (arc?: Arc) => {
    if (arc) {
      queryClient.setQueryData<Arc[]>(['arcs', projectId], (current) => {
        if (!current) return current;
        const remaining = current.filter((item) => item.id !== arc.id && (arc.status !== 'ACTIVE' || item.status !== 'ACTIVE'));
        return [...remaining, arc].sort(byStartEpisode);
      });
      if (arc.status === 'ACTIVE') queryClient.setQueryData(['arc', projectId, 'current'], arc);
    }
    void queryClient.invalidateQueries({ queryKey: ['arcs', projectId] });
    void queryClient.invalidateQueries({ queryKey: ['arc', projectId, 'current'] });
  };

  const planMutation = useMutation({
    mutationFn: ({ request }: { generation: number; request: string }) => api.arcs.plan(projectId, request),
    onSuccess: (next, request) => {
      if (request.generation !== plannerGeneration.current) return;
      setProposal(next);
      setPlannerError('');
    },
    onError: (reason, request) => {
      if (request.generation === plannerGeneration.current) setPlannerError(messageOf(reason));
    },
  });

  const requestPlan = () => {
    const generation = plannerGeneration.current + 1;
    plannerGeneration.current = generation;
    setProposal(null);
    setPlannerError('');
    planMutation.mutate({ generation, request: plannerRequest });
  };

  const closePlanner = () => {
    plannerGeneration.current += 1;
    setPlannerOpen(false);
    setProposal(null);
    setPlannerError('');
  };

  const useProposal = () => {
    if (!proposal || planMutation.isPending) return;
    const replacement = proposal.replaceArcId
      ? plannedArcs.find((arc) => arc.id === proposal.replaceArcId && arc.revision === proposal.replaceArcRevision)
      : undefined;
    if (proposal.replaceArcId && !replacement) {
      setPlannerError('대기 아크가 제안 이후 변경됐어요. 최신 계획으로 다시 제안해 주세요.');
      return;
    }
    setForm({
      title: proposal.title,
      startEpisode: proposal.startEpisodeNumber,
      endEpisode: proposal.endEpisodeNumber,
      goal: proposal.goal,
      conflict: proposal.conflict,
      milestones: proposal.milestones,
      episodeDirections: episodeDirectionsForRange(
        proposal.startEpisodeNumber,
        proposal.endEpisodeNumber,
        proposal.episodeDirections,
      ),
      status: 'PLANNED',
    });
    setEditorTarget(replacement ? { mode: 'edit', arc: replacement } : { mode: 'new' });
    setPlannerOpen(false);
    setProposal(null);
    setPlannerError('');
    setError('');
  };

  const saveMutation = useMutation({
    mutationFn: () => {
      if (!editorTarget) throw new Error('편집 중인 아크가 없습니다.');
      const payload = {
        title: form.title,
        startEpisode: form.startEpisode,
        endEpisode: form.endEpisode,
        goal: form.goal,
        conflict: form.conflict,
        milestones: form.milestones,
        episodeDirections: form.episodeDirections,
      };
      if (editorTarget.mode === 'new') {
        return api.arcs.create(projectId, { ...payload, status: 'PLANNED' });
      }
      const update = {
        ...payload,
        expectedRevision: editorTarget.arc.revision,
        ...(editorTarget.arc.status === 'ACTIVE' ? { confirmProtected: true } : {}),
      };
      return api.arcs.update(projectId, editorTarget.arc.id, update);
    },
    onSuccess: (arc) => {
      refreshArcs(arc);
      closeEditor();
    },
    onError: (reason) => setError(messageOf(reason)),
  });

  const activateMutation = useMutation({
    mutationFn: (arc: Arc) => {
      const update = {
        expectedRevision: arc.revision,
        status: 'ACTIVE' as const,
        confirmProtected: true,
      };
      return api.arcs.update(projectId, arc.id, update);
    },
    onSuccess: (arc) => {
      refreshArcs(arc);
      setError('');
    },
    onError: (reason) => setError(messageOf(reason)),
  });

  const deleteMutation = useMutation({
    mutationFn: (arc: Arc) => api.arcs.remove(projectId, arc.id, arc.revision),
    onSuccess: (_result, deleted) => {
      queryClient.setQueryData<Arc[]>(['arcs', projectId], (current) =>
        current?.filter((arc) => arc.id !== deleted.id),
      );
      refreshArcs();
      setError('');
    },
    onError: (reason) => setError(messageOf(reason)),
  });

  const activatePlannedArc = (arc: Arc) => {
    const consequence = currentArc
      ? `현재 아크 ‘${currentArc.title}’은 진행 상황에 따라 완료 또는 보관 처리됩니다.`
      : '이 아크가 바로 현재 아크가 됩니다.';
    if (window.confirm(`‘${arc.title}’을 현재 아크로 전환할까요? ${consequence}`)) {
      activateMutation.mutate(arc);
    }
  };

  const deletePlannedArc = (arc: Arc) => {
    if (window.confirm(`대기 중인 아크 ‘${arc.title}’을 삭제할까요? 이 미래 계획은 복구할 수 없습니다.`)) {
      deleteMutation.mutate(arc);
    }
  };

  const updateRange = (field: 'startEpisode' | 'endEpisode', value: number) => {
    setForm((current) => {
      const startEpisode = field === 'startEpisode' ? value : current.startEpisode;
      const endEpisode = field === 'endEpisode' ? value : current.endEpisode;
      return {
        ...current,
        [field]: value,
        episodeDirections: episodeDirectionsForRange(startEpisode, endEpisode, current.episodeDirections),
      };
    });
  };

  const updateMilestone = (index: number, milestone: ArcMilestone) => {
    setForm((current) => ({
      ...current,
      milestones: current.milestones.map((item, itemIndex) => itemIndex === index ? milestone : item),
    }));
  };

  const updateEpisodeDirection = (episode: number, changes: Partial<Arc['episodeDirections'][number]>) => {
    setForm((current) => ({
      ...current,
      episodeDirections: current.episodeDirections.map((item) => item.episode === episode ? { ...item, ...changes } : item),
    }));
  };

  const validate = () => {
    if (!Number.isInteger(form.startEpisode) || !Number.isInteger(form.endEpisode) || form.startEpisode < 1) {
      return '시작과 끝 회차는 양의 정수로 입력해 주세요.';
    }
    const length = form.endEpisode - form.startEpisode + 1;
    if (!form.title.trim() || !form.goal.trim() || !form.conflict.trim()) return '제목, 목표와 갈등을 모두 입력해 주세요.';
    if (form.title.trim().length > 200) return '아크 제목은 200자 이하여야 합니다.';
    if (form.goal.trim().length > 10_000 || form.conflict.trim().length > 10_000) return '아크 목표와 갈등은 각각 10,000자 이하여야 합니다.';
    if (length < 5 || length > 20) return '아크는 5화에서 20화 사이로 계획해 주세요.';
    if (project.targetEpisode && form.endEpisode > project.targetEpisode) {
      return `아크는 목표 완결 회차인 ${project.targetEpisode}화를 넘을 수 없습니다.`;
    }
    const targetId = editorTarget?.mode === 'edit' ? editorTarget.arc.id : null;
    const occupied = allArcs.filter((arc) => arc.id !== targetId && arc.status !== 'ARCHIVED');
    if (occupied.some((arc) => form.startEpisode <= arc.endEpisode && form.endEpisode >= arc.startEpisode)) {
      return '현재·이전·대기 아크의 회차 범위는 서로 겹칠 수 없습니다.';
    }
    if (project.targetEpisode) {
      const timeline = [
        ...occupied.map((arc) => ({ start: arc.startEpisode, end: arc.endEpisode })),
        { start: form.startEpisode, end: form.endEpisode },
      ].sort((left, right) => left.start - right.start || left.end - right.end);
      let nextEpisode = 1;
      for (const arc of timeline) {
        if (arc.start > nextEpisode && arc.start - nextEpisode < 5) {
          return '아크 사이에는 채울 수 없는 1–4화의 빈 구간을 남길 수 없습니다.';
        }
        nextEpisode = Math.max(nextEpisode, arc.end + 1);
      }
      const tail = project.targetEpisode - nextEpisode + 1;
      if (tail > 0 && tail < 5) return '목표 회차에 끝내거나 다음 아크를 위해 최소 5화를 남겨 주세요.';
    }
    if (!form.milestones.length) return '아크에는 하나 이상의 마일스톤이 필요합니다.';
    if (form.milestones.some((milestone) => !MILESTONE_TYPES.includes(milestone.type)
      || !Number.isInteger(milestone.episode)
      || milestone.episode < form.startEpisode || milestone.episode > form.endEpisode
      || !milestone.description.trim() || milestone.description.trim().length > 10_000)) {
      return '마일스톤의 회차, 종류와 내용을 확인해 주세요.';
    }
    const directionIssue = episodeDirectionsIssue(form.startEpisode, form.endEpisode, form.episodeDirections);
    if (directionIssue) return directionIssue;
    return '';
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const issue = validate();
    if (issue) return setError(issue);
    saveMutation.mutate();
  };

  if (arcQuery.isPending || arcsQuery.isPending) {
    return <div className="page-container"><SkeletonCards count={3} /></div>;
  }
  if (arcQuery.isError || arcsQuery.isError) {
    const reason = arcQuery.error ?? arcsQuery.error;
    return (
      <div className="page-container">
        <ErrorState
          message={messageOf(reason)}
          onRetry={() => {
            void arcQuery.refetch();
            void arcsQuery.refetch();
          }}
        />
      </div>
    );
  }

  const currentEpisode = project.lastEpisodeNumber ?? 0;
  const currentTotal = currentArc ? Math.max(1, currentArc.endEpisode - currentArc.startEpisode + 1) : 1;
  const progress = currentArc
    ? Math.max(0, Math.min(100, ((currentEpisode - currentArc.startEpisode + 1) / currentTotal) * 100))
    : 0;
  const changingArc = saveMutation.isPending || activateMutation.isPending || deleteMutation.isPending;

  return (
    <div className="page-container page-narrow">
      <header className="page-heading-row">
        <div>
          <p className="eyebrow">완결까지 이어지는 큰 흐름</p>
          <h1 className="section-title">아크 계획</h1>
          <p className="page-lead">현재와 지나온 흐름은 보호하고, 미래 계획은 전개에 맞춰 다듬을 수 있습니다.</p>
        </div>
        {!editing ? (
          <div className="page-actions">
            {(plannedArcs.length || nextArcRange) ? <Button variant="secondary" disabled={changingArc} onClick={() => setPlannerOpen(true)}><WandSparkles className="size-4" /> AI로 미래 아크 제안</Button> : null}
            {currentArc ? <Button variant="secondary" disabled={changingArc} onClick={() => beginEditArc(currentArc)}><Pencil className="size-4" /> 현재 아크 변경</Button> : null}
            {nextArcRange ? <Button disabled={changingArc} onClick={beginNewArc}><Plus className="size-4" /> 대기 아크 추가</Button> : null}
          </div>
        ) : null}
      </header>

      {!currentArc && !editing ? (
        <EmptyState
          icon={<GitBranch className="size-8" />}
          title="현재 아크가 비어 있어요"
          description={plannedArcs.length && canActivateFirstPlanned
            ? '준비된 대기 아크를 검토한 뒤 현재 아크로 전환해 주세요.'
            : plannedArcs.length
              ? '대기 아크보다 앞선 빈 구간을 먼저 계획해 주세요.'
              : '미래 아크를 먼저 계획한 뒤 현재 아크로 전환하면 집필 방향에 반영됩니다.'}
          action={plannedArcs.length && canActivateFirstPlanned
            ? <Button busy={activateMutation.isPending} disabled={changingArc} onClick={() => activatePlannedArc(plannedArcs[0]!)}>첫 대기 아크 시작</Button>
            : nextArcRange ? <Button onClick={beginNewArc}><Plus className="size-4" /> 첫 아크 계획하기</Button> : undefined}
        />
      ) : null}

      {currentArc && !editing ? (
        <section aria-labelledby="current-arc-title">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div><p className="eyebrow">집필에 적용 중인 계획</p><h2 id="current-arc-title" className="mt-1 font-story text-xl font-bold">현재 아크</h2></div>
            <ArcStatusBadge status="ACTIVE" />
          </div>
          <article className="arc-overview">
            <div className="arc-hero">
              <div><Badge tone="plum">{currentArc.startEpisode}–{currentArc.endEpisode}화</Badge><h2>{currentArc.title}</h2></div>
              <div className="arc-progress-label"><strong>{Math.round(progress)}%</strong><span>현재 {currentEpisode || currentArc.startEpisode}화</span></div>
            </div>
            <div className="progress-track" aria-label={`아크 진행률 ${Math.round(progress)}%`}><span style={{ width: `${progress}%` }} /></div>
            <div className="arc-sections">
              <section><div className="arc-section-icon"><Target className="size-5" /></div><div><span>아크 목표</span><p>{currentArc.goal}</p></div></section>
              <section><div className="arc-section-icon conflict"><GitBranch className="size-5" /></div><div><span>핵심 갈등</span><p>{currentArc.conflict}</p></div></section>
              <section><div className="arc-section-icon twist"><Sparkles className="size-5" /></div><div><span>회차별 마일스톤</span><MilestoneList milestones={currentArc.milestones} /></div></section>
              <section><div className="arc-section-icon"><Flag className="size-5" /></div><div><span>회차별 전개</span><EpisodeDirectionList arc={currentArc} /></div></section>
            </div>
          </article>
        </section>
      ) : null}

      {editing ? (
        <form className="form-card" onSubmit={submit}>
          <fieldset className="m-0 min-w-0 border-0 p-0" disabled={saveMutation.isPending}>
          <div className="form-card-heading">
            <Flag className="size-5" />
            <div>
              <h2>{editorTarget?.mode === 'new' ? '새 대기 아크 계획' : form.status === 'ACTIVE' ? '현재 아크 변경' : '대기 아크 편집'}</h2>
              <p>전체 범위는 시작과 끝을 포함해 5–20화여야 합니다.</p>
            </div>
          </div>
          {editorTarget?.mode === 'new' ? (
            <p className="mt-4 rounded-xl bg-plum-50 p-3 text-sm leading-6 text-plum-700">대기 중인 미래 계획으로 저장됩니다. 현재 아크와 이미 끝난 아크는 바뀌지 않습니다.</p>
          ) : null}
          {editorTarget?.mode === 'edit' && editorTarget.arc.status === 'ACTIVE' ? (
            <div className="warning-box mt-4" role="alert"><strong>현재 아크 보호</strong><p>이미 집필한 내용과 충돌하지 않는지 확인해 주세요. 이번 저장은 확인된 보호 아크 변경으로 처리됩니다.</p></div>
          ) : null}
          <div className="mt-6 space-y-5">
            <div><label className="field-label" htmlFor="arc-title">아크 제목</label><input id="arc-title" className="input" maxLength={200} value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} placeholder="예: 왕도의 그림자" /></div>
            <div className="grid grid-cols-2 gap-3">
              <div><label className="field-label" htmlFor="arc-start">시작 회차</label><input id="arc-start" type="number" min={1} className="input" value={form.startEpisode} onChange={(event) => updateRange('startEpisode', Number(event.target.value))} /></div>
              <div><label className="field-label" htmlFor="arc-end">끝 회차</label><input id="arc-end" type="number" min={1} className="input" value={form.endEpisode} onChange={(event) => updateRange('endEpisode', Number(event.target.value))} /></div>
            </div>
            <div><label className="field-label" htmlFor="arc-goal">목표</label><textarea id="arc-goal" className="input" maxLength={10_000} value={form.goal} onChange={(event) => setForm({ ...form, goal: event.target.value })} placeholder="아크가 끝날 때 주인공과 세계가 어떻게 달라져야 하나요?" /></div>
            <div><label className="field-label" htmlFor="arc-conflict">핵심 갈등</label><textarea id="arc-conflict" className="input" maxLength={10_000} value={form.conflict} onChange={(event) => setForm({ ...form, conflict: event.target.value })} placeholder="무엇이 목표 달성을 가로막나요?" /></div>
            <section>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div><h3 className="field-label">회차별 마일스톤</h3><p className="field-hint">목표, 반전, 고조, 클라이맥스처럼 전개를 잇는 기준점을 정합니다.</p></div>
                <Button type="button" variant="ghost" size="sm" onClick={() => setForm((current) => ({
                  ...current,
                  milestones: [...current.milestones, { episode: current.endEpisode, type: 'OTHER', description: '' }],
                }))}><Plus className="size-4" /> 마일스톤 추가</Button>
              </div>
              <div className="mt-3 space-y-3">
                {form.milestones.map((milestone, index) => (
                  <div className="grid gap-2 rounded-xl border border-line bg-paper p-3 sm:grid-cols-[5rem_8rem_minmax(0,1fr)_auto]" key={milestone.id ?? index}>
                    <label><span className="sr-only">{index + 1}번째 마일스톤 회차</span><input aria-label={`${index + 1}번째 마일스톤 회차`} className="input" type="number" min={form.startEpisode} max={form.endEpisode} value={milestone.episode} onChange={(event) => updateMilestone(index, { ...milestone, episode: Number(event.target.value) })} /></label>
                    <label><span className="sr-only">{index + 1}번째 마일스톤 종류</span><select aria-label={`${index + 1}번째 마일스톤 종류`} className="input" value={milestone.type} onChange={(event) => updateMilestone(index, { ...milestone, type: event.target.value as ArcMilestone['type'] })}>{MILESTONE_TYPES.map((type) => <option key={type} value={type}>{MILESTONE_TYPE_LABELS[type]}</option>)}</select></label>
                    <label><span className="sr-only">{index + 1}번째 마일스톤 내용</span><textarea aria-label={`${index + 1}번째 마일스톤 내용`} className="input" rows={2} maxLength={10_000} value={milestone.description} onChange={(event) => updateMilestone(index, { ...milestone, description: event.target.value })} /></label>
                    <Button type="button" variant="ghost" size="sm" disabled={form.milestones.length === 1} onClick={() => setForm((current) => ({ ...current, milestones: current.milestones.filter((_, itemIndex) => itemIndex !== index) }))}><Trash2 className="size-4" /><span className="sr-only">{index + 1}번째 마일스톤 제거</span></Button>
                  </div>
                ))}
              </div>
            </section>
            <section>
              <h3 className="field-label">회차별 전개</h3>
              <p className="field-hint">마일스톤을 자연스럽게 잇도록 아크의 모든 회차에 제목과 전개 방향을 정합니다.</p>
              <div className="mt-3 space-y-3">
                {form.episodeDirections.map((item) => (
                  <article className="rounded-xl border border-line bg-paper p-3" key={item.episode}>
                    <h4 className="text-sm font-bold text-plum-700">{item.episode}화</h4>
                    <div className="mt-2 grid gap-2 sm:grid-cols-[minmax(10rem,0.7fr)_minmax(0,1.3fr)]">
                      <label><span className="sr-only">{item.episode}화 제목</span><input aria-label={`${item.episode}화 제목`} className="input" maxLength={200} placeholder="회차 제목" value={item.title} onChange={(event) => updateEpisodeDirection(item.episode, { title: event.target.value })} /></label>
                      <label><span className="sr-only">{item.episode}화 전개 방향</span><textarea aria-label={`${item.episode}화 전개 방향`} className="input" rows={3} maxLength={20_000} placeholder="주요 사건, 감정 변화, 정보 공개와 끝 훅" value={item.direction} onChange={(event) => updateEpisodeDirection(item.episode, { direction: event.target.value })} /></label>
                    </div>
                  </article>
                ))}
              </div>
            </section>
          </div>
          <FieldError>{error}</FieldError>
          <div className="action-row mt-6"><Button type="button" variant="ghost" onClick={closeEditor}>취소</Button><Button type="submit" busy={saveMutation.isPending}>{editorTarget?.mode === 'new' ? '대기 아크 저장' : '변경 저장'}</Button></div>
          </fieldset>
        </form>
      ) : null}

      {!editing ? <FieldError>{error}</FieldError> : null}

      <ArcListSection
        id="planned-arcs"
        eyebrow="전개에 맞춰 바꿀 수 있는 계획"
        title="대기 중인 아크"
        description="아직 일어나지 않은 미래 흐름입니다. 직접 편집하거나 AI 제안을 받아 조정할 수 있습니다."
        icon={<Clock3 className="size-3" />}
        arcs={plannedArcs}
        actions={editing ? undefined : (plannedArc, index) => (
          <div className="flex flex-wrap justify-end gap-2">
            <Button size="sm" variant="secondary" disabled={changingArc} onClick={() => beginEditArc(plannedArc)}><Pencil className="size-4" /> 편집</Button>
            {index === 0 && plannedArc.startEpisode === nextActivationEpisode ? <Button size="sm" variant="secondary" busy={activateMutation.isPending && activateMutation.variables?.id === plannedArc.id} disabled={changingArc} onClick={() => activatePlannedArc(plannedArc)}>현재 아크로 전환</Button> : null}
            <Button size="sm" variant="danger" busy={deleteMutation.isPending && deleteMutation.variables?.id === plannedArc.id} disabled={changingArc} onClick={() => deletePlannedArc(plannedArc)}><Trash2 className="size-4" /> 삭제</Button>
          </div>
        )}
      />

      <ArcListSection
        id="completed-arcs"
        eyebrow="확정된 이야기 흐름 · 읽기 전용"
        title="이전 아크"
        description="이미 지나간 아크는 기록으로 보존되며 편집하거나 다시 활성화할 수 없습니다."
        icon={<History className="size-3" />}
        arcs={completedArcs}
      />

      <ArcListSection
        id="archived-arcs"
        eyebrow="대체되어 더 이상 사용하지 않는 계획 · 읽기 전용"
        title="보관된 아크"
        description="집필 도중 다른 계획으로 교체된 기록입니다. 현재 흐름에는 적용되지 않습니다."
        icon={<Archive className="size-3" />}
        arcs={archivedArcs}
      />

      <Sheet
        open={plannerOpen}
        onOpenChange={(open) => {
          if (open) setPlannerOpen(true);
          else closePlanner();
        }}
        title="AI로 미래 아크 제안"
        description="먼저 회차별 마일스톤을 정하고, 이를 잇는 모든 회차의 전개 방향을 만듭니다. 검토하기 전에는 저장되지 않아요."
        wide
        footer={proposal ? (
          <div className="action-row">
            <Button variant="secondary" busy={planMutation.isPending} onClick={requestPlan}><Sparkles className="size-4" /> 다시 제안</Button>
            <Button disabled={planMutation.isPending} onClick={useProposal}>대기 아크 편집 폼에 불러오기</Button>
          </div>
        ) : (
          <div className="action-row">
            <Button variant="ghost" onClick={closePlanner}>취소</Button>
            <Button busy={planMutation.isPending} onClick={requestPlan}><WandSparkles className="size-4" /> 제안 만들기</Button>
          </div>
        )}
      >
        {proposal ? (
          <div className="space-y-5">
            <section className="proposal-box">
              <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-story text-xl font-bold">{proposal.title}</h3><Badge tone="plum">{proposal.startEpisodeNumber}–{proposal.endEpisodeNumber}화</Badge></div>
              <dl className="mt-4 space-y-3 text-sm"><div><dt className="font-bold">목표</dt><dd className="mt-1 leading-6 text-muted">{proposal.goal}</dd></div><div><dt className="font-bold">갈등</dt><dd className="mt-1 leading-6 text-muted">{proposal.conflict}</dd></div><div><dt className="font-bold">회차별 마일스톤</dt><dd className="mt-1 leading-6 text-muted"><MilestoneList milestones={proposal.milestones} /></dd></div></dl>
            </section>
            {proposal.conflicts.length ? <div className="warning-box" role="alert"><strong className="flex items-center gap-2"><AlertTriangle className="size-4" /> 기존 설정과 확인할 충돌</strong><ul>{proposal.conflicts.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}</ul></div> : null}
            <section><h3 className="field-label">회차별 전개</h3><div className="mt-2 space-y-2">{proposal.episodeDirections.map((item) => <article className="rounded-xl border border-line bg-paper p-3" key={item.episode}><div className="flex gap-2 text-sm font-bold"><span className="text-plum-600">{item.episode}화</span><span>{item.title}</span></div><p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-muted">{item.direction}</p></article>)}</div></section>
          </div>
        ) : (
          <div>
            <label className="field-label" htmlFor="arc-plan-request">원하는 흐름 <span className="font-normal text-muted">(선택)</span></label>
            <textarea id="arc-plan-request" className="input mt-2" maxLength={10_000} value={plannerRequest} onChange={(event) => setPlannerRequest(event.target.value)} placeholder="예: 주인공이 동료의 배신을 의심하지만 마지막에는 더 큰 적의 존재가 드러나게 해 줘" />
            <p className="field-hint">비워 두면 현재 기억과 대기 중인 미래 계획을 바탕으로 그 다음 아크를 제안합니다.</p>
          </div>
        )}
        <FieldError>{plannerError}</FieldError>
      </Sheet>
    </div>
  );
}

function ArcListSection({
  id,
  eyebrow,
  title,
  description,
  icon,
  arcs,
  actions,
}: {
  id: string;
  eyebrow: string;
  title: string;
  description: string;
  icon: ReactNode;
  arcs: Arc[];
  actions?: (arc: Arc, index: number) => ReactNode;
}) {
  if (!arcs.length) return null;
  return (
    <section className="mt-8" aria-labelledby={`${id}-title`}>
      <div className="mb-3 flex items-end justify-between gap-3">
        <div><p className="eyebrow">{eyebrow}</p><h2 id={`${id}-title`} className="mt-1 font-story text-xl font-bold">{title}</h2><p className="mt-1 text-sm leading-6 text-muted">{description}</p></div>
        <Badge tone="neutral">{icon} {arcs.length}개</Badge>
      </div>
      <div className="space-y-3">
        {arcs.map((arc, index) => (
          <article className="rounded-2xl border border-line bg-surface p-4 shadow-sm" key={arc.id}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2"><Badge tone="neutral">{arc.startEpisode}–{arc.endEpisode}화</Badge><ArcStatusBadge status={arc.status} /></div>
                <h3 className="mt-2 font-story text-lg font-bold">{arc.title}</h3>
                <p className="mt-1 line-clamp-2 text-sm leading-6 text-muted">{arc.goal}</p>
              </div>
              {actions ? actions(arc, index) : null}
            </div>
            <details className="group mt-3">
              <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-lg px-2 text-sm font-semibold text-plum-700 hover:bg-plum-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-plum-500 [&::-webkit-details-marker]:hidden">
                <ChevronDown aria-hidden="true" className="size-4 shrink-0 transition-transform group-open:rotate-180" />
                <span className="sr-only">{arc.title} </span>
                <span className="group-open:hidden">자세히 보기</span>
                <span className="hidden group-open:inline">접기</span>
              </summary>
              <dl className="mt-3 space-y-4 border-t border-line pt-4 text-sm">
                <div><dt className="font-bold">아크 목표</dt><dd className="mt-1 whitespace-pre-wrap break-words leading-7">{arc.goal}</dd></div>
                <div><dt className="font-bold">핵심 갈등</dt><dd className="mt-1 whitespace-pre-wrap break-words leading-7">{arc.conflict}</dd></div>
                <div><dt className="font-bold">회차별 마일스톤</dt><dd className="mt-1 break-words leading-7"><MilestoneList milestones={arc.milestones} /></dd></div>
                <div><dt className="font-bold">회차별 전개</dt><dd className="mt-2"><EpisodeDirectionList arc={arc} /></dd></div>
              </dl>
            </details>
          </article>
        ))}
      </div>
    </section>
  );
}

function ArcStatusBadge({ status }: { status: Arc['status'] }) {
  const labels: Record<Arc['status'], string> = {
    ACTIVE: '진행 중',
    PLANNED: '대기 중',
    COMPLETE: '완료',
    ARCHIVED: '보관',
  };
  const tone = status === 'ACTIVE' ? 'plum' : status === 'COMPLETE' ? 'sage' : status === 'ARCHIVED' ? 'warning' : 'neutral';
  return <Badge tone={tone}>{labels[status]}</Badge>;
}

function MilestoneList({ milestones }: { milestones: ArcMilestone[] }) {
  if (!milestones.length) return <p className="text-sm text-muted">아직 정한 마일스톤이 없습니다.</p>;
  return (
    <ul className="mt-1 space-y-1 text-sm leading-6 text-muted">
      {[...milestones]
        .sort((left, right) => left.episode - right.episode)
        .map((milestone, index) => (
          <li key={milestone.id ?? `${milestone.episode}-${milestone.type}-${index}`}>
            <strong className="text-ink">{milestone.episode}화 · {MILESTONE_TYPE_LABELS[milestone.type]}</strong>
            {' — '}{milestone.description}
          </li>
        ))}
    </ul>
  );
}

function EpisodeDirectionList({ arc }: { arc: Pick<Arc, 'episodeDirections'> }) {
  if (!arc.episodeDirections.length) return <p className="text-sm text-muted">아직 정한 회차별 전개가 없습니다.</p>;
  return (
    <div className="mt-2 space-y-2">
      {[...arc.episodeDirections]
        .sort((left, right) => left.episode - right.episode)
        .map((item) => (
          <article className="rounded-xl border border-line bg-paper p-3" key={item.episode}>
            <div className="flex flex-wrap gap-x-2 text-sm font-bold"><span className="text-plum-600">{item.episode}화</span><span>{item.title}</span></div>
            <p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-muted">{item.direction}</p>
          </article>
        ))}
    </div>
  );
}

function findNextArcRange(
  arcs: Arc[],
  currentArc: Arc | null,
  targetEpisode: number | null,
  fallbackStart: number,
): { startEpisode: number; endEpisode: number } | null {
  const completedEnd = arcs
    .filter((arc) => arc.status === 'COMPLETE')
    .reduce((latest, arc) => Math.max(latest, arc.endEpisode), 0);
  let nextEpisode = currentArc?.endEpisode ?? completedEnd;
  nextEpisode = Math.max(nextEpisode + 1, fallbackStart);
  const planned = arcs.filter((arc) => arc.status === 'PLANNED').sort(byStartEpisode);
  for (const arc of planned) {
    if (arc.endEpisode < nextEpisode) continue;
    if (arc.startEpisode > nextEpisode) {
      const gapEnd = arc.startEpisode - 1;
      if (gapEnd - nextEpisode + 1 >= 5) return rangeInsideGap(nextEpisode, gapEnd);
    }
    nextEpisode = Math.max(nextEpisode, arc.endEpisode + 1);
  }
  if (targetEpisode !== null) {
    if (targetEpisode - nextEpisode + 1 < 5) return null;
    return rangeInsideGap(nextEpisode, targetEpisode);
  }
  return { startEpisode: nextEpisode, endEpisode: nextEpisode + 9 };
}

function rangeInsideGap(startEpisode: number, gapEnd: number): { startEpisode: number; endEpisode: number } {
  const available = gapEnd - startEpisode + 1;
  let span = Math.min(20, available);
  const remaining = available - span;
  if (remaining > 0 && remaining < 5) span -= 5 - remaining;
  return { startEpisode, endEpisode: startEpisode + span - 1 };
}
