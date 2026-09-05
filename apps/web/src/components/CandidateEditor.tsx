import type { ImprovementCandidate } from '../types';
import { Badge } from './Ui';
import { cx } from '../lib';
import { candidateNeedsExplicitSelection } from '../candidateSelection';

export default function CandidateEditor({
  candidate,
  checked,
  onCheckedChange,
  onChange,
}: {
  candidate: ImprovementCandidate;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  onChange: (candidate: ImprovementCandidate) => void;
}) {
  const needsExplicitSelection = candidateNeedsExplicitSelection(candidate);
  return (
    <article className={cx('candidate-card editable', checked && 'selected')}>
      <label className="candidate-check">
        <input type="checkbox" checked={checked} onChange={(event) => onCheckedChange(event.target.checked)} />
        <span className="sr-only">{candidate.title || '개선점'} 선택</span>
      </label>
      <div className="min-w-0 flex-1 space-y-3">
        <div className="flex flex-wrap gap-1.5">
          <Badge tone="plum">신뢰도 {Math.round((candidate.confidence ?? 0.5) * 100)}%</Badge>
          {candidate.duplicateOfId ? <Badge tone="warning">유사 규칙 있음</Badge> : null}
          {candidate.conflictsWithIds?.length ? <Badge tone="danger">충돌 {candidate.conflictsWithIds.length}개</Badge> : null}
        </div>
        {needsExplicitSelection ? (
          <p className="candidate-risk-note" role="note">
            기존 개선점과 겹치거나 충돌할 수 있어 기본 선택에서 제외했습니다. 내용을 확인한 뒤 체크해 주세요.
          </p>
        ) : null}
        <label><span className="candidate-field-label">제목</span><input className="input" value={candidate.title} onChange={(event) => onChange({ ...candidate, title: event.target.value })} /></label>
        <label><span className="candidate-field-label">항상 적용할 규칙</span><textarea className="input" value={candidate.rule} onChange={(event) => onChange({ ...candidate, rule: event.target.value })} /></label>
        <label><span className="candidate-field-label">이유</span><textarea className="input" value={candidate.rationale} onChange={(event) => onChange({ ...candidate, rationale: event.target.value })} /></label>
      </div>
    </article>
  );
}
