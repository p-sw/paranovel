import { FormEvent, useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Tabs from '@radix-ui/react-tabs';
import { BookKey, Check, Clock3, Plus, Search, Sparkles, Trash2, UserRound } from 'lucide-react';
import { useOutletContext, useParams } from 'react-router-dom';
import { api, messageOf } from '../api/client';
import { CANON_LABELS, cx } from '../lib';
import type { CanonCategory, CanonEntry } from '../types';
import type { ProjectOutletContext } from '../components/AppShell';
import { Badge, Button, ConfirmDialog, EmptyState, ErrorState, FieldError, Sheet, SkeletonCards } from '../components/Ui';

const categoryGroups: Array<{ value: 'ALL' | CanonCategory; label: string }> = [
  { value: 'ALL', label: '전체' },
  { value: 'CHARACTER', label: '인물' },
  { value: 'CHARACTER_APPEARANCE', label: '인물 외형' },
  { value: 'LOCATION', label: '장소' },
  { value: 'ORGANIZATION', label: '조직' },
  { value: 'ABILITY', label: '능력' },
  { value: 'RULE', label: '규칙' },
  { value: 'TIMELINE', label: '연표' },
  { value: 'OTHER', label: '기타' },
];

const blankEntry = {
  category: 'CHARACTER' as CanonCategory,
  name: '',
  aliases: [] as string[],
  content: '',
};

export default function CanonPage() {
  const { projectId = '' } = useParams();
  const { project } = useOutletContext<ProjectOutletContext>();
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<'ALL' | CanonCategory>('ALL');
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<CanonEntry | 'new' | null>(null);
  const [deleting, setDeleting] = useState<CanonEntry | null>(null);
  const [generated, setGenerated] = useState<Array<Partial<CanonEntry>>>([]);
  const [generatedConflicts, setGeneratedConflicts] = useState<string[]>([]);
  const [selectedGenerated, setSelectedGenerated] = useState<number[]>([]);
  const [acceptGeneratedMessage, setAcceptGeneratedMessage] = useState('');
  const [acceptGeneratedFailed, setAcceptGeneratedFailed] = useState(false);
  const canonQuery = useQuery({ queryKey: ['canon', projectId], queryFn: () => api.canon.list(projectId) });
  const generateMutation = useMutation({
    mutationFn: () => api.canon.generate(projectId),
    onSuccess: ({ suggestions, conflicts }) => {
      setGenerated(suggestions);
      setGeneratedConflicts(conflicts ?? []);
      setSelectedGenerated(suggestions.map((_, index) => index));
      setAcceptGeneratedMessage('');
      setAcceptGeneratedFailed(false);
    },
  });
  const acceptGeneratedMutation = useMutation({
    mutationFn: async () => {
      const known = [...(canonQuery.data ?? [])];
      const outcomes: Array<{ index: number; status: 'saved' | 'already' | 'failed'; error?: string }> = [];
      for (const [index, entry] of generated.entries()) {
        if (!selectedGenerated.includes(index)) continue;
        if (known.some((item) => sameCanon(item, entry))) {
          outcomes.push({ index, status: 'already' });
          continue;
        }
        try {
          const saved = await api.canon.create(projectId, {
            category: entry.category ?? 'OTHER',
            name: entry.name?.trim() || '이름 없는 설정',
            aliases: entry.aliases ?? [],
            content: entry.content?.trim() || '',
            metadata: entry.metadata ?? {},
            status: 'ACTIVE',
          });
          known.push(saved);
          outcomes.push({ index, status: 'saved' });
        } catch (reason) {
          outcomes.push({ index, status: 'failed', error: messageOf(reason) });
        }
      }

      // Canon has no bulk/idempotency endpoint. Re-read after any ambiguous
      // partial failure so a response-lost-but-saved item is not posted twice.
      let latest = known;
      if (outcomes.some((item) => item.status === 'failed')) {
        try { latest = await api.canon.list(projectId); } catch { /* keep known successes */ }
      }
      return { outcomes, latest };
    },
    onSuccess: ({ outcomes, latest }) => {
      const resolved = new Set(
        outcomes
          .filter((item) => item.status !== 'failed' || latest.some((canon) => sameCanon(canon, generated[item.index])))
          .map((item) => item.index),
      );
      const remaining = generated
        .map((entry, index) => ({ entry, index }))
        .filter(({ entry, index }) => !resolved.has(index) && !latest.some((canon) => sameCanon(canon, entry)));
      const failed = new Set(outcomes.filter((item) => item.status === 'failed' && !resolved.has(item.index)).map((item) => item.index));
      setGenerated(remaining.map(({ entry }) => entry));
      setSelectedGenerated(remaining.flatMap(({ index }, nextIndex) => failed.has(index) ? [nextIndex] : []));
      if (!remaining.length) setGeneratedConflicts([]);
      queryClient.setQueryData(['canon', projectId], latest);
      queryClient.invalidateQueries({ queryKey: ['canon', projectId] });
      const savedCount = resolved.size;
      const firstFailure = outcomes.find((item) => item.status === 'failed' && !resolved.has(item.index))?.error;
      setAcceptGeneratedFailed(failed.size > 0);
      setAcceptGeneratedMessage(failed.size
        ? `${savedCount}개는 정사로 반영했고 ${failed.size}개는 실패했습니다. 성공 항목은 목록에서 제거해 재시도 시 중복 저장되지 않습니다.${firstFailure ? ` 원인: ${firstFailure}` : ''}`
        : `${savedCount}개 설정을 정사로 반영했습니다.`);
    },
    onError: (reason) => {
      setAcceptGeneratedFailed(true);
      setAcceptGeneratedMessage(`설정 승인 중 문제가 생겼습니다: ${messageOf(reason)}`);
    },
  });
  const approveMutation = useMutation({
    mutationFn: (entry: CanonEntry) => api.canon.update(projectId, entry.id, {
      expectedRevision: entry.revision,
      status: 'ACTIVE',
    }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['canon', projectId] }),
  });
  const deleteMutation = useMutation({
    mutationFn: (entry: CanonEntry) => api.canon.remove(projectId, entry.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['canon', projectId] });
      setDeleting(null);
    },
  });
  const entries = useMemo(() => {
    const keyword = search.trim().toLocaleLowerCase('ko-KR');
    return (canonQuery.data ?? []).filter((entry) => {
      if (filter !== 'ALL' && entry.category !== filter) return false;
      if (!keyword) return true;
      return [entry.name, entry.content, ...entry.aliases].some((text) => text.toLocaleLowerCase('ko-KR').includes(keyword));
    });
  }, [canonQuery.data, filter, search]);
  const pendingCount = canonQuery.data?.filter((entry) => entry.status === 'PENDING').length ?? 0;

  return (
    <div className="page-container">
      <header className="page-heading-row">
        <div>
          <p className="eyebrow">{project.title}</p>
          <h1 className="section-title">정사·설정</h1>
          <p className="page-lead">확정된 사실만 AI 집필에 사용합니다.</p>
        </div>
        <div className="page-actions">
          <Button variant="secondary" busy={generateMutation.isPending} onClick={() => generateMutation.mutate()}>
            <Sparkles className="size-4" /> 설정 후보 찾기
          </Button>
          <Button onClick={() => setEditing('new')}><Plus className="size-4" /> 추가</Button>
        </div>
      </header>

      {pendingCount ? (
        <div className="review-banner"><Sparkles className="size-5" /><span><strong>{pendingCount}개의 설정 후보</strong>가 승인을 기다리고 있어요.</span></div>
      ) : null}
      {generateMutation.isError ? <FieldError>{messageOf(generateMutation.error)}</FieldError> : null}
      {acceptGeneratedMessage ? <div className={acceptGeneratedFailed ? 'warning-box mb-5' : 'info-box mb-5'} role={acceptGeneratedFailed ? 'alert' : 'status'}>{acceptGeneratedMessage}</div> : null}

      {generated.length ? (
        <section className="generated-canon-review" aria-labelledby="generated-canon-title">
          <div className="flex items-start justify-between gap-3">
            <div><p className="eyebrow">AI 제안 · 아직 정사 아님</p><h2 id="generated-canon-title">승인할 설정을 고르세요</h2><p>선택한 항목만 확정 정사로 저장됩니다.</p></div>
            <Badge tone="warning">{generated.length}개 후보</Badge>
          </div>
          <div className="candidate-list mt-5">
            {generated.map((entry, index) => {
              const checked = selectedGenerated.includes(index);
              return (
                <label className={cx('candidate-card', checked && 'selected')} key={`${entry.name ?? 'setting'}-${index}`}>
                  <input type="checkbox" checked={checked} onChange={() => setSelectedGenerated((current) => checked ? current.filter((item) => item !== index) : [...current, index])} />
                  <span><strong>{entry.name || '이름 없는 설정'}</strong><span>{entry.content || '내용 없음'}</span><small>{CANON_LABELS[entry.category ?? 'OTHER']}</small></span>
                </label>
              );
            })}
          </div>
          {generatedConflicts.length ? (
            <div className="warning-box mt-5" role="alert">
              <strong>승인 전에 확인할 기존 설정과의 충돌</strong>
              <ul>{generatedConflicts.map((conflict, index) => <li key={`${conflict}-${index}`}>{conflict}</li>)}</ul>
            </div>
          ) : null}
          <div className="action-row mt-5"><Button variant="ghost" onClick={() => { setGenerated([]); setGeneratedConflicts([]); setSelectedGenerated([]); setAcceptGeneratedMessage(''); setAcceptGeneratedFailed(false); }}>모두 무시</Button><Button busy={acceptGeneratedMutation.isPending} disabled={!selectedGenerated.length || generated.filter((_, index) => selectedGenerated.includes(index)).some((entry) => !entry.content?.trim())} onClick={() => acceptGeneratedMutation.mutate()}>선택한 설정 승인</Button></div>
        </section>
      ) : null}

      <div className="filter-row">
        <label className="search-field">
          <Search className="size-4" aria-hidden="true" />
          <span className="sr-only">정사 검색</span>
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="인물, 사건, 설정 검색" />
        </label>
        <Tabs.Root value={filter} onValueChange={(value) => setFilter(value as typeof filter)}>
          <Tabs.List className="filter-tabs" aria-label="정사 분류">
            {categoryGroups.map((group) => <Tabs.Trigger className="filter-chip" key={group.value} value={group.value}>{group.label}</Tabs.Trigger>)}
          </Tabs.List>
        </Tabs.Root>
      </div>

      {canonQuery.isPending ? <SkeletonCards count={6} /> : null}
      {canonQuery.isError ? <ErrorState message={messageOf(canonQuery.error)} onRetry={() => canonQuery.refetch()} /> : null}
      {!canonQuery.isPending && !entries.length ? (
        <EmptyState
          icon={<BookKey className="size-8" />}
          title={search || filter !== 'ALL' ? '조건에 맞는 설정이 없어요' : '아직 확정된 설정이 없어요'}
          description={search || filter !== 'ALL' ? '검색어나 분류를 바꿔 보세요.' : '인물과 세계의 규칙을 기록하면 AI가 매번 참고합니다.'}
          action={!search && filter === 'ALL' ? <Button onClick={() => setEditing('new')}><Plus className="size-4" /> 첫 설정 추가</Button> : undefined}
        />
      ) : null}

      {entries.length ? (
        <section className="canon-grid" aria-label="정사 목록">
          {entries.map((entry) => (
            <article className={cx('canon-card', entry.status === 'PENDING' && 'pending')} key={entry.id}>
              <button className="canon-card-main" onClick={() => setEditing(entry)}>
                <div className="flex items-center justify-between gap-2">
                  <Badge tone={entry.status === 'PENDING' ? 'warning' : 'neutral'}>
                    {entry.category === 'CHARACTER' || entry.category === 'CHARACTER_APPEARANCE' ? <UserRound className="size-3" /> : null}
                    {CANON_LABELS[entry.category]}
                  </Badge>
                  {entry.status === 'PENDING' ? <span className="flex items-center gap-1 text-xs font-semibold text-amber-800"><Clock3 className="size-3.5" /> 검토 필요</span> : null}
                </div>
                <h2>{entry.name}</h2>
                {entry.aliases.length ? <p className="aliases">{entry.aliases.join(' · ')}</p> : null}
                <p className="canon-content">{entry.content}</p>
              </button>
              <div className="canon-card-actions">
                {entry.status === 'PENDING' ? <Button size="sm" onClick={() => approveMutation.mutate(entry)}><Check className="size-4" /> 정사로 승인</Button> : null}
                <button onClick={() => setDeleting(entry)} aria-label={`${entry.name} 삭제`}><Trash2 className="size-4" /></button>
              </div>
            </article>
          ))}
        </section>
      ) : null}

      <CanonEditor open={Boolean(editing)} onOpenChange={(open) => !open && setEditing(null)} projectId={projectId} entry={editing === 'new' ? null : editing} />
      <ConfirmDialog
        open={Boolean(deleting)}
        onOpenChange={(open) => !open && setDeleting(null)}
        title="정사에서 삭제할까요?"
        description={`‘${deleting?.name ?? ''}’ 설정은 이후 AI 집필에서 더 이상 참조되지 않습니다.`}
        onConfirm={() => deleting && deleteMutation.mutate(deleting)}
        busy={deleteMutation.isPending}
      />
    </div>
  );
}

