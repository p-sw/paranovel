import { useLayoutEffect, useRef } from 'react';
import { AlertTriangle, CheckCircle2, LoaderCircle } from 'lucide-react';
import { AI_PHASE_LABELS } from '../lib';
import type { AiPhase } from '../types';

export function DraftGenerationStatus({ phase, label }: { phase: AiPhase; label?: string }) {
  const active = ['retrieving', 'writing', 'checking', 'repairing'].includes(phase);
  return (
    <div className="generation-status" role="status" aria-live="polite">
      {active ? <LoaderCircle className="size-4 animate-spin" /> : phase === 'done' ? <CheckCircle2 className="size-4" /> : <AlertTriangle className="size-4" />}
      <span>{label ?? AI_PHASE_LABELS[phase]}</span>
    </div>
  );
}

export default function DraftPreview({
  value,
  onChange,
  readOnly,
  disabled,
  label,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  readOnly: boolean;
  disabled?: boolean;
  label: string;
  placeholder: string;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const readingPositionRef = useRef(0);
  const wasReadOnlyRef = useRef(readOnly);

  useLayoutEffect(() => {
    // Streaming must not move the paragraph the reader is looking at. Keep
    // this same textarea mounted when writing changes to review or editing.
    if ((readOnly || wasReadOnlyRef.current) && textareaRef.current) {
      textareaRef.current.scrollTop = readingPositionRef.current;
      readingPositionRef.current = textareaRef.current.scrollTop;
    }
    wasReadOnlyRef.current = readOnly;
  }, [value, readOnly]);

  return (
    <textarea
      ref={textareaRef}
      className="story-preview editable draft-preview"
      aria-label={label}
      value={value}
      readOnly={readOnly}
      disabled={disabled}
      placeholder={placeholder}
      onChange={(event) => onChange(event.target.value)}
      onScroll={(event) => { readingPositionRef.current = event.currentTarget.scrollTop; }}
    />
  );
}
