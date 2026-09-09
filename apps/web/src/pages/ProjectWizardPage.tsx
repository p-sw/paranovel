import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight, Check, Feather, LoaderCircle, Plus, Sparkles, Trash2, X } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { api, ApiError, isConflict, messageOf } from '../api/client';
import {
  episodeDirectionsForRange,
  episodeDirectionsIssue,
  legacyMilestones,
  MILESTONE_TYPE_LABELS,
  MILESTONE_TYPES,
} from '../arcPlan';
import { CANON_LABELS, GENRE_SUGGESTIONS, cx } from '../lib';
import type { ArcMilestone, CanonCategory, ProjectBlueprint, ProjectSessionResult, SetupAnswerRecord, SetupQuestion } from '../types';
import { Button, FieldError } from '../components/Ui';

const SESSION_KEY = 'paranovel.project-session';
type AnswerDraft = { answer: string | string[]; otherSelected: boolean; otherText: string };
type BlueprintArc = ProjectBlueprint['arcs'][number];
type LegacyBlueprintArc = Omit<BlueprintArc, 'milestones' | 'episodeDirections'> & {
  reversalPlan?: Array<{ id?: string; episode: number; description: string }>;
  milestones?: ArcMilestone[];
  episodeDirections?: BlueprintArc['episodeDirections'];
};
type LegacyBlueprint = Omit<ProjectBlueprint, 'arcs'> & { details?: string; arcs?: LegacyBlueprintArc[] };
const emptyDraft = (): AnswerDraft => ({ answer: '', otherSelected: false, otherText: '' });
const isOtherOption = (value: string) => /^(기타(?:\s*\(직접\s*입력\))?|직접\s*입력|other)$/i.test(value.trim());

