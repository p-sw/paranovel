import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Tabs from '@radix-ui/react-tabs';
import { ArrowLeft, BookOpenText, CheckCircle2, Globe2, LoaderCircle, Scale, Sparkles, Square } from 'lucide-react';
import { Link } from 'react-router-dom';
import { api, messageOf } from '../api/client';
import { AI_PHASE_LABELS, characterCount, createIdempotencyKey, cx } from '../lib';
import type { AiPhase, ImprovementCandidate } from '../types';
import { Badge, Button, FieldError } from '../components/Ui';
import CandidateEditor from '../components/CandidateEditor';
import { defaultCandidateSelection } from '../candidateSelection';

type Step = 'input' | 'generating' | 'compare' | 'candidates' | 'saved';
type ComparisonMode = 'brief' | 'manuscripts';
type ComparisonTab = 'before' | 'after' | 'changes';

export default function ComparePage() {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<ComparisonMode>('brief');
  const [brief, setBrief] = useState('');
  const [generatedText, setGeneratedText] = useState('');
  const [revisedDraft, setRevisedDraft] = useState('');
  const [beforeText, setBeforeText] = useState('');
  const [afterText, setAfterText] = useState('');
  const [targetChars, setTargetChars] = useState(3000);
  const [step, setStep] = useState<Step>('input');
  const [phase, setPhase] = useState<AiPhase>('idle');
  const [error, setError] = useState('');
  const [candidates, setCandidates] = useState<ImprovementCandidate[]>([]);
  const [selected, setSelected] = useState<number[]>([]);
  const [scope, setScope] = useState<'GLOBAL' | 'PROJECT'>('GLOBAL');
  const [selectedProjectId, setSelectedProjectId] = useState('');
  const [comparisonTab, setComparisonTab] = useState<ComparisonTab>('before');
  const abortRef = useRef<AbortController | null>(null);
  const acceptanceAttemptRef = useRef<{ fingerprint: string; key: string } | null>(null);
  const projectsQuery = useQuery({ queryKey: ['projects'], queryFn: api.projects.list });
  const original = mode === 'brief' ? generatedText : beforeText;
  const revised = mode === 'brief' ? revisedDraft : afterText;

  useEffect(() => () => abortRef.current?.abort(), []);

  const generate = async () => {
    if (abortRef.current) return;
    if (!brief.trim()) return setError('공통 방향·브리프를 입력해 주세요.');
    if (!Number.isInteger(targetChars) || targetChars < 300 || targetChars > 10000) return setError('목표 글자 수는 300~10,000 사이의 정수로 입력해 주세요.');
    setGeneratedText('');
    setError('');
    setStep('generating');
    setPhase('retrieving');
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const result = await api.comparisons.generate(
        { brief: brief.trim(), targetChars },
        (event, content) => {
          if (controller.signal.aborted || abortRef.current !== controller) return;
          if (event.type === 'stage') setPhase(event.stage === 'MEMORY' ? 'retrieving' : event.stage === 'WRITING' ? 'writing' : event.stage === 'REPAIRING' ? 'repairing' : 'checking');
          if (event.type === 'delta' || event.type === 'reset') { setPhase('writing'); setGeneratedText(content); }
          if (event.type === 'done') { setGeneratedText(event.content); setPhase('done'); }
        },
        controller.signal,
      );
      if (controller.signal.aborted || abortRef.current !== controller) return;
      if (!result.content.trim()) throw new Error('AI 초안이 비어 있어요. 다시 생성해 주세요.');
      setGeneratedText(result.content);
      setRevisedDraft('');
      setPhase('done');
      setStep('compare');
      setComparisonTab('before');
    } catch (reason) {
      if (controller.signal.aborted || abortRef.current !== controller) return;
      setGeneratedText('');
      setPhase('error');
      setError(messageOf(reason));
      setStep('input');
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  };

  const cancelGeneration = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setGeneratedText('');
    setPhase('cancelled');
    setStep('input');
  };

  const candidateMutation = useMutation({
    mutationFn: (texts: { original: string; revised: string }) => api.improvements.candidates({ source: 'COMPARISON', ...texts }),
    onSuccess: ({ candidates: next }) => {
      setCandidates(next);
      setSelected(defaultCandidateSelection(next));
      acceptanceAttemptRef.current = null;
      setStep('candidates');
      setComparisonTab('changes');
    },
    onError: (reason) => setError(messageOf(reason)),
  });

  const findImprovements = () => {
    if (candidateMutation.isPending) return;
    if (!original.trim() || !revised.trim()) return setError('전 원고와 후 원고를 모두 입력해 주세요.');
    if (original.trim() === revised.trim()) return setError('전 원고와 후 원고가 같아요. 후 원고를 수정한 뒤 비교해 주세요.');
    setError('');
    setComparisonTab('changes');
    candidateMutation.mutate({ original, revised });
  };

  const returnToComparison = () => {
    setStep('compare');
    setComparisonTab('after');
    setError('');
  };

  const changeMode = (nextMode: ComparisonMode) => {
    if (mode === nextMode) return;
    setMode(nextMode);
    setStep(nextMode === 'brief' && !generatedText ? 'input' : 'compare');
    setComparisonTab('before');
    setCandidates([]);
    setSelected([]);
    setError('');
    acceptanceAttemptRef.current = null;
  };

  const renderCandidateReview = () => (
    <div className="candidate-stage">
      <div className="compare-section-heading">
        <div><p className="eyebrow">전 원고 대비 후 원고의 개선점</p><h2>계속 적용할 규칙을 고르세요</h2><p>기본은 모든 프로젝트이며, 한 작품에만 적용할 수도 있습니다.</p></div>
        <Badge tone={scope === 'GLOBAL' ? 'sage' : 'plum'}>{scope}</Badge>
      </div>
      <fieldset className="scope-choice-panel">
        <legend className="field-label">적용 범위</legend>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          <button type="button" className={cx('option-card', scope === 'GLOBAL' && 'selected')} aria-pressed={scope === 'GLOBAL'} onClick={() => setScope('GLOBAL')}><span><Globe2 className="mr-2 inline size-4" /> 모든 프로젝트</span>{scope === 'GLOBAL' ? <CheckCircle2 className="size-4" /> : null}</button>
          <button type="button" className={cx('option-card', scope === 'PROJECT' && 'selected')} aria-pressed={scope === 'PROJECT'} onClick={() => { setScope('PROJECT'); setSelectedProjectId((current) => current || projectsQuery.data?.[0]?.id || ''); }}><span><BookOpenText className="mr-2 inline size-4" /> 특정 프로젝트</span>{scope === 'PROJECT' ? <CheckCircle2 className="size-4" /> : null}</button>
        </div>
        {scope === 'PROJECT' ? <div className="mt-3"><label className="field-label" htmlFor="comparison-project">적용할 프로젝트</label><select id="comparison-project" className="input mt-2" value={selectedProjectId} onChange={(event) => setSelectedProjectId(event.target.value)}><option value="">프로젝트 선택</option>{(projectsQuery.data ?? []).map((project) => <option value={project.id} key={project.id}>{project.title}</option>)}</select>{projectsQuery.isError ? <FieldError>프로젝트 목록을 불러오지 못했습니다.</FieldError> : null}</div> : null}
      </fieldset>
      {candidates.length ? <div className="candidate-list">{candidates.map((candidate, index) => <CandidateEditor key={index} candidate={candidate} checked={selected.includes(index)} onCheckedChange={(checked) => setSelected((current) => checked ? [...new Set([...current, index])] : current.filter((item) => item !== index))} onChange={(updated) => setCandidates((current) => current.map((item, itemIndex) => itemIndex === index ? updated : item))} />)}</div> : <div className="success-state"><CheckCircle2 className="size-8" /><p>두 원고에서 반복 적용할 만큼 뚜렷한 차이를 찾지 못했어요.</p></div>}
      <FieldError>{error}</FieldError>
      <div className="action-row mt-6"><Button variant="secondary" disabled={acceptMutation.isPending} onClick={returnToComparison}>비교로 돌아가기</Button>{candidates.length ? <Button busy={acceptMutation.isPending} disabled={!selected.length || (scope === 'PROJECT' && !selectedProjectId)} onClick={() => acceptMutation.mutate()}>선택한 개선점 저장</Button> : null}</div>
    </div>
  );
  const acceptMutation = useMutation({
    mutationFn: () => {
      const payload = {
        ...(scope === 'PROJECT' ? { projectId: selectedProjectId } : {}),
        candidates: candidates.filter((_, index) => selected.includes(index)),
      };
      const fingerprint = JSON.stringify(payload);
      if (acceptanceAttemptRef.current?.fingerprint !== fingerprint) {
        acceptanceAttemptRef.current = { fingerprint, key: createIdempotencyKey() };
      }
      return api.improvements.accept(payload, acceptanceAttemptRef.current.key);
    },
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['improvements'] }); setStep('saved'); },
    onError: (reason) => setError(messageOf(reason)),
  });

  return (
    <div className="compare-page">
      <header className="compare-header">
        <Link className="icon-button" to="/projects" aria-label="프로젝트 목록으로 돌아가기"><ArrowLeft className="size-5" /></Link>
        <div className="min-w-0"><p className="eyebrow">독립 원고 실험실</p><h1>두 원고 비교</h1></div>
        <Badge tone={scope === 'GLOBAL' ? 'sage' : 'plum'}>{scope === 'GLOBAL' ? <Globe2 className="size-3" /> : <BookOpenText className="size-3" />} {scope === 'GLOBAL' ? '전체 적용 후보' : '프로젝트 적용 후보'}</Badge>
      </header>

      <main className="compare-main">
        {step !== 'saved' ? (
          <fieldset className="mb-6" disabled={step === 'generating' || candidateMutation.isPending || acceptMutation.isPending}>
            <legend className="field-label mb-2">비교 방식</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              <button type="button" className={cx('option-card', mode === 'brief' && 'selected')} aria-pressed={mode === 'brief'} onClick={() => changeMode('brief')}>
                <span><strong className="block">공통 방향·브리프</strong><span className="mt-1 block text-xs font-normal">AI 초안을 만든 뒤 수정 원고와 비교해요.</span></span>
                {mode === 'brief' ? <CheckCircle2 className="size-4" /> : null}
              </button>
              <button type="button" className={cx('option-card', mode === 'manuscripts' && 'selected')} aria-pressed={mode === 'manuscripts'} onClick={() => changeMode('manuscripts')}>
                <span><strong className="block">원고만 입력</strong><span className="mt-1 block text-xs font-normal">전·후 원고를 직접 입력해 비교해요.</span></span>
                {mode === 'manuscripts' ? <CheckCircle2 className="size-4" /> : null}
              </button>
            </div>
          </fieldset>
        ) : null}

        {step === 'input' ? (
          <section className="compare-intro-grid">
            <div className="compare-explainer"><div className="assistant-avatar"><Scale className="size-5" /></div><h2>공통 방향으로 쓴 AI 초안을 고쳐 보세요</h2><p>브리프를 바탕으로 AI가 먼저 초안을 씁니다. 완성된 초안을 확인한 뒤 수정 원고를 입력하면, 수정에서 드러난 개선점을 찾습니다.</p><ol><li><span>1</span> 공통 방향·브리프를 입력해요</li><li><span>2</span> AI가 생성한 초안을 확인해요</li><li><span>3</span> 수정 원고를 입력하고 개선점을 찾아요</li></ol></div>
            <div className="form-card">
              <div><label className="field-label" htmlFor="comparison-brief">공통 방향·브리프</label><textarea id="comparison-brief" className="input" maxLength={30000} value={brief} onChange={(event) => setBrief(event.target.value)} placeholder="장면, 인물, 사건과 원하는 분위기를 적어 주세요." /></div>
              <div className="mt-5"><label className="field-label" htmlFor="target-chars">AI 초안 목표 글자 수</label><input id="target-chars" className="input" type="number" min={300} max={10000} step={100} value={targetChars} onChange={(event) => setTargetChars(Number(event.target.value))} /></div>
              <FieldError>{error}</FieldError><Button className="mt-6 w-full" size="lg" onClick={() => void generate()}><Sparkles className="size-4" /> AI 초안 생성</Button>
              {generatedText ? <Button className="mt-2 w-full" variant="secondary" onClick={returnToComparison}>기존 초안 비교로 돌아가기</Button> : null}
            </div>
          </section>
        ) : null}

        {step === 'generating' ? (
          <section className="standalone-generation">
            <div className="generation-status" role="status" aria-live="polite"><LoaderCircle className="size-4 animate-spin" /><span>{AI_PHASE_LABELS[phase]}</span></div>
            <article className="story-preview tall">{generatedText || '공통 브리프와 저장된 전체 개선점을 바탕으로 AI 초안을 쓰고 있어요…'}</article>
            <Button variant="secondary" onClick={cancelGeneration}><Square className="size-3.5 fill-current" /> 중단</Button>
          </section>
        ) : null}

        {step === 'compare' || step === 'candidates' ? (
          <section>
            {step === 'compare' ? <div className="compare-section-heading"><div><p className="eyebrow">{mode === 'brief' ? 'AI 초안 확인 · 수정 원고 입력' : '전·후 원고 직접 입력'}</p><h2>{mode === 'brief' ? 'AI 초안을 확인하고 수정 원고를 입력하세요' : '비교할 전·후 원고를 입력하세요'}</h2><p>{mode === 'brief' ? 'AI 초안이 전 원고입니다. 직접 수정한 내용을 후 원고에 입력해 주세요.' : '수정 전 원고와 수정 후 원고를 각각 붙여넣어 주세요.'} 전 원고 대비 후 원고의 개선점을 추출합니다.</p></div></div> : null}

            <Tabs.Root value={comparisonTab} onValueChange={(value) => setComparisonTab(value as ComparisonTab)} className="comparison-workspace">
              <Tabs.List className="scope-tabs" aria-label="원고 비교 작업공간">
                <Tabs.Trigger className="scope-tab" value="before">{mode === 'brief' ? '전 원고 · AI' : '전 원고'}</Tabs.Trigger>
                <Tabs.Trigger className="scope-tab" value="after">후 원고</Tabs.Trigger>
                <Tabs.Trigger className="scope-tab" value="changes">개선점</Tabs.Trigger>
              </Tabs.List>
              <div className={cx('grid gap-4', step === 'compare' && 'md:grid-cols-2')}>
                <Tabs.Content forceMount value="before" className={cx('data-[state=inactive]:hidden', step === 'compare' ? 'md:data-[state=inactive]:block' : 'md:hidden')}>
                  <CompareText id="comparison-before" label={mode === 'brief' ? '전 원고 · AI 초안' : '전 원고'} text={original} tone="original" onChange={mode === 'manuscripts' && step === 'compare' ? setBeforeText : undefined} disabled={candidateMutation.isPending} placeholder="수정 전 원고를 입력하거나 붙여넣으세요." />
                </Tabs.Content>
                <Tabs.Content forceMount value="after" className={cx('data-[state=inactive]:hidden', step === 'compare' ? 'md:data-[state=inactive]:block' : 'md:hidden')}>
                  <CompareText id="comparison-after" label="후 원고" text={revised} tone="revised" onChange={step === 'compare' ? (mode === 'brief' ? setRevisedDraft : setAfterText) : undefined} disabled={candidateMutation.isPending} placeholder={mode === 'brief' ? 'AI 초안을 확인한 뒤, 직접 수정한 원고를 입력하거나 붙여넣으세요.' : '수정 후 원고를 입력하거나 붙여넣으세요.'} />
                </Tabs.Content>
                <Tabs.Content forceMount value="changes" className={cx('data-[state=inactive]:hidden', step === 'compare' ? 'md:hidden' : 'md:data-[state=inactive]:block')}>
                  {step === 'candidates' ? renderCandidateReview() : (
                    <div className="mobile-change-panel">
                      {candidateMutation.isPending ? <LoaderCircle className="size-7 animate-spin text-plum-600" /> : <Scale className="size-7 text-plum-600" />}
                      <h3 role="status">{candidateMutation.isPending ? '후 원고의 개선점을 찾고 있어요' : '전 원고보다 어떤 점이 좋아졌나요?'}</h3>
                      <p>전 원고 대비 후 원고에서 나아진 점을 재사용할 수 있는 규칙으로 추출합니다. 찾은 규칙은 저장 전에 편집하고 선택할 수 있어요.</p>
                    </div>
                  )}
                </Tabs.Content>
              </div>
            </Tabs.Root>

            {step === 'compare' ? (
              <div className="mt-5">
                <FieldError>{error}</FieldError>
                <div className="action-row">
                  {mode === 'brief' ? <Button variant="secondary" disabled={candidateMutation.isPending} onClick={() => { setStep('input'); setError(''); }}>브리프 수정</Button> : null}
                  <Button busy={candidateMutation.isPending} onClick={findImprovements}><Sparkles className="size-4" /> 개선점 찾기</Button>
                </div>
              </div>
            ) : null}
          </section>
        ) : null}

        {step === 'saved' ? <section className="completion-card"><CheckCircle2 className="size-10" /><h2>개선점을 저장했어요</h2><p>다음 AI 집필부터 {scope === 'GLOBAL' ? '모든 프로젝트' : '선택한 프로젝트'}에 이 규칙이 반영됩니다.</p><Link className="button button-primary button-md mt-5" to="/projects">프로젝트 목록으로</Link></section> : null}
      </main>
    </div>
  );
}

function CompareText({ id, label, text, tone, onChange, disabled, placeholder }: {
  id: string;
  label: string;
  text: string;
  tone: 'original' | 'revised';
  onChange?: (text: string) => void;
  disabled?: boolean;
  placeholder?: string;
}) {
  return (
    <article className={`standalone-compare-pane ${tone}`}>
      <header>{onChange ? <label htmlFor={id}>{label}</label> : <span>{label}</span>}<small>{characterCount(text)}자</small></header>
      {onChange ? <textarea id={id} className="comparison-textarea" value={text} onChange={(event) => onChange(event.target.value)} disabled={disabled} maxLength={200000} placeholder={placeholder} /> : <p>{text}</p>}
    </article>
  );
}
