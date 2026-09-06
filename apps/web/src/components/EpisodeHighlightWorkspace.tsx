import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  highlightParagraphs,
  resolveHighlightAnchor,
  type HighlightImage,
  type HighlightState,
} from '@paranovel/contracts';
import { BookOpen, ImagePlus, LoaderCircle, MapPin, PencilLine, RefreshCw, Trash2 } from 'lucide-react';
import { api, ApiError, messageOf } from '../api/client';
import { createIdempotencyKey } from '../lib';
import type { Episode } from '../types';
import { Badge, Button, ConfirmDialog, FieldError, Sheet } from './Ui';

interface Attempt { key: string; revision: number }

export default function EpisodeHighlightWorkspace({
  projectId, episodeId, content, reading, onReadingChange, captureSource, disabled, children,
}: {
  projectId: string;
  episodeId: string;
  content: string;
  reading: boolean;
  onReadingChange: (value: boolean) => void;
  captureSource: () => Promise<Episode>;
  disabled: boolean;
  children: (preview: ReactNode | null) => ReactNode;
}) {
  const queryClient = useQueryClient();
  const queryKey = ['highlight', projectId, episodeId];
  const operationRef = useRef(false);
  const requestedKeyRef = useRef<string | null>(null);
  const [operation, setOperation] = useState<'generate' | 'place' | 'remove' | null>(null);
  const [uncertainAttempt, setUncertainAttempt] = useState<Attempt | null>(null);
  const [error, setError] = useState('');
  const [placing, setPlacing] = useState(false);
  const [placementContent, setPlacementContent] = useState('');
  const [afterParagraphId, setAfterParagraphId] = useState<number | null>(null);
  const [deleting, setDeleting] = useState(false);
  const query = useQuery({
    queryKey,
    queryFn: () => api.highlights.get(projectId, episodeId),
    refetchInterval: (current) => operation === 'generate' || current.state.data?.generation?.status === 'RUNNING' ? 2_000 : false,
  });
  const state = query.data;
  const image = state?.image ?? null;
  const generation = state?.generation;
  const generating = operation === 'generate' || generation?.status === 'RUNNING';
  const busy = Boolean(operation) || generation?.status === 'RUNNING';
  const anchor = image ? resolveHighlightAnchor(content, image) : null;
  const stale = Boolean(image && content !== image.generatedSourceContent);

  useEffect(() => {
    if (generation?.idempotencyKey !== requestedKeyRef.current || generation?.status !== 'SUCCEEDED') return;
    requestedKeyRef.current = null;
    if (content === image?.generatedSourceContent) onReadingChange(true);
  }, [generation?.idempotencyKey, generation?.status, content, image?.generatedSourceContent, onReadingChange]);

  const setResult = async (value: HighlightState) => {
    await queryClient.cancelQueries({ queryKey });
    queryClient.setQueryData(queryKey, value);
  };

  const refresh = async (): Promise<HighlightState | undefined> => {
    try {
      const value = await api.highlights.get(projectId, episodeId);
      await setResult(value);
      if (value.generation?.idempotencyKey === uncertainAttempt?.key) setUncertainAttempt(null);
      return value;
    } catch { return undefined; }
  };

  const generate = async () => {
    if (operationRef.current || busy || disabled) return;
    operationRef.current = true;
    setOperation('generate');
    setError('');
    let attempt: Attempt | undefined;
    try {
      // A lost response is recovered with its original key. A completed
      // provider image whose download failed also needs no new paid request.
      if (uncertainAttempt) attempt = uncertainAttempt;
      else if (generation?.status === 'FAILED' && generation.retryableDownload) {
        attempt = { key: generation.idempotencyKey, revision: generation.expectedRevision };
      } else {
        const source = await captureSource();
        if (!source.content.trim()) throw new Error('본문을 작성한 뒤 삽화를 생성해 주세요.');
        attempt = { key: createIdempotencyKey(), revision: source.revision };
      }
      requestedKeyRef.current = attempt.key;
      const result = await api.highlights.generate(projectId, episodeId, attempt.revision, attempt.key);
      await setResult(result);
      setUncertainAttempt(null);
    } catch (reason) {
      setError(messageOf(reason));
      if (attempt) {
        const latest = await refresh();
        if (latest?.generation?.idempotencyKey === attempt.key) setUncertainAttempt(null);
        else if (!(reason instanceof ApiError) || reason.status >= 500) setUncertainAttempt(attempt);
        else setUncertainAttempt(null);
      }
    } finally {
      operationRef.current = false;
      setOperation(null);
    }
  };

  const place = async () => {
    if (!image || !afterParagraphId || operationRef.current || busy || disabled) return;
    operationRef.current = true;
    setOperation('place');
    setError('');
    try {
      const source = await captureSource();
      if (source.content !== placementContent) throw new Error('위치를 고르는 동안 본문이 변경되었습니다. 위치를 다시 선택해 주세요.');
      const result = await api.highlights.place(projectId, episodeId, {
        expectedEpisodeRevision: source.revision,
        expectedImageId: image.id,
        afterParagraphId,
      });
      await setResult(result);
      setPlacing(false);
      onReadingChange(true);
    } catch (reason) {
      setError(messageOf(reason));
      await refresh();
    } finally {
      operationRef.current = false;
      setOperation(null);
    }
  };

  const remove = async () => {
    if (!image || operationRef.current || busy || disabled) return;
    operationRef.current = true;
    setOperation('remove');
    setError('');
    try {
      await setResult(await api.highlights.remove(projectId, episodeId, image.id));
      setDeleting(false);
    } catch (reason) {
      setError(messageOf(reason));
      await refresh();
    } finally {
      operationRef.current = false;
      setOperation(null);
    }
  };

  const openPlacement = () => {
    setPlacementContent(content);
    setAfterParagraphId(highlightParagraphs(content).find((paragraph) => paragraph.end === anchor)?.id ?? null);
    setError('');
    setPlacing(true);
  };

  const generateLabel = uncertainAttempt ? '같은 요청 다시 확인'
    : generation?.status === 'FAILED' && generation.retryableDownload ? '이미지 저장 다시 시도'
      : image ? '삽화 다시 생성' : '하이라이트 삽화 생성';

  return <>
    <div className="highlight-toolbar" aria-label="삽화와 읽기 도구">
      <div className="highlight-view-switch" role="group" aria-label="원고 보기 방식">
        <Button size="sm" variant={reading ? 'ghost' : 'secondary'} aria-pressed={!reading} disabled={disabled} onClick={() => onReadingChange(false)}><PencilLine className="size-4" />편집</Button>
        <Button size="sm" variant={reading ? 'secondary' : 'ghost'} aria-pressed={reading} disabled={disabled} onClick={() => onReadingChange(true)}><BookOpen className="size-4" />읽기 미리보기</Button>
      </div>
      <div className="highlight-actions">
        {image ? <>
          <Button size="sm" variant="ghost" disabled={disabled || busy || !content.trim()} onClick={openPlacement}><MapPin className="size-4" />위치 변경</Button>
          <Button size="sm" variant="ghost" disabled={disabled || busy} onClick={() => { setError(''); setDeleting(true); }} aria-label="삽화 삭제"><Trash2 className="size-4" /></Button>
        </> : null}
        <Button size="sm" variant="secondary" busy={generating} disabled={disabled || busy || (!state?.configured && !uncertainAttempt && !generation?.retryableDownload) || query.isError || (!content.trim() && !uncertainAttempt && !generation?.retryableDownload)} onClick={() => void generate()}>
          <ImagePlus className="size-4" />{generating ? '삽화 생성 중' : generateLabel}
        </Button>
      </div>
    </div>
    {(query.isError || error || generation?.status === 'FAILED' || generating || state?.configured === false || stale || (image && anchor === null)) ? <div className="highlight-notices">
      {query.isError ? <p role="alert">삽화 정보를 불러오지 못했습니다. <button type="button" className="highlight-text-action" onClick={() => void query.refetch()}>다시 확인</button></p> : null}
      {state?.configured === false ? <p>새 삽화를 생성하려면 서버에 AnimeAPI와 OpenRouter 키를 모두 설정해 주세요.</p> : null}
      {generating ? <p role="status"><LoaderCircle className="size-3.5 animate-spin" />장면을 고르고 삽화를 만들고 있어요. 다른 회차로 이동해도 결과는 저장됩니다.</p> : null}
      {stale ? <p><Badge tone="warning">본문 변경됨</Badge>생성 후 본문이 바뀌었어요. 삽화가 현재 장면과 맞는지 확인해 주세요.</p> : null}
      {image && anchor === null ? <p><Badge tone="warning">삽화 위치 확인 필요</Badge>기존 문단을 찾을 수 없어 삽화를 보관하고 있어요. 위치를 다시 선택해 주세요.</p> : null}
      {generation?.status === 'FAILED' ? <p role="alert">{generation.error || '삽화를 생성하지 못했습니다.'}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {uncertainAttempt ? <p>요청 결과를 확인하지 못했어요. 같은 요청을 확인하면 중복 생성을 피할 수 있어요. <button type="button" className="highlight-text-action" onClick={() => void refresh()}><RefreshCw className="size-3" />진행 상태 확인</button></p> : null}
    </div> : null}
    {children(reading ? <EpisodeReadingPreview content={content} image={image} /> : null)}
    <Sheet open={placing} onOpenChange={(value) => !operation && setPlacing(value)} title="삽화 위치 변경" description="삽화를 넣을 문단을 고르세요. 선택한 문단 바로 뒤에 표시됩니다."
      footer={<div className="action-row"><Button variant="ghost" disabled={Boolean(operation)} onClick={() => setPlacing(false)}>취소</Button><Button busy={operation === 'place'} disabled={disabled || busy || !afterParagraphId} onClick={() => void place()}>이 문단 뒤에 삽입</Button></div>}>
      <fieldset className="highlight-paragraph-choices" disabled={Boolean(operation)}><legend className="sr-only">삽화를 표시할 문단</legend>
        {highlightParagraphs(placementContent).map((paragraph) => <label key={paragraph.id} className="highlight-paragraph-choice">
          <input type="radio" name="highlight-paragraph" value={paragraph.id} checked={afterParagraphId === paragraph.id} onChange={() => setAfterParagraphId(paragraph.id)} />
          <span><strong>{paragraph.id}번째 문단</strong><span>{paragraph.text}</span></span>
        </label>)}
      </fieldset>
      <FieldError>{error}</FieldError>
    </Sheet>
    <ConfirmDialog open={deleting} onOpenChange={(value) => !operation && setDeleting(value)} title="삽화를 삭제할까요?" description="이 회차의 삽화를 삭제합니다. 원고 본문은 그대로 유지됩니다." busy={operation === 'remove'} onConfirm={() => void remove()} />
  </>;
}

export function EpisodeReadingPreview({ content, image }: { content: string; image: HighlightImage | null }) {
  const anchor = image ? resolveHighlightAnchor(content, image) : null;
  return <div className="episode-reading-preview" aria-label="회차 읽기 미리보기">
    <div className="episode-reading-prose">
      {image && anchor !== null ? <>{content.slice(0, anchor)}<HighlightFigure image={image} />{content.slice(anchor)}</> : content}
    </div>
    {image && anchor === null ? <section className="highlight-unplaced" aria-label="위치를 확인할 삽화"><p>삽화 위치를 다시 선택해 주세요.</p><HighlightFigure image={image} /></section> : null}
  </div>;
}

function HighlightFigure({ image }: { image: HighlightImage }) {
  return <figure className="highlight-figure"><img src={image.url} alt={image.altText} /></figure>;
}
