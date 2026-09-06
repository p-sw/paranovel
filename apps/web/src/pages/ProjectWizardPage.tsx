import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight, Check, Feather, LoaderCircle, Plus, Sparkles, Trash2, X } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { api, ApiError, isConflict, messageOf } from '../api/client';
import { CANON_LABELS, GENRE_SUGGESTIONS, cx } from '../lib';
import type { CanonCategory, ProjectBlueprint, ProjectSessionResult, SetupAnswerRecord, SetupQuestion } from '../types';
import { Button, FieldError } from '../components/Ui';

const SESSION_KEY = 'paranovel.project-session';
type AnswerDraft = { answer: string | string[]; otherSelected: boolean; otherText: string };
const emptyDraft = (): AnswerDraft => ({ answer: '', otherSelected: false, otherText: '' });
const isOtherOption = (value: string) => /^(기타(?:\s*\(직접\s*입력\))?|직접\s*입력|other)$/i.test(value.trim());

function draftFromRecord(record?: SetupAnswerRecord): AnswerDraft {
  if (!record || record.skipped) return emptyDraft();
  const choice = ['single', 'multi'].includes(record.question.inputType);
  const values = Array.isArray(record.answer) ? record.answer : [record.answer ?? ''];
  const legacyOther = choice && values.some((value) => !record.question.options.includes(value) || isOtherOption(value));
  const otherText = record.otherAnswer ?? (legacyOther ? values.filter((value) => !isOtherOption(value)).join(', ') : '');
  return {
    answer: record.otherAnswer !== undefined || legacyOther ? '' : record.answer ?? '',
    otherSelected: record.otherAnswer !== undefined || legacyOther,
    otherText,
  };
}

function loadSession(): ProjectSessionResult | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as ProjectSessionResult) : null;
  } catch {
    return null;
  }
}

