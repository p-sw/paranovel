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
      <ul>
        {issues.map((issue, index) => (
          <li key={`${issue.explanation}-${index}`}>
            <div className="flex flex-col gap-2 py-1 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
              <p className="min-w-0 break-words">
                <b>{issue.severity === 'BLOCKING' ? '차단' : '주의'}:</b> {issue.explanation}
              </p>
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
