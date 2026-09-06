import { FormEvent, useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Tabs from '@radix-ui/react-tabs';
import { CheckCircle2, Globe2, Plus, Scale, Sparkles, Trash2 } from 'lucide-react';
import { Link, useOutletContext, useParams } from 'react-router-dom';
import { api, messageOf } from '../api/client';
import type { Improvement } from '../types';
import type { ProjectOutletContext } from '../components/AppShell';
import { Badge, Button, ConfirmDialog, EmptyState, ErrorState, FieldError, Sheet, SkeletonCards } from '../components/Ui';

export default function ImprovementsPage() {
  const { projectId = '' } = useParams();
  const { project } = useOutletContext<ProjectOutletContext>();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<'PROJECT' | 'GLOBAL'>('PROJECT');
  const [editing, setEditing] = useState<Improvement | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Improvement | null>(null);
  const improvementsQuery = useQuery({
    queryKey: ['improvements', projectId],
    queryFn: () => api.improvements.list(projectId),
  });
  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.improvements.remove(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['improvements', projectId] });
      setDeleting(null);
    },
  });
  const improvements = (improvementsQuery.data ?? []).filter((item) => item.scope === tab);

  return (
    <div className="page-container">
      <header className="page-heading-row">
        <div><p className="eyebrow">계속 나아지는 집필 습관</p><h1 className="section-title">개선점</h1><p className="page-lead">저장된 규칙은 프로젝트 설정의 작문 디렉션을 보완하며 이후 AI 집필에 빠짐없이 반영됩니다.</p></div>
        <div className="page-actions"><Link to="/compare" className="button button-secondary button-md"><Scale className="size-4" /> 두 원고 비교</Link><Button onClick={() => setEditing('new')}><Plus className="size-4" /> 직접 추가</Button></div>
      </header>

      <Tabs.Root value={tab} onValueChange={(value) => setTab(value as typeof tab)}>
        <Tabs.List className="scope-tabs" aria-label="개선점 범위">
          <Tabs.Trigger className="scope-tab" value="PROJECT"><Sparkles className="size-4" /> 이 프로젝트</Tabs.Trigger>
          <Tabs.Trigger className="scope-tab" value="GLOBAL"><Globe2 className="size-4" /> 모든 프로젝트</Tabs.Trigger>
        </Tabs.List>
      </Tabs.Root>
      <div className="scope-note"><CheckCircle2 className="size-4" /><span>{tab === 'PROJECT' ? `‘${project.title}’ 집필에만 적용됩니다.` : '모든 프로젝트의 집필에 공통으로 적용됩니다.'}</span></div>

      {improvementsQuery.isPending ? <SkeletonCards count={4} /> : null}
      {improvementsQuery.isError ? <ErrorState message={messageOf(improvementsQuery.error)} onRetry={() => improvementsQuery.refetch()} /> : null}
      {!improvementsQuery.isPending && !improvements.length ? (
        <EmptyState icon={<Sparkles className="size-8" />} title={tab === 'PROJECT' ? '프로젝트 개선점이 없어요' : '공통 개선점이 없어요'} description="문장을 직접 고치거나 두 원고를 비교하면 반복해서 적용할 글쓰기 규칙을 찾을 수 있어요." action={<Button onClick={() => setEditing('new')}><Plus className="size-4" /> 개선점 추가</Button>} />
      ) : null}
      {improvements.length ? (
        <section className="improvement-list" aria-label="적용 중인 개선점">
          {improvements.map((item) => (
            <article className="improvement-card" key={item.id}>
              <button className="improvement-main" onClick={() => setEditing(item)}>
                <div className="flex flex-wrap items-center gap-2"><Badge tone={item.scope === 'GLOBAL' ? 'sage' : 'plum'}>{item.scope === 'GLOBAL' ? '전체 적용' : '프로젝트 적용'}</Badge>{item.source ? <Badge>{sourceLabel(item.source)}</Badge> : null}</div>
                <h2>{item.title}</h2><p className="rule-text">{item.rule}</p>{item.rationale ? <p className="rationale">{item.rationale}</p> : null}
                {item.tags.length ? <div className="mt-4 flex flex-wrap gap-1.5">{item.tags.map((tag) => <span className="micro-tag" key={tag}>#{tag}</span>)}</div> : null}
              </button>
              <button className="card-delete" aria-label={`${item.title} 삭제`} onClick={() => setDeleting(item)}><Trash2 className="size-4" /></button>
            </article>
          ))}
        </section>
      ) : null}

      <ImprovementEditor open={Boolean(editing)} onOpenChange={(open) => !open && setEditing(null)} projectId={projectId} defaultScope={tab} item={editing === 'new' ? null : editing} />
      <ConfirmDialog open={Boolean(deleting)} onOpenChange={(open) => !open && setDeleting(null)} title="개선점을 삭제할까요?" description="삭제하면 다음 AI 집필부터 이 규칙이 적용되지 않습니다." onConfirm={() => deleting && deleteMutation.mutate(deleting.id)} busy={deleteMutation.isPending} />
    </div>
  );
}

function ImprovementEditor({ open, onOpenChange, projectId, defaultScope, item }: { open: boolean; onOpenChange: (open: boolean) => void; projectId: string; defaultScope: 'PROJECT' | 'GLOBAL'; item: Improvement | null }) {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState(item?.title ?? '');
  const [rule, setRule] = useState(item?.rule ?? '');
  const [rationale, setRationale] = useState(item?.rationale ?? '');
  const [tags, setTags] = useState(item?.tags.join(', ') ?? '');
  const [scope, setScope] = useState<'PROJECT' | 'GLOBAL'>(item?.scope ?? defaultScope);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!open) return;
    setTitle(item?.title ?? '');
    setRule(item?.rule ?? '');
    setRationale(item?.rationale ?? '');
    setTags(item?.tags.join(', ') ?? '');
    setScope(item?.scope ?? defaultScope);
    setError('');
  }, [defaultScope, item, open]);
  const mutation = useMutation({
    mutationFn: () => {
      const payload = { title: title.trim(), rule: rule.trim(), rationale: rationale.trim(), tags: tags.split(',').map((tag) => tag.trim()).filter(Boolean), scope, projectId: scope === 'PROJECT' ? projectId : null, source: item?.source ?? ('MANUAL' as const) };
      return item
        ? api.improvements.update(item.id, { ...payload, expectedRevision: item.revision })
        : api.improvements.create(payload);
    },
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['improvements', projectId] }); onOpenChange(false); },
    onError: (reason) => setError(messageOf(reason)),
  });
  const submit = (event: FormEvent) => { event.preventDefault(); if (!title.trim() || !rule.trim()) return setError('제목과 적용할 규칙을 입력해 주세요.'); mutation.mutate(); };

  return <Sheet open={open} onOpenChange={onOpenChange} title={item ? '개선점 편집' : '개선점 추가'} description="짧고 명확한 명령문으로 쓰면 AI가 더 안정적으로 따릅니다." footer={<div className="action-row"><Button variant="ghost" onClick={() => onOpenChange(false)}>취소</Button><Button busy={mutation.isPending} onClick={() => mutation.mutate()} disabled={!title.trim() || !rule.trim()}>저장</Button></div>}>
    <form className="space-y-5" onSubmit={submit}>
      <fieldset><legend className="field-label">적용 범위</legend><div className="mt-2 grid grid-cols-2 gap-2"><button type="button" className={`option-card ${scope === 'PROJECT' ? 'selected' : ''}`} onClick={() => setScope('PROJECT')}>이 프로젝트</button><button type="button" className={`option-card ${scope === 'GLOBAL' ? 'selected' : ''}`} onClick={() => setScope('GLOBAL')}>모든 프로젝트</button></div></fieldset>
      <div><label className="field-label" htmlFor="improvement-title">제목</label><input id="improvement-title" className="input" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="예: 감정을 행동으로 보여주기" /></div>
      <div><label className="field-label" htmlFor="improvement-rule">항상 적용할 규칙</label><textarea id="improvement-rule" className="input" value={rule} onChange={(event) => setRule(event.target.value)} placeholder="감정을 직접 설명하기보다 몸짓, 선택, 대사로 먼저 드러낸다." /></div>
      <div><label className="field-label" htmlFor="improvement-reason">이유</label><textarea id="improvement-reason" className="input" value={rationale} onChange={(event) => setRationale(event.target.value)} placeholder="왜 이 규칙이 중요한지 적어 주세요." /></div>
      <div><label className="field-label" htmlFor="improvement-tags">태그</label><input id="improvement-tags" className="input" value={tags} onChange={(event) => setTags(event.target.value)} placeholder="문체, 대화, 감정 (쉼표로 구분)" /></div><FieldError>{error}</FieldError>
    </form>
  </Sheet>;
}

function sourceLabel(source: Improvement['source']): string { return source === 'EDITOR' ? '문장 수정' : source === 'COMPARISON' ? '원고 비교' : '직접 입력'; }
