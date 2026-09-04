import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Tabs from '@radix-ui/react-tabs';
import { AlertTriangle, ArrowLeft, BookOpenText, CheckCircle2, Globe2, LoaderCircle, Scale, Sparkles, Square } from 'lucide-react';
import { Link } from 'react-router-dom';
import { api, messageOf } from '../api/client';
import { AI_PHASE_LABELS, characterCount, createIdempotencyKey, cx } from '../lib';
import type { AiPhase, ImprovementCandidate } from '../types';
import { Badge, Button, FieldError } from '../components/Ui';
import CandidateEditor from '../components/CandidateEditor';
import { defaultCandidateSelection } from '../candidateSelection';

type Step = 'input' | 'generating' | 'compare' | 'candidates' | 'saved';
type MobileComparisonTab = 'user' | 'ai' | 'changes';

export default function ComparePage() {
  const queryClient = useQueryClient();
  const [brief, setBrief] = useState('');
  const [userText, setUserText] = useState('');
  const [generatedText, setGeneratedText] = useState('');
  const [targetChars, setTargetChars] = useState(3000);
  const [step, setStep] = useState<Step>('input');
  const [phase, setPhase] = useState<AiPhase>('idle');
  const [error, setError] = useState('');
  const [candidates, setCandidates] = useState<ImprovementCandidate[]>([]);
  const [selected, setSelected] = useState<number[]>([]);
  const [scope, setScope] = useState<'GLOBAL' | 'PROJECT'>('GLOBAL');
  const [selectedProjectId, setSelectedProjectId] = useState('');
  const [mobileTab, setMobileTab] = useState<MobileComparisonTab>('user');
  const abortRef = useRef<AbortController | null>(null);
  const acceptanceAttemptRef = useRef<{ fingerprint: string; key: string } | null>(null);
  const projectsQuery = useQuery({ queryKey: ['projects'], queryFn: api.projects.list });

  useEffect(() => () => abortRef.current?.abort(), []);

  const generate = async () => {
    if (!brief.trim() || !userText.trim()) return setError('생성 방향과 사용자 작성 원고를 모두 입력해 주세요.');
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
          if (event.type === 'stage') setPhase(event.stage === 'MEMORY' ? 'retrieving' : event.stage === 'WRITING' ? 'writing' : event.stage === 'REPAIRING' ? 'repairing' : 'checking');
          if (event.type === 'delta' || event.type === 'reset') { setPhase('writing'); setGeneratedText(content); }
          if (event.type === 'done') { setGeneratedText(event.content); setPhase('done'); }
        },
        controller.signal,
      );
      setGeneratedText(result.content);
      setPhase('done');
      setStep('compare');
    } catch (reason) {
      if (controller.signal.aborted) { setPhase('cancelled'); setStep(generatedText ? 'compare' : 'input'); }
      else { setPhase('error'); setError(messageOf(reason)); setStep('input'); }
    }
  };

  const candidateMutation = useMutation({
    mutationFn: () => api.improvements.candidates({ source: 'COMPARISON', original: generatedText, revised: userText }),
    onSuccess: ({ candidates: next }) => {
      setCandidates(next);
      setSelected(defaultCandidateSelection(next));
      acceptanceAttemptRef.current = null;
      setStep('candidates');
      setMobileTab('changes');
    },
    onError: (reason) => setError(messageOf(reason)),
  });

  const findImprovements = () => {
    setError('');
    setMobileTab('changes');
    candidateMutation.mutate();
  };

  const returnToComparison = () => {
    setStep('compare');
    setMobileTab('user');
    setError('');
  };

  const renderCandidateReview = (idPrefix: string) => (
    <div className="candidate-stage">
      <div className="compare-section-heading">
        <div><p className="eyebrow">분석 결과</p><h2>계속 적용할 규칙을 고르세요</h2><p>기본은 모든 프로젝트이며, 한 작품에만 적용할 수도 있습니다.</p></div>
        <Badge tone={scope === 'GLOBAL' ? 'sage' : 'plum'}>{scope}</Badge>
      </div>
      <fieldset className="scope-choice-panel">
        <legend className="field-label">적용 범위</legend>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          <button type="button" className={cx('option-card', scope === 'GLOBAL' && 'selected')} aria-pressed={scope === 'GLOBAL'} onClick={() => setScope('GLOBAL')}><span><Globe2 className="mr-2 inline size-4" /> 모든 프로젝트</span>{scope === 'GLOBAL' ? <CheckCircle2 className="size-4" /> : null}</button>
          <button type="button" className={cx('option-card', scope === 'PROJECT' && 'selected')} aria-pressed={scope === 'PROJECT'} onClick={() => { setScope('PROJECT'); setSelectedProjectId((current) => current || projectsQuery.data?.[0]?.id || ''); }}><span><BookOpenText className="mr-2 inline size-4" /> 특정 프로젝트</span>{scope === 'PROJECT' ? <CheckCircle2 className="size-4" /> : null}</button>
        </div>
        {scope === 'PROJECT' ? <div className="mt-3"><label className="field-label" htmlFor={`${idPrefix}-comparison-project`}>적용할 프로젝트</label><select id={`${idPrefix}-comparison-project`} className="input mt-2" value={selectedProjectId} onChange={(event) => setSelectedProjectId(event.target.value)}><option value="">프로젝트 선택</option>{(projectsQuery.data ?? []).map((project) => <option value={project.id} key={project.id}>{project.title}</option>)}</select>{projectsQuery.isError ? <FieldError>프로젝트 목록을 불러오지 못했습니다.</FieldError> : null}</div> : null}
      </fieldset>
      {candidates.length ? <div className="candidate-list">{candidates.map((candidate, index) => <CandidateEditor key={index} candidate={candidate} checked={selected.includes(index)} onCheckedChange={(checked) => setSelected((current) => checked ? [...new Set([...current, index])] : current.filter((item) => item !== index))} onChange={(updated) => setCandidates((current) => current.map((item, itemIndex) => itemIndex === index ? updated : item))} />)}</div> : <div className="success-state"><CheckCircle2 className="size-8" /><p>두 원고에서 반복 적용할 만큼 뚜렷한 차이를 찾지 못했어요.</p></div>}
      <FieldError>{error}</FieldError>
      <div className="mt-6 flex flex-wrap justify-end gap-2"><Button variant="secondary" onClick={returnToComparison}>비교로 돌아가기</Button>{candidates.length ? <Button busy={acceptMutation.isPending} disabled={!selected.length || (scope === 'PROJECT' && !selectedProjectId)} onClick={() => acceptMutation.mutate()}>선택한 개선점 저장</Button> : null}</div>
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
        {step === 'input' ? (
          <section className="compare-intro-grid">
            <div className="compare-explainer"><div className="assistant-avatar"><Scale className="size-5" /></div><h2>AI와 같은 방향으로 따로 써 보세요</h2><p>AI는 생성할 때 사용자의 원고를 보지 않습니다. 두 결과가 모두 나온 뒤 차이만 분석해, 어느 프로젝트에서도 쓸 수 있는 개선점을 찾습니다.</p><ol><li><span>1</span> 같은 생성 방향을 정해요</li><li><span>2</span> AI가 독립적으로 초안을 써요</li><li><span>3</span> 사용자 원고와 비교해 취향을 찾아요</li></ol></div>
            <div className="form-card">
              <div><label className="field-label" htmlFor="comparison-brief">생성용 방향·브리프</label><textarea id="comparison-brief" className="input min-h-32 resize-y" value={brief} onChange={(event) => setBrief(event.target.value)} placeholder="장면, 인물, 사건과 원하는 분위기를 적어 주세요." /></div>
              <div className="mt-5"><label className="field-label" htmlFor="comparison-user-text">내가 작성한 원고</label><textarea id="comparison-user-text" className="input story-input min-h-72 resize-y" value={userText} onChange={(event) => setUserText(event.target.value)} placeholder="비교할 사용자 원고를 붙여넣으세요. AI 생성 요청에는 전송되지 않습니다." /><p className="field-hint"><span>{characterCount(userText)}자</span> 이 원고는 AI 독립 초안이 완성된 뒤에만 비교에 사용돼요.</p></div>
              <div className="mt-5"><label className="field-label" htmlFor="target-chars">AI 초안 목표 글자 수</label><input id="target-chars" className="input" type="number" min={300} max={10000} step={100} value={targetChars} onChange={(event) => setTargetChars(Number(event.target.value))} /></div>
              <FieldError>{error}</FieldError><Button className="mt-6 w-full" size="lg" onClick={() => void generate()}><Sparkles className="size-4" /> 독립 초안 생성</Button>
            </div>
          </section>
        ) : null}

        {step === 'generating' ? (
          <section className="standalone-generation">
            <div className="generation-status" role="status" aria-live="polite"><LoaderCircle className="size-4 animate-spin" /><span>{AI_PHASE_LABELS[phase]}</span></div>
            <article className="story-preview tall">{generatedText || '사용자 원고를 열지 않은 채, 브리프와 저장된 전체 개선점만으로 쓰고 있어요…'}</article>
            <Button variant="secondary" onClick={() => abortRef.current?.abort()}><Square className="size-3.5 fill-current" /> 중단</Button>
          </section>
        ) : null}

        {step === 'compare' || step === 'candidates' ? (
          <section>
            {step === 'compare' ? <div className="compare-section-heading"><div><p className="eyebrow">독립 결과</p><h2>차이를 확인하세요</h2></div><Button className="hidden md:inline-flex" busy={candidateMutation.isPending} onClick={findImprovements}><Sparkles className="size-4" /> 개선점 찾기</Button></div> : null}

            <Tabs.Root value={mobileTab} onValueChange={(value) => setMobileTab(value as MobileComparisonTab)} className="mobile-compare-tabs">
              <Tabs.List className="scope-tabs" aria-label="원고 비교 작업공간">
                <Tabs.Trigger className="scope-tab" value="user">사용자 원고</Tabs.Trigger>
                <Tabs.Trigger className="scope-tab" value="ai">AI 원고</Tabs.Trigger>
                <Tabs.Trigger className="scope-tab" value="changes">변경점</Tabs.Trigger>
              </Tabs.List>
              <Tabs.Content value="user"><CompareText label="사용자 원고" text={userText} tone="revised" /></Tabs.Content>
              <Tabs.Content value="ai"><CompareText label="AI 독립 원고" text={generatedText} tone="original" /></Tabs.Content>
              <Tabs.Content value="changes">
                {step === 'candidates' ? renderCandidateReview('mobile') : (
                  <div className="mobile-change-panel">
                    <AlertTriangle className="size-7 text-plum-600" />
                    <h3>두 원고의 변경점을 분석할까요?</h3>
                    <p>AI 원고와 사용자 원고는 분석 단계에서만 함께 전달되며, 찾은 규칙은 저장 전에 편집하고 선택할 수 있어요.</p>
                    <Button busy={candidateMutation.isPending} onClick={findImprovements}><Sparkles className="size-4" /> {candidateMutation.isPending ? '변경점을 찾는 중' : '변경점 찾기'}</Button>
                    <FieldError>{error}</FieldError>
                  </div>
                )}
              </Tabs.Content>
            </Tabs.Root>

            {step === 'compare' ? (
              <div className="desktop-comparison-grid"><CompareText label="AI 독립 원고" text={generatedText} tone="original" /><CompareText label="사용자 원고" text={userText} tone="revised" /></div>
            ) : (
              <div className="hidden md:block">{renderCandidateReview('desktop')}</div>
            )}
            {step === 'compare' ? <div className="hidden md:block"><FieldError>{error}</FieldError></div> : null}
          </section>
        ) : null}

        {step === 'saved' ? <section className="completion-card"><CheckCircle2 className="size-10" /><h2>개선점을 저장했어요</h2><p>다음 AI 집필부터 {scope === 'GLOBAL' ? '모든 프로젝트' : '선택한 프로젝트'}에 이 규칙이 반영됩니다.</p><Link className="button button-primary button-md mt-5" to="/projects">프로젝트 목록으로</Link></section> : null}
      </main>
    </div>
  );
}

function CompareText({ label, text, tone }: { label: string; text: string; tone: 'original' | 'revised' }) { return <article className={`standalone-compare-pane ${tone}`}><header><span>{label}</span><small>{characterCount(text)}자</small></header><p>{text}</p></article>; }