function CanonEditor({
  open,
  onOpenChange,
  projectId,
  entry,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  entry: CanonEntry | null;
}) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState(blankEntry);
  const [aliasesText, setAliasesText] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setForm(entry ? { category: entry.category, name: entry.name, aliases: entry.aliases, content: entry.content } : blankEntry);
    setAliasesText(entry?.aliases.join(', ') ?? '');
    setError('');
  }, [entry, open]);

  const mutation = useMutation({
    mutationFn: () => {
      const payload = {
        category: form.category,
        name: form.name.trim(),
        aliases: aliasesText.split(',').map((item) => item.trim()).filter(Boolean),
        content: form.content.trim(),
        metadata: entry?.metadata ?? {},
        status: entry?.status === 'PENDING' ? ('PENDING' as const) : ('ACTIVE' as const),
      };
      return entry
        ? api.canon.update(projectId, entry.id, { ...payload, expectedRevision: entry.revision })
        : api.canon.create(projectId, payload);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['canon', projectId] });
      onOpenChange(false);
    },
    onError: (reason) => setError(messageOf(reason)),
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!form.name.trim() || !form.content.trim()) return setError('이름과 확정 내용을 입력해 주세요.');
    mutation.mutate();
  };

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={entry ? '정사 편집' : '정사 추가'}
      description="확실하게 정해진 사실만 기록하세요. 저장 즉시 AI 컨텍스트에 반영됩니다."
      footer={<div className="action-row"><Button variant="ghost" onClick={() => onOpenChange(false)}>취소</Button><Button busy={mutation.isPending} onClick={() => mutation.mutate()} disabled={!form.name.trim() || !form.content.trim()}>저장</Button></div>}
    >
      <form className="space-y-5" onSubmit={submit}>
        <div><label className="field-label" htmlFor="canon-category">분류</label><select id="canon-category" className="input" value={form.category} onChange={(event) => setForm({ ...form, category: event.target.value as CanonCategory })}>{categoryGroups.slice(1).map((group) => <option value={group.value} key={group.value}>{group.label}</option>)}</select></div>
        <div><label className="field-label" htmlFor="canon-name">이름</label><input id="canon-name" className="input" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="예: 세라 벨로아" /></div>
        <div><label className="field-label" htmlFor="canon-aliases">별칭</label><input id="canon-aliases" className="input" value={aliasesText} onChange={(event) => setAliasesText(event.target.value)} placeholder="쉼표로 구분" /></div>
        <div>
          <label className="field-label" htmlFor="canon-content">확정 내용</label>
          {form.category === 'CHARACTER_APPEARANCE' ? <p id="canon-appearance-guide" className="mb-2 text-sm text-muted">인물과 같은 이름을 사용하고 머리카락 색·길이·스타일, 눈동자 색, 피부색, 체형, 옷의 종류·색·소재, 신발, 장신구, 특징적인 흉터 등을 기록하세요. 평소 외형과 특정 장면의 복장을 구분하고, 미정인 정보는 미정으로 남겨 두세요.</p> : null}
          <textarea id="canon-content" className="input" value={form.content} onChange={(event) => setForm({ ...form, content: event.target.value })} aria-describedby={form.category === 'CHARACTER_APPEARANCE' ? 'canon-appearance-guide' : undefined} placeholder={form.category === 'CHARACTER_APPEARANCE' ? '머리카락: 은빛, 허리까지 오는 긴 생머리\n눈동자: 짙은 보라색\n피부: 밝은 올리브색\n체형: 키가 크고 마른 체격\n평소 복장: 남색 벨벳 코트와 검은 장화\n장신구: 왼쪽 귀의 은색 초승달 귀걸이\n기타 특징: 오른쪽 눈썹 위의 작은 흉터' : '외형, 성격, 과거, 관계나 변하지 않는 규칙을 명확하게 적어 주세요.'} />
        </div>
        <FieldError>{error}</FieldError>
      </form>
    </Sheet>
  );
}

function sameCanon(existing: CanonEntry, candidate: Partial<CanonEntry>): boolean {
  const candidateName = candidate.name?.trim() || '이름 없는 설정';
  return existing.category === (candidate.category ?? 'OTHER') &&
    existing.name.trim().toLocaleLowerCase('ko-KR') === candidateName.toLocaleLowerCase('ko-KR') &&
    existing.content.trim() === (candidate.content ?? '').trim();
}
