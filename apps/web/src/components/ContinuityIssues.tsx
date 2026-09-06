import { Sparkles } from 'lucide-react';
import type { ContinuityIssue } from '../types';
import { Button } from './Ui';

export default function ContinuityIssues({ issues, blocked, heading, onRepair, repairingIndex, disabled }: {
  issues: ContinuityIssue[];
  blocked: boolean;
  heading: string;
  onRepair: (issue: ContinuityIssue, index: number) => void;
  repairingIndex: number | null;
  disabled: boolean;
}) {
  if (!issues.length) return null;

  return (
    <div className={blocked ? 'warning-box danger' : 'warning-box'} role="alert">
      <strong>{heading}</strong>
      <p className="mt-1 text-sm">본문은 그대로 유지됩니다. 수정할 항목의 ‘자동 수정’을 눌러 주세요.</p>
      <ul>
        {issues.map((issue, index) => (
          <li key={`${issue.explanation}-${index}`}>
            <div className="flex flex-col gap-2 py-1 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
              <div className="min-w-0 break-words">
                <p><b>{issue.severity === 'BLOCKING' ? '차단' : '주의'}:</b> {issue.explanation}</p>
                {issue.excerpt ? <p className="mt-1 text-sm">위치: <q>{issue.excerpt}</q></p> : null}
                {issue.repairInstruction ? <p className="mt-1 text-sm">수정 방향: {issue.repairInstruction}</p> : null}
              </div>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="shrink-0 self-start"
                aria-label={`자동 수정: ${issue.explanation}`}
                busy={repairingIndex === index}
                disabled={disabled || repairingIndex !== null}
                onClick={() => onRepair(issue, index)}
              >
                {repairingIndex === index ? null : <Sparkles className="size-3.5" aria-hidden="true" />}
                {repairingIndex === index ? '수정 중' : '자동 수정'}
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