function normalizeSessionResult(result: ProjectSessionResult): ProjectSessionResult {
  if (result.step.type !== 'ready') return result;
  const legacyBlueprint = result.step.blueprint as unknown as LegacyBlueprint;
  const { details, ...blueprint } = legacyBlueprint;
  const arcs = Array.isArray(legacyBlueprint.arcs)
    ? legacyBlueprint.arcs.map((legacyArc) => {
      const { reversalPlan: _reversalPlan, ...arc } = legacyArc;
      return {
        ...arc,
        milestones: legacyMilestones(legacyArc),
        episodeDirections: episodeDirectionsForRange(
          legacyArc.startEpisode,
          legacyArc.endEpisode,
          legacyArc.episodeDirections ?? [],
        ),
      };
    })
    : undefined;
  return {
    ...result,
    step: {
      ...result.step,
      blueprint: {
        ...blueprint,
        writingDirection: legacyBlueprint.writingDirection ?? details ?? '',
        ...(arcs ? { arcs } : {}),
      },
    },
  } as ProjectSessionResult;
}

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
    if (!raw) return null;
    const result = normalizeSessionResult(JSON.parse(raw) as ProjectSessionResult);
    if (result.step?.type !== 'ready') return result;
    const stored = result.step.blueprint as ProjectBlueprint & {
      arc?: ProjectBlueprint['arcs'][number];
      arcs?: ProjectBlueprint['arcs'];
    };
    if (Array.isArray(stored?.arcs)) return result;
    if (!stored?.arc) return null;
    const { arc, ...rest } = stored;
    return normalizeSessionResult({
      ...result,
      step: {
        type: 'ready',
        blueprint: {
          ...rest,
          targetEpisode: arc.endEpisode,
          targetEpisodeSource: 'AI',
          arcs: [arc],
        },
      },
    } as ProjectSessionResult);
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
  const [answer, setAnswer] = useState<string | string[]>(
    sessionResult?.step.type === 'question' ? sessionResult.step.question.suggestedAnswer ?? '' : '',
  );
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
  const targetQuestionPosition = history.findIndex((record) => record.question.field === 'targetEpisode');
  const phase = sessionResult ? (sessionResult.step.type === 'ready' && cursor === null ? 'review' : 'interview') : 'basics';

  useEffect(() => {
    if (sessionResult?.step.type !== 'ready') return;
    setBlueprint(structuredClone(sessionResult.step.blueprint));
    setReviewGenres(sessionResult.step.blueprint.genreTags.join(', '));
  }, [sessionResult]);

  const persistResult = (result: ProjectSessionResult) => {
    const normalized = normalizeSessionResult(result);
    setSessionResult(normalized);
    drafts.current = {};
    setCursor(null);
    setAnswer(result.step.type === 'question' ? result.step.question.suggestedAnswer ?? '' : '');
    setOtherSelected(false);
    setOtherText('');
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(normalized));
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
  const blueprintIssue = blueprint ? validateBlueprintReview(blueprint, reviewGenres) : '검토할 설정이 없습니다.';
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
            <p className="page-lead mt-2">다음 단계에서 AI가 작품 제목을 추천해요. 마음에 들지 않으면 바로 고칠 수 있어요.</p>
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
                  maxLength={10_000}
                />
              ) : question.inputType === 'text' ? (
                <input
                  className="input"
                  autoFocus
                  aria-label="답변"
                  type={question.field === 'targetEpisode' ? 'number' : 'text'}
                  min={question.field === 'targetEpisode' ? 5 : undefined}
                  max={question.field === 'targetEpisode' ? 2000 : undefined}
                  value={typeof answer === 'string' ? answer : ''}
                  onChange={(event) => setAnswer(event.target.value)}
                  placeholder={question.field === 'targetEpisode' ? '예: 100' : '답을 입력해 주세요'}
                  maxLength={question.field === 'title' ? 200 : question.field === 'targetEpisode' ? undefined : 10_000}
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
              {question.field === 'title' && question.suggestedAnswer ? <p className="mt-4 text-sm text-plum-700">AI 추천 제목이에요. 그대로 확정하거나 입력란에서 자유롭게 바꿔 주세요.</p> : null}
              {question.field === 'targetEpisode' ? <p className="mt-4 text-sm text-muted">목표가 없다면 AI가 이야기 규모에 맞춰 완결 회차와 전체 아크를 제안해요.</p> : null}
              {cursor !== null ? <p className="mt-4 text-sm text-muted">답변을 수정하고 다음으로 이동하면 이후 질문과 설정 초안이 새 답변에 맞춰 다시 만들어져요.</p> : null}
              <FieldError>{error}</FieldError>
              <div className="mt-7 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <Button type="button" variant="ghost" disabled={position === 0 || busy} onClick={() => showPosition(position - 1)}>
                  <ArrowLeft className="size-4" /> 이전 질문
                </Button>
                {!question.required && cursor === null && question.field === 'targetEpisode' ? (
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => respondMutation.mutate({ question, skip: true })}
                  >
                    AI에게 완결 회차 맡기기
                  </Button>
                ) : null}
                {!question.required && cursor === null && question.field !== 'targetEpisode' ? (
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
            <fieldset className="m-0 min-w-0 border-0 p-0" disabled={commitMutation.isPending}>
            <div className="mt-7 space-y-7">
              <section className="blueprint-section">
                <h2>작품 정보</h2>
                <div className="mt-4 space-y-4">
                  <div><label className="field-label" htmlFor="review-title">소설 제목</label><input id="review-title" className="input" maxLength={200} value={blueprint.title} onChange={(event) => setBlueprint({ ...blueprint, title: event.target.value })} /></div>
                  <div><label className="field-label" htmlFor="review-logline">로그라인</label><textarea id="review-logline" className="input" maxLength={2_000} value={blueprint.logline} onChange={(event) => setBlueprint({ ...blueprint, logline: event.target.value })} /></div>
                  <div><label className="field-label" htmlFor="review-genres">장르 태그</label><input id="review-genres" className="input" value={reviewGenres} onChange={(event) => setReviewGenres(event.target.value)} /><p className="field-hint">쉼표로 구분해 주세요.</p></div>
                  <div><label className="field-label" htmlFor="review-writing-direction">작문 디렉션</label><textarea id="review-writing-direction" className="input" rows={8} maxLength={20000} value={blueprint.writingDirection} onChange={(event) => setBlueprint({ ...blueprint, writingDirection: event.target.value })} /><p className="field-hint">시점·시제·문체·호흡, 묘사와 대화 방식처럼 AI가 계속 지켜야 할 집필 원칙을 적어 주세요.</p></div>
                  <div><label className="field-label" htmlFor="review-target-chars">회차 기본 목표 글자 수</label><input id="review-target-chars" type="number" min={500} max={30000} step={100} className="input" value={blueprint.defaultTargetChars} onChange={(event) => setBlueprint({ ...blueprint, defaultTargetChars: Number(event.target.value) })} /></div>
                  <div><label className="field-label" htmlFor="review-target-episode">목표 완결 회차</label><input id="review-target-episode" type="number" className="input" value={blueprint.targetEpisode} readOnly /><p className="field-hint">{blueprint.targetEpisodeSource === 'AI' ? '목표를 비워 두어 AI가 작품 규모에 맞춰 제안한 회차예요.' : '인터뷰에서 정한 목표예요.'} 마지막 아크도 이 회차에 끝납니다.</p>{targetQuestionPosition >= 0 ? <Button type="button" className="mt-2" variant="ghost" size="sm" onClick={() => showPosition(targetQuestionPosition)}>목표 회차 다시 정하기</Button> : null}</div>
                </div>
              </section>

              <section className="blueprint-section">
                <div className="flex items-center justify-between gap-3"><div><h2>초기 정사</h2><p>삭제한 항목은 프로젝트에 저장되지 않습니다.</p></div><Button type="button" variant="secondary" size="sm" onClick={() => setBlueprint({ ...blueprint, canon: [...blueprint.canon, { category: 'OTHER', name: '', aliases: [], content: '', metadata: {} }] })}><Plus className="size-4" /> 추가</Button></div>
                <div className="mt-4 space-y-3">
                  {blueprint.canon.map((entry, index) => (
                    <div className="blueprint-canon-row" key={index}>
                      <select aria-label={`${index + 1}번째 설정 분류`} className="input" value={entry.category} onChange={(event) => setBlueprint({ ...blueprint, canon: blueprint.canon.map((item, itemIndex) => itemIndex === index ? { ...item, category: event.target.value as CanonCategory } : item) })}>{Object.entries(CANON_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
                      <input aria-label={`${index + 1}번째 설정 이름`} className="input" maxLength={200} value={entry.name} placeholder="설정 이름" onChange={(event) => setBlueprint({ ...blueprint, canon: blueprint.canon.map((item, itemIndex) => itemIndex === index ? { ...item, name: event.target.value } : item) })} />
                      <input aria-label={`${index + 1}번째 설정 별칭`} className="input sm:col-span-2" value={entry.aliases.join(', ')} placeholder="별칭 (쉼표로 구분)" onChange={(event) => setBlueprint({ ...blueprint, canon: blueprint.canon.map((item, itemIndex) => itemIndex === index ? { ...item, aliases: event.target.value.split(',').map((alias) => alias.trim()).filter(Boolean) } : item) })} />
                      <textarea aria-label={`${index + 1}번째 설정 내용`} className="input" maxLength={50_000} value={entry.content} placeholder="확정 내용" onChange={(event) => setBlueprint({ ...blueprint, canon: blueprint.canon.map((item, itemIndex) => itemIndex === index ? { ...item, content: event.target.value } : item) })} />
                      <IconDelete label={`${entry.name || index + 1} 설정 제거`} onClick={() => setBlueprint({ ...blueprint, canon: blueprint.canon.filter((_, itemIndex) => itemIndex !== index) })} />
                    </div>
                  ))}
                  {!blueprint.canon.length ? <p className="rounded-xl bg-paper p-4 text-sm text-muted">초기 정사 없이 시작할 수 있습니다.</p> : null}
                </div>
              </section>

              <section className="blueprint-section">
                <h2>완결까지의 전체 아크</h2><p>첫 아크는 현재 계획으로, 이후 아크는 바꿀 수 있는 대기 계획으로 저장됩니다. 각 범위는 5–20화이며 1화부터 빈틈없이 이어져야 합니다.</p>
                <div className="mt-4 space-y-4">
                  {blueprint.arcs.map((arc, arcIndex) => {
                    const updateArc = (next: typeof arc) => setBlueprint({ ...blueprint, arcs: blueprint.arcs.map((item, index) => index === arcIndex ? next : item) });
                    return (
                      <details className="rounded-2xl border border-line bg-paper p-4" open={arcIndex === 0 ? true : undefined} key={arcIndex}>
                        <summary className="cursor-pointer font-bold"><span className="mr-2 text-plum-700">{arcIndex === 0 ? '현재 아크' : `대기 아크 ${arcIndex}`}</span>{arc.startEpisode}–{arc.endEpisode}화 · {arc.title}</summary>
                        <BlueprintArcEditor arc={arc} arcIndex={arcIndex} onChange={updateArc} />
                      </details>
                    );
                  })}
                </div>
              </section>
            </div>
            </fieldset>
            <p className="mt-5 rounded-xl bg-sage-50 p-4 text-sm leading-6 text-sage-700">이 화면에서 확인한 초기 정사와 전체 아크만 프로젝트에 적용됩니다. 대기 아크는 이후 전개에 맞춰 다시 바꿀 수 있어요.</p>
            {blueprintIssue ? <p className="mt-3 rounded-xl bg-amber-50 p-3 text-sm text-amber-800">확인 필요: {blueprintIssue}</p> : null}
            <FieldError>{error}</FieldError>
            <Button className="mt-6" variant="ghost" disabled={!history.length || busy} onClick={() => showPosition(history.length - 1)}>
              <ArrowLeft className="size-4" /> 이전 질문
            </Button>
            <Button className="mt-6 w-full" size="lg" busy={commitMutation.isPending} disabled={Boolean(blueprintIssue)} onClick={() => commitMutation.mutate()}>
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

function BlueprintArcEditor({
  arc,
  arcIndex,
  onChange,
}: {
  arc: ProjectBlueprint['arcs'][number];
  arcIndex: number;
  onChange: (arc: ProjectBlueprint['arcs'][number]) => void;
}) {
  const position = arcIndex + 1;
  const updateRange = (field: 'startEpisode' | 'endEpisode', value: number) => {
    const startEpisode = field === 'startEpisode' ? value : arc.startEpisode;
    const endEpisode = field === 'endEpisode' ? value : arc.endEpisode;
    onChange({
      ...arc,
      [field]: value,
      episodeDirections: episodeDirectionsForRange(startEpisode, endEpisode, arc.episodeDirections),
    });
  };
  const updateMilestone = (index: number, milestone: ArcMilestone) => onChange({
    ...arc,
    milestones: arc.milestones.map((item, itemIndex) => itemIndex === index ? milestone : item),
  });
  const updateDirection = (episode: number, changes: Partial<ProjectBlueprint['arcs'][number]['episodeDirections'][number]>) => onChange({
    ...arc,
    episodeDirections: arc.episodeDirections.map((item) => item.episode === episode ? { ...item, ...changes } : item),
  });

  return (
    <div className="mt-4 space-y-5">
      <div><label className="field-label" htmlFor={`review-arc-title-${arcIndex}`}>아크 제목</label><input id={`review-arc-title-${arcIndex}`} className="input" maxLength={200} value={arc.title} onChange={(event) => onChange({ ...arc, title: event.target.value })} /></div>
      <div className="grid grid-cols-2 gap-3">
        <div><label className="field-label" htmlFor={`review-arc-start-${arcIndex}`}>시작 회차</label><input id={`review-arc-start-${arcIndex}`} type="number" min={1} className="input" value={arc.startEpisode} onChange={(event) => updateRange('startEpisode', Number(event.target.value))} /></div>
        <div><label className="field-label" htmlFor={`review-arc-end-${arcIndex}`}>끝 회차</label><input id={`review-arc-end-${arcIndex}`} type="number" min={1} className="input" value={arc.endEpisode} onChange={(event) => updateRange('endEpisode', Number(event.target.value))} /></div>
      </div>
      <div><label className="field-label" htmlFor={`review-arc-goal-${arcIndex}`}>목표</label><textarea id={`review-arc-goal-${arcIndex}`} className="input" maxLength={10_000} value={arc.goal} onChange={(event) => onChange({ ...arc, goal: event.target.value })} /></div>
      <div><label className="field-label" htmlFor={`review-arc-conflict-${arcIndex}`}>갈등</label><textarea id={`review-arc-conflict-${arcIndex}`} className="input" maxLength={10_000} value={arc.conflict} onChange={(event) => onChange({ ...arc, conflict: event.target.value })} /></div>

      <section>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div><h3 className="field-label">회차별 마일스톤</h3><p className="field-hint">전개의 목표와 반전, 고조, 클라이맥스, 해결 지점을 확인합니다.</p></div>
          <Button type="button" variant="ghost" size="sm" onClick={() => onChange({
            ...arc,
            milestones: [...arc.milestones, { episode: arc.endEpisode, type: 'OTHER', description: '' }],
          })}><Plus className="size-4" /> 마일스톤 추가</Button>
        </div>
        <div className="mt-3 space-y-2">
          {arc.milestones.map((milestone, milestoneIndex) => (
            <div className="grid gap-2 sm:grid-cols-[5rem_8rem_minmax(0,1fr)_2.75rem]" key={milestone.id ?? milestoneIndex}>
              <input className="input" type="number" min={arc.startEpisode} max={arc.endEpisode} aria-label={`${position}번째 아크 ${milestoneIndex + 1}번째 마일스톤 회차`} value={milestone.episode} onChange={(event) => updateMilestone(milestoneIndex, { ...milestone, episode: Number(event.target.value) })} />
              <select className="input" aria-label={`${position}번째 아크 ${milestoneIndex + 1}번째 마일스톤 종류`} value={milestone.type} onChange={(event) => updateMilestone(milestoneIndex, { ...milestone, type: event.target.value as ArcMilestone['type'] })}>{MILESTONE_TYPES.map((type) => <option key={type} value={type}>{MILESTONE_TYPE_LABELS[type]}</option>)}</select>
              <textarea className="input" rows={2} maxLength={10_000} aria-label={`${position}번째 아크 ${milestoneIndex + 1}번째 마일스톤 내용`} value={milestone.description} onChange={(event) => updateMilestone(milestoneIndex, { ...milestone, description: event.target.value })} />
              {arc.milestones.length > 1 ? <IconDelete label={`${position}번째 아크 ${milestoneIndex + 1}번째 마일스톤 제거`} onClick={() => onChange({ ...arc, milestones: arc.milestones.filter((_, index) => index !== milestoneIndex) })} /> : <span />}
            </div>
          ))}
        </div>
      </section>

      <section>
        <h3 className="field-label">회차별 전개</h3>
        <p className="field-hint">마일스톤을 잇는 제목과 전개 방향이 모든 회차에 하나씩 필요합니다.</p>
        <div className="mt-3 space-y-3">
          {arc.episodeDirections.map((item) => (
            <article className="rounded-xl border border-line bg-surface p-3" key={item.episode}>
              <h4 className="text-sm font-bold text-plum-700">{item.episode}화</h4>
              <div className="mt-2 grid gap-2 sm:grid-cols-[minmax(10rem,0.7fr)_minmax(0,1.3fr)]">
                <input className="input" maxLength={200} aria-label={`${position}번째 아크 ${item.episode}화 제목`} placeholder="회차 제목" value={item.title} onChange={(event) => updateDirection(item.episode, { title: event.target.value })} />
                <textarea className="input" rows={3} maxLength={20_000} aria-label={`${position}번째 아크 ${item.episode}화 전개 방향`} placeholder="주요 사건, 감정 변화, 정보 공개와 끝 훅" value={item.direction} onChange={(event) => updateDirection(item.episode, { direction: event.target.value })} />
              </div>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}

function validateBlueprintReview(blueprint: ProjectBlueprint, genres: string): string {
  const genreTags = genres.split(',').map((genre) => genre.trim()).filter(Boolean);
  if (!blueprint.title.trim() || !blueprint.logline.trim() || !genreTags.length) return '제목, 로그라인과 장르를 입력해 주세요.';
  if (blueprint.title.trim().length > 200) return '제목은 200자 이하여야 합니다.';
  if (blueprint.logline.trim().length > 2_000) return '로그라인은 2,000자 이하여야 합니다.';
  if (blueprint.writingDirection.length > 20_000) return '작문 디렉션은 20,000자 이하여야 합니다.';
  if (!Number.isInteger(blueprint.defaultTargetChars) || blueprint.defaultTargetChars < 500 || blueprint.defaultTargetChars > 30_000) {
    return '회차 기본 목표 글자 수는 500자에서 30,000자 사이여야 합니다.';
  }
  if (!Number.isInteger(blueprint.targetEpisode) || blueprint.targetEpisode < 5 || blueprint.targetEpisode > 2_000) {
    return '목표 완결 회차는 5화에서 2,000화 사이여야 합니다.';
  }
  if (!blueprint.arcs.length || blueprint.arcs.length > 100) return '완결까지 이어지는 아크가 1개에서 100개 사이여야 합니다.';
  for (const [index, arc] of blueprint.arcs.entries()) {
    if (!arc.title.trim() || !arc.goal.trim() || !arc.conflict.trim()) return `${index + 1}번째 아크의 제목, 목표와 갈등을 입력해 주세요.`;
    if (arc.title.trim().length > 200 || arc.goal.trim().length > 10_000 || arc.conflict.trim().length > 10_000) {
      return `${index + 1}번째 아크의 제목은 200자, 목표와 갈등은 각각 10,000자 이하여야 합니다.`;
    }
    if (!Number.isInteger(arc.startEpisode) || !Number.isInteger(arc.endEpisode) || arc.startEpisode < 1) {
      return `${index + 1}번째 아크의 회차 범위는 양의 정수여야 합니다.`;
    }
    const span = arc.endEpisode - arc.startEpisode + 1;
    if (span < 5 || span > 20) return `${index + 1}번째 아크는 5화에서 20화 사이여야 합니다.`;
    const expectedStart = index === 0 ? 1 : blueprint.arcs[index - 1]!.endEpisode + 1;
    if (arc.startEpisode !== expectedStart) return `${index + 1}번째 아크가 ${expectedStart}화부터 이어지도록 범위를 맞춰 주세요.`;
    if (!arc.milestones.length) return `${index + 1}번째 아크에는 하나 이상의 마일스톤이 필요합니다.`;
    if (arc.milestones.some((milestone) => !MILESTONE_TYPES.includes(milestone.type)
      || !Number.isInteger(milestone.episode) || !milestone.description.trim() || milestone.description.trim().length > 10_000
      || milestone.episode < arc.startEpisode || milestone.episode > arc.endEpisode)) {
      return `${index + 1}번째 아크의 마일스톤 회차, 종류와 내용을 확인해 주세요.`;
    }
    const directionIssue = episodeDirectionsIssue(arc.startEpisode, arc.endEpisode, arc.episodeDirections);
    if (directionIssue) return `${index + 1}번째 아크: ${directionIssue}`;
  }
  if (blueprint.arcs.at(-1)?.endEpisode !== blueprint.targetEpisode) return '마지막 아크의 끝 회차를 목표 완결 회차와 맞춰 주세요.';
  if (blueprint.canon.some((entry) => !entry.name.trim() || !entry.content.trim())) return '초기 정사의 이름과 내용을 모두 입력하거나 빈 항목을 삭제해 주세요.';
  if (blueprint.canon.some((entry) => entry.name.trim().length > 200 || entry.content.trim().length > 50_000)) {
    return '초기 정사의 이름은 200자, 내용은 50,000자 이하여야 합니다.';
  }
  return '';
}

function IconDelete({ label, onClick }: { label: string; onClick: () => void }) {
  return <button type="button" className="icon-button text-red-700" aria-label={label} onClick={onClick}><Trash2 className="size-4" /></button>;
}
