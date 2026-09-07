import type { EditorAiEdit } from '@paranovel/contracts';
import { Check } from 'lucide-react';
import { characterCount } from '../lib';
import { Button } from './Ui';

export function EditorAiEditCard({ edit, autoSelected, stale, disabled, applying, error, onApply }: {
  edit: EditorAiEdit; autoSelected: boolean; stale: boolean; disabled: boolean; applying: boolean; error?: string; onApply: () => void;
}) {
  const applied = edit.status === 'APPLIED';
  return <section className="editor-ai-edit" aria-label="원고 수정안">
    <h3 className="text-sm font-bold">{edit.title}</h3>
    <p className="mt-1 text-xs text-muted">{edit.end > edit.start
      ? `${autoSelected ? 'AI가 고른 범위' : '선택한 범위'} · ${characterCount(edit.original)}자`
      : '새 본문 삽입'}</p>
    <div className="editor-ai-comparison">
      <section className="editor-ai-version editor-ai-before" aria-label="수정 전">
        <div className="editor-ai-version-heading"><h4>수정 전</h4><span>{characterCount(edit.original)}자</span></div>
        <p className="editor-ai-version-text">{edit.original || <span className="text-muted">이 위치에 새 본문을 삽입합니다.</span>}</p>
      </section>
      <section className="editor-ai-version editor-ai-after" aria-label="수정 후">
        <div className="editor-ai-version-heading"><h4>수정 후</h4><span>{characterCount(edit.replacement)}자</span></div>
        <p className="editor-ai-version-text">{edit.replacement || <span className="text-muted">이 범위의 본문을 삭제합니다.</span>}</p>
      </section>
    </div>
    {applied ? <p className="mt-3 flex items-center gap-1.5 text-xs font-semibold text-sage-700"><Check className="size-4" />적용됨</p>
      : <>
        <Button className="mt-3 w-full" size="sm" disabled={disabled || stale} busy={applying} onClick={onApply}>
          <Check className="size-4" />수락하고 적용
        </Button>
        <p className="mt-2 text-xs leading-5 text-muted">{stale
          ? '원고가 변경되어 적용할 수 없어요. 현재 원고를 기준으로 다시 요청해 주세요.'
          : '수락하기 전에는 본문이 바뀌지 않아요.'}</p>
      </>}
    {error ? <p className="mt-2 text-sm text-red-700" role="alert">{error}</p> : null}
  </section>;
}