export default function ProjectWizardPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [logline, setLogline] = useState('');
  const [genreTags, setGenreTags] = useState<string[]>([]);
  const [customGenre, setCustomGenre] = useState('');
  const [sessionResult, setSessionResult] = useState<ProjectSessionResult | null>(() => loadSession());
  const [answer, setAnswer] = useState<string | string[]>('');
  const [otherSelected, setOtherSelected] = useState(false);
  const [otherText, setOtherText] = useState('');
  const [cursor, setCursor] = useState<number | null>(null);
  const drafts = useRef<Record<number, AnswerDraft>>({});
  const [error, setError] = useState('');
  const [blueprint, setBlueprint] = useState<ProjectBlueprint | null>(
    sessionResult?.step.type === 'ready' ? structuredClone(sessionResult.step.blueprint) : null,
  );
  const [reviewGenres, setReviewGenres] = useState(
    sessionResult?.step.type === 'ready' ? sessionResult.step.blueprint.genreTags.join(', ') : '',
  );
  const [skipping, setSkipping] = useState(false);
  const [resuming, setResuming] = useState(Boolean(sessionResult));
  const history = sessionResult?.history ?? [];
  const position = cursor ?? history.length;
  const phase = sessionResult ? (sessionResult.step.type === 'ready' && cursor === null ? 'review' : 'interview') : 'basics';

  useEffect(() => {
    if (sessionResult?.step.type !== 'ready') return;
    setBlueprint(structuredClone(sessionResult.step.blueprint));
    setReviewGenres(sessionResult.step.blueprint.genreTags.join(', '));
  }, [sessionResult]);

  const persistResult = (result: ProjectSessionResult) => {
    setSessionResult(result);
    drafts.current = {};
    setCursor(null);
    setAnswer('');
    setOtherSelected(false);
    setOtherText('');
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(result));
  };

  useEffect(() => {
    const stored = loadSession();
    if (!stored?.session.id) {
      setResuming(false);
      return;
    }
    let cancelled = false;
    void api.sessions.get(stored.session.id)
      .then((result) => {
        if (!cancelled) persistResult(result);
      })
      .catch((reason) => {
        if (cancelled) return;
        if (reason instanceof ApiError && reason.status === 404) {
          sessionStorage.removeItem(SESSION_KEY);
          setSessionResult(null);
          setBlueprint(null);
          setError('이전 인터뷰가 만료되어 새 프로젝트 입력으로 돌아왔습니다.');
          return;
        }
        setError(`저장된 인터뷰를 복구하지 못했습니다: ${messageOf(reason)}`);
      })
      .finally(() => {
        if (!cancelled) setResuming(false);
      });
    return () => { cancelled = true; };
  }, []);

  const recoverAfterConflict = async (reason: unknown) => {
    if (!isConflict(reason) || !sessionResult?.session.id) {
      setError(messageOf(reason));
      return;
    }
    try {
      const recovered = await api.sessions.get(sessionResult.session.id);
      persistResult(recovered);
      setError('서버에 저장된 최신 인터뷰 단계로 복구했습니다. 내용을 확인하고 계속해 주세요.');
    } catch (recoveryError) {
      setError(messageOf(recoveryError));
    }
  };

  const startMutation = useMutation({
    mutationFn: () => api.sessions.start({ logline: logline.trim(), genreTags }),
    onSuccess: persistResult,
    onError: (reason) => setError(messageOf(reason)),
  });
  const respondMutation = useMutation({
    mutationFn: (input: { question: SetupQuestion; value?: string | string[]; otherAnswer?: string; skip?: boolean }) =>
      api.sessions.respond(sessionResult!.session.id, {
        questionId: input.question.id,
        ...(sessionResult?.stateToken ? { position, expectedState: sessionResult.stateToken } : {}),
        ...(input.skip ? { skipOptional: true as const } : input.otherAnswer !== undefined ? { otherAnswer: input.otherAnswer } : { answer: input.value }),
      }),
    onSuccess: persistResult,
    onError: (reason) => recoverAfterConflict(reason),
  });
  const commitMutation = useMutation({
    mutationFn: () => {
      if (!blueprint) throw new Error('확인할 프로젝트 설정이 없습니다.');
      const edited = {
        ...blueprint,
        title: blueprint.title.trim(),
        logline: blueprint.logline.trim(),
        genreTags: reviewGenres.split(',').map((item) => item.trim()).filter(Boolean),
        defaultTargetChars: blueprint.defaultTargetChars ?? 5000,
      };
      return api.sessions.commit(sessionResult!.session.id, edited, sessionResult?.stateToken);
    },
    onSuccess: ({ project }) => {
      sessionStorage.removeItem(SESSION_KEY);
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      navigate(`/projects/${project.id}/episodes`, { replace: true });
    },
    onError: (reason) => recoverAfterConflict(reason),
  });

  const question = cursor !== null ? history[cursor]?.question ?? null
    : sessionResult?.step.type === 'question' ? sessionResult.step.question : null;
  const busy = respondMutation.isPending || skipping || commitMutation.isPending;
  const validAnswer = useMemo(() => {
    if (!question) return false;
    if (otherSelected) return Boolean(otherText.trim());
    return Array.isArray(answer) ? answer.length > 0 : Boolean(answer.trim());
  }, [answer, otherSelected, otherText, question]);

  const showPosition = (nextPosition: number) => {
    if (question) drafts.current[position] = { answer, otherSelected, otherText };
    const draft = drafts.current[nextPosition] ?? draftFromRecord(history[nextPosition]);
    setAnswer(draft.answer);
    setOtherSelected(draft.otherSelected);
    setOtherText(draft.otherText);
    setCursor(nextPosition < history.length ? nextPosition : null);
    setError('');
  };

  const answerUnchanged = () => {
    const previous = history[position];
    if (!previous) return false;
    const restored = draftFromRecord(previous);
    if (restored.otherSelected !== otherSelected) return false;
    if (otherSelected) return restored.otherText.trim() === otherText.trim();
    if (Array.isArray(restored.answer) && Array.isArray(answer)) {
      return restored.answer.length === answer.length && restored.answer.every((value) => answer.includes(value));
    }
    return typeof restored.answer === 'string' && typeof answer === 'string' && restored.answer.trim() === answer.trim();
  };

  const toggleGenre = (genre: string) => {
    setGenreTags((current) =>
      current.includes(genre) ? current.filter((item) => item !== genre) : [...current, genre].slice(0, 6),
    );
  };
  const addCustomGenre = () => {
    const next = customGenre.trim();
    if (!next || genreTags.includes(next) || genreTags.length >= 6) return;
    setGenreTags((current) => [...current, next]);
    setCustomGenre('');
  };

  const submitBasics = (event: FormEvent) => {
    event.preventDefault();
    setError('');
    if (!logline.trim()) return setError('로그라인을 입력해 주세요.');
    if (!genreTags.length) return setError('장르 태그를 하나 이상 선택해 주세요.');
    startMutation.mutate();
  };

  const submitQuestion = (event: FormEvent) => {
    event.preventDefault();
    if (!question || busy) return;
    setError('');
    if (cursor !== null && answerUnchanged()) {
      showPosition(position + 1);
      return;
    }
    if (!validAnswer) return;
    respondMutation.mutate({ question, ...(otherSelected ? { otherAnswer: otherText.trim() } : { value: answer }) });
  };

  const skipRemainingOptional = async () => {
    if (!sessionResult || cursor !== null || sessionResult.step.type !== 'question' || sessionResult.step.question.required || busy) return;
    setSkipping(true);
    setError('');
    try {
      let current = sessionResult;
      for (let index = 0; index < 20 && current.step.type === 'question' && !current.step.question.required; index += 1) {
        current = await api.sessions.respond(current.session.id, {
          questionId: current.step.question.id,
          ...(current.stateToken ? { position: current.history?.length ?? 0, expectedState: current.stateToken } : {}),
          skipOptional: true,
        });
        persistResult(current);
      }
      persistResult(current);
    } catch (reason) {
      await recoverAfterConflict(reason);
    } finally {
      setSkipping(false);
    }
  };

  return (
    <div className="wizard-page">
      <header className="wizard-topbar">
        <Link to="/projects" className="icon-button" aria-label="프로젝트 목록으로">
          <ArrowLeft className="size-5" />
        </Link>
        <Link to="/projects" className="brand-lockup text-ink" aria-label="파라노벨 홈">
          <span className="brand-mark"><Feather className="size-4" /></span>
          <span>PARANOVEL</span>
        </Link>
        <div className="size-11" />
      </header>

      <main className="wizard-main">
        <div className="wizard-progress" aria-label={`프로젝트 생성 ${phase === 'basics' ? '1' : phase === 'interview' ? '2' : '3'}단계`}>
          {['이야기 씨앗', 'AI 인터뷰', '설정 확인'].map((label, index) => {
            const current = phase === 'basics' ? 0 : phase === 'interview' ? 1 : 2;
            return (
              <div key={label} className={cx('wizard-progress-item', index <= current && 'active')}>
                <span>{index < current ? <Check className="size-3.5" /> : index + 1}</span>
                <small>{label}</small>
              </div>
            );
          })}
        </div>

        {resuming ? (
          <section className="wizard-card state-box min-h-72" role="status">
            <LoaderCircle className="size-7 animate-spin text-plum-600" />
            <p>저장된 AI 인터뷰를 이어 불러오는 중</p>
          </section>
        ) : null}

        {!resuming && phase === 'basics' ? (
          <section className="wizard-card">
            <p className="eyebrow">새로운 연재</p>
            <h1 className="section-title mt-2">어떤 이야기인가요?</h1>
            <p className="page-lead mt-2">제목은 다음 단계에서 AI가 반드시 직접 물어봐요.</p>
            <form className="mt-8 space-y-7" onSubmit={submitBasics} noValidate>
              <div>
                <label className="field-label" htmlFor="logline">로그라인 <span aria-hidden="true">*</span></label>
                <textarea
                  id="logline"
                  className="input"
                  value={logline}
                  onChange={(event) => setLogline(event.target.value)}
                  placeholder="예: 멸망한 왕국의 마지막 기록관이 시간을 되돌려, 자신이 지웠던 영웅을 찾아 나선다."
                  maxLength={500}
                  required
                />
                <p className="field-hint"><span>{logline.length}/500</span> 주인공, 목표, 장애물이 드러나면 좋아요.</p>
              </div>
              <fieldset>
                <legend className="field-label">장르 태그 <span aria-hidden="true">*</span></legend>
                <div className="tag-picker mt-3">
                  {GENRE_SUGGESTIONS.map((genre) => {
                    const selected = genreTags.includes(genre);
                    return (
                      <button
                        key={genre}
                        type="button"
                        className={cx('tag-choice', selected && 'selected')}
                        aria-pressed={selected}
                        onClick={() => toggleGenre(genre)}
                      >
                        {selected ? <Check className="size-3.5" /> : null}{genre}
                      </button>
                    );
                  })}
                </div>
                <div className="mt-3 flex gap-2">
                  <input
                    className="input"
                    aria-label="직접 장르 태그 입력"
                    placeholder="직접 입력"
                    value={customGenre}
                    onChange={(event) => setCustomGenre(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        addCustomGenre();
                      }
                    }}
                  />
                  <Button type="button" variant="secondary" onClick={addCustomGenre}>추가</Button>
                </div>
                {genreTags.length ? (
                  <div className="mt-3 flex flex-wrap gap-2" aria-label="선택한 장르">
                    {genreTags.map((tag) => (
                      <button key={tag} type="button" className="selected-tag" onClick={() => toggleGenre(tag)} aria-label={`${tag} 제거`}>{tag}<X className="size-4" aria-hidden="true" /></button>
                    ))}
                  </div>
                ) : null}
              </fieldset>
              <FieldError>{error}</FieldError>
              <Button type="submit" size="lg" className="w-full" busy={startMutation.isPending}>
                AI와 설정 구체화하기 <ArrowRight className="size-4" />
              </Button>
            </form>
          </section>
        ) : null}

        {!resuming && phase === 'interview' && question ? (
          <section className="wizard-card" aria-live="polite">
            <div className="assistant-avatar"><Sparkles className="size-5" aria-hidden="true" /></div>
            <p className="eyebrow mt-5">AI 설정 인터뷰</p>
            <p className="mt-2 text-sm text-muted">{position + 1}번째 질문{cursor !== null ? ' · 이전 답변 확인' : ''}</p>
            <h1 className="question-title">{question.prompt}</h1>
            <p className="mt-2 text-sm text-muted">답은 세계관 초안에 반영되며, 프로젝트를 만들기 전에 한 번 더 확인할 수 있어요.</p>
            <form className="mt-7" onSubmit={submitQuestion}>
              <fieldset disabled={busy}>
              {question.inputType === 'long_text' ? (
                <textarea
                  className="input"
                  autoFocus
                  aria-label="답변"
                  value={typeof answer === 'string' ? answer : ''}
                  onChange={(event) => setAnswer(event.target.value)}
                  placeholder="자유롭게 적어 주세요"
                />
              ) : question.inputType === 'text' ? (
                <input
                  className="input"
                  autoFocus
                  aria-label="답변"
                  value={typeof answer === 'string' ? answer : ''}
                  onChange={(event) => setAnswer(event.target.value)}
                  placeholder="답을 입력해 주세요"
                />
              ) : (
                <div>
                <div className="option-list" role={question.inputType === 'single' ? 'radiogroup' : 'group'} aria-label="답변 선택">
                  {question.options.filter((option) => !isOtherOption(option)).map((option) => {
                    const selected = !otherSelected && (Array.isArray(answer) ? answer.includes(option) : answer === option);
                    return (
                      <button
                        type="button"
                        key={option}
                        className={cx('option-card', selected && 'selected')}
                        role={question.inputType === 'single' ? 'radio' : 'checkbox'}
                        aria-checked={selected}
                        onClick={() => {
                          setOtherSelected(false);
                          if (question.inputType === 'single') setAnswer(option);
                          else {
                            const values = Array.isArray(answer) ? answer : [];
                            setAnswer(selected ? values.filter((item) => item !== option) : [...values, option]);
                          }
                        }}
                      >
                        <span>{option}</span>{selected ? <Check className="size-5 text-plum-600" /> : null}
                      </button>
                    );
                  })}
                  <button
                    type="button"
                    className={cx('option-card', otherSelected && 'selected')}
                    role={question.inputType === 'single' ? 'radio' : 'checkbox'}
                    aria-checked={otherSelected}
                    onClick={() => { setOtherSelected(!otherSelected); setAnswer(''); }}
                  >
                    <span>기타 (직접 입력)</span>{otherSelected ? <Check className="size-5 text-plum-600" /> : null}
                  </button>
                </div>
                <label className="field-label mt-4" htmlFor="other-answer">기타 답변</label>
                <textarea
                  id="other-answer"
                  className="input disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={!otherSelected || busy}
                  value={otherSelected ? otherText : ''}
                  onChange={(event) => setOtherText(event.target.value)}
                  placeholder="기타를 선택하면 직접 답변할 수 있어요"
                  maxLength={10_000}
                  required={otherSelected}
                />
                </div>
              )}
              </fieldset>
              {cursor !== null ? <p className="mt-4 text-sm text-muted">답변을 수정하고 다음으로 이동하면 이후 질문과 설정 초안이 새 답변에 맞춰 다시 만들어져요.</p> : null}
              <FieldError>{error}</FieldError>
              <div className="mt-7 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <Button type="button" variant="ghost" disabled={position === 0 || busy} onClick={() => showPosition(position - 1)}>
                  <ArrowLeft className="size-4" /> 이전 질문
                </Button>
                {!question.required && cursor === null ? (
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => void skipRemainingOptional()}
                  >
                    나머지 질문 건너뛰기
                  </Button>
                ) : null}
                <Button type="submit" size="lg" busy={respondMutation.isPending} disabled={busy || (!validAnswer && !(cursor !== null && answerUnchanged()))}>
                  {cursor !== null && position + 1 === history.length && sessionResult?.step.type === 'ready' ? '설정 확인' : '다음 질문'} <ArrowRight className="size-4" />
                </Button>
              </div>
            </form>
          </section>
        ) : null}

        {!resuming && phase === 'review' && blueprint ? (
          <section className="wizard-card wizard-card-wide">
            <p className="eyebrow">마지막 확인</p>
            <h1 className="section-title mt-2">이 세계로 시작할까요?</h1>
            <div className="mt-7 space-y-7">
              <section className="blueprint-section">
                <h2>작품 정보</h2>
                <div className="mt-4 space-y-4">
                  <div><label className="field-label" htmlFor="review-title">소설 제목</label><input id="review-title" className="input" value={blueprint.title} onChange={(event) => setBlueprint({ ...blueprint, title: event.target.value })} /></div>
                  <div><label className="field-label" htmlFor="review-logline">로그라인</label><textarea id="review-logline" className="input" value={blueprint.logline} onChange={(event) => setBlueprint({ ...blueprint, logline: event.target.value })} /></div>
                  <div><label className="field-label" htmlFor="review-genres">장르 태그</label><input id="review-genres" className="input" value={reviewGenres} onChange={(event) => setReviewGenres(event.target.value)} /><p className="field-hint">쉼표로 구분해 주세요.</p></div>
                  <div><label className="field-label" htmlFor="review-details">세계의 핵심</label><textarea id="review-details" className="input" value={blueprint.details} onChange={(event) => setBlueprint({ ...blueprint, details: event.target.value })} /></div>
                  <div><label className="field-label" htmlFor="review-target-chars">회차 기본 목표 글자 수</label><input id="review-target-chars" type="number" min={500} max={30000} step={100} className="input" value={blueprint.defaultTargetChars} onChange={(event) => setBlueprint({ ...blueprint, defaultTargetChars: Number(event.target.value) })} /></div>
                </div>
              </section>

              <section className="blueprint-section">
                <div className="flex items-center justify-between gap-3"><div><h2>초기 정사</h2><p>삭제한 항목은 프로젝트에 저장되지 않습니다.</p></div><Button type="button" variant="secondary" size="sm" onClick={() => setBlueprint({ ...blueprint, canon: [...blueprint.canon, { category: 'OTHER', name: '', aliases: [], content: '', metadata: {} }] })}><Plus className="size-4" /> 추가</Button></div>
                <div className="mt-4 space-y-3">
                  {blueprint.canon.map((entry, index) => (
                    <div className="blueprint-canon-row" key={index}>
                      <select aria-label={`${index + 1}번째 설정 분류`} className="input" value={entry.category} onChange={(event) => setBlueprint({ ...blueprint, canon: blueprint.canon.map((item, itemIndex) => itemIndex === index ? { ...item, category: event.target.value as CanonCategory } : item) })}>{Object.entries(CANON_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
                      <input aria-label={`${index + 1}번째 설정 이름`} className="input" value={entry.name} placeholder="설정 이름" onChange={(event) => setBlueprint({ ...blueprint, canon: blueprint.canon.map((item, itemIndex) => itemIndex === index ? { ...item, name: event.target.value } : item) })} />
                      <input aria-label={`${index + 1}번째 설정 별칭`} className="input sm:col-span-2" value={entry.aliases.join(', ')} placeholder="별칭 (쉼표로 구분)" onChange={(event) => setBlueprint({ ...blueprint, canon: blueprint.canon.map((item, itemIndex) => itemIndex === index ? { ...item, aliases: event.target.value.split(',').map((alias) => alias.trim()).filter(Boolean) } : item) })} />
                      <textarea aria-label={`${index + 1}번째 설정 내용`} className="input" value={entry.content} placeholder="확정 내용" onChange={(event) => setBlueprint({ ...blueprint, canon: blueprint.canon.map((item, itemIndex) => itemIndex === index ? { ...item, content: event.target.value } : item) })} />
                      <IconDelete label={`${entry.name || index + 1} 설정 제거`} onClick={() => setBlueprint({ ...blueprint, canon: blueprint.canon.filter((_, itemIndex) => itemIndex !== index) })} />
                    </div>
                  ))}
                  {!blueprint.canon.length ? <p className="rounded-xl bg-paper p-4 text-sm text-muted">초기 정사 없이 시작할 수 있습니다.</p> : null}
                </div>
              </section>

              <section className="blueprint-section">
                <h2>첫 아크</h2><p>시작과 끝을 포함해 5–20화 범위로 맞춰 주세요.</p>
                <div className="mt-4 space-y-4">
                  <div><label className="field-label" htmlFor="review-arc-title">아크 제목</label><input id="review-arc-title" className="input" value={blueprint.arc.title} onChange={(event) => setBlueprint({ ...blueprint, arc: { ...blueprint.arc, title: event.target.value } })} /></div>
                  <div className="grid grid-cols-2 gap-3"><div><label className="field-label" htmlFor="review-arc-start">시작 회차</label><input id="review-arc-start" type="number" min={1} className="input" value={blueprint.arc.startEpisode} onChange={(event) => setBlueprint({ ...blueprint, arc: { ...blueprint.arc, startEpisode: Number(event.target.value) } })} /></div><div><label className="field-label" htmlFor="review-arc-end">끝 회차</label><input id="review-arc-end" type="number" min={1} className="input" value={blueprint.arc.endEpisode} onChange={(event) => setBlueprint({ ...blueprint, arc: { ...blueprint.arc, endEpisode: Number(event.target.value) } })} /></div></div>
                  <div><label className="field-label" htmlFor="review-arc-goal">목표</label><textarea id="review-arc-goal" className="input" value={blueprint.arc.goal} onChange={(event) => setBlueprint({ ...blueprint, arc: { ...blueprint.arc, goal: event.target.value } })} /></div>
                  <div><label className="field-label" htmlFor="review-arc-conflict">갈등</label><textarea id="review-arc-conflict" className="input" value={blueprint.arc.conflict} onChange={(event) => setBlueprint({ ...blueprint, arc: { ...blueprint.arc, conflict: event.target.value } })} /></div>
                  <div><label className="field-label">회차별 반전</label><div className="mt-2 space-y-2">{blueprint.arc.reversalPlan.map((beat, index) => <div className="grid grid-cols-[5rem_1fr_2.75rem] gap-2" key={index}><input className="input" type="number" min={1} aria-label={`${index + 1}번째 반전 회차`} value={beat.episode} onChange={(event) => setBlueprint({ ...blueprint, arc: { ...blueprint.arc, reversalPlan: blueprint.arc.reversalPlan.map((item, itemIndex) => itemIndex === index ? { ...item, episode: Number(event.target.value) } : item) } })} /><input className="input" aria-label={`${index + 1}번째 반전 내용`} value={beat.description} onChange={(event) => setBlueprint({ ...blueprint, arc: { ...blueprint.arc, reversalPlan: blueprint.arc.reversalPlan.map((item, itemIndex) => itemIndex === index ? { ...item, description: event.target.value } : item) } })} /><IconDelete label={`${index + 1}번째 반전 제거`} onClick={() => setBlueprint({ ...blueprint, arc: { ...blueprint.arc, reversalPlan: blueprint.arc.reversalPlan.filter((_, itemIndex) => itemIndex !== index) } })} /></div>)}</div><Button type="button" className="mt-2" variant="ghost" size="sm" onClick={() => setBlueprint({ ...blueprint, arc: { ...blueprint.arc, reversalPlan: [...blueprint.arc.reversalPlan, { episode: blueprint.arc.startEpisode, description: '' }] } })}><Plus className="size-4" /> 반전 추가</Button></div>
                </div>
              </section>
            </div>
            <p className="mt-5 rounded-xl bg-sage-50 p-4 text-sm leading-6 text-sage-700">이 화면에서 확정한 항목만 프로젝트의 초기 정사와 아크로 저장됩니다.</p>
            <FieldError>{error}</FieldError>
            <Button className="mt-6" variant="ghost" disabled={!history.length || busy} onClick={() => showPosition(history.length - 1)}>
              <ArrowLeft className="size-4" /> 이전 질문
            </Button>
            <Button className="mt-6 w-full" size="lg" busy={commitMutation.isPending} disabled={!blueprint.title.trim() || !blueprint.logline.trim() || !reviewGenres.trim() || !blueprint.arc.title.trim() || blueprint.arc.endEpisode - blueprint.arc.startEpisode + 1 < 5 || blueprint.arc.endEpisode - blueprint.arc.startEpisode + 1 > 20 || blueprint.canon.some((entry) => !entry.name.trim() || !entry.content.trim())} onClick={() => commitMutation.mutate()}>
              {commitMutation.isPending ? '프로젝트를 정리하는 중' : '프로젝트 만들기'}
            </Button>
          </section>
        ) : null}

        {(startMutation.isPending || respondMutation.isPending) ? (
          <p className="mt-4 flex items-center justify-center gap-2 text-sm text-muted" role="status">
            <LoaderCircle className="size-4 animate-spin" /> 세계의 빈칸을 살피는 중
          </p>
        ) : null}
      </main>
    </div>
  );
}

function IconDelete({ label, onClick }: { label: string; onClick: () => void }) {
  return <button type="button" className="icon-button text-red-700" aria-label={label} onClick={onClick}><Trash2 className="size-4" /></button>;
}
