import { useCallback, useEffect, useRef, useState } from 'react';
import { messageOf } from './api/client';
import type { AiPhase, ContinuityIssue, StreamEvent, StreamResult } from './types';

export function useContinuityRepair({ request, onSuccess }: {
  request: (
    issue: ContinuityIssue,
    onEvent: (event: StreamEvent, content: string) => void,
    signal: AbortSignal,
  ) => Promise<StreamResult>;
  onSuccess: (result: StreamResult) => void;
}) {
  const abortRef = useRef<AbortController | null>(null);
  const [repairingIndex, setRepairingIndex] = useState<number | null>(null);
  const [phase, setPhase] = useState<AiPhase | null>(null);
  const [error, setError] = useState('');

  const reset = useCallback(() => {
    const controller = abortRef.current;
    abortRef.current = null;
    controller?.abort();
    setRepairingIndex(null);
    setPhase(null);
    setError('');
  }, []);

  const cancel = useCallback(() => {
    reset();
    setError('수정을 중단했습니다.');
  }, [reset]);

  useEffect(() => () => {
    const controller = abortRef.current;
    abortRef.current = null;
    controller?.abort();
  }, []);

  const repair = async (issue: ContinuityIssue, index: number) => {
    if (abortRef.current) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setRepairingIndex(index);
    setPhase('repairing');
    setError('');
    try {
      const result = await request(issue, (event) => {
        if (controller.signal.aborted || abortRef.current !== controller) return;
        if (event.type === 'stage') {
          setPhase(event.stage === 'CHECKING' ? 'checking' : event.stage === 'MEMORY' ? 'retrieving' : 'repairing');
        }
      }, controller.signal);
      if (controller.signal.aborted || abortRef.current !== controller) return;
      // Replace the preview and its issues together only after the corrected
      // candidate has passed through review and the stream has completed.
      onSuccess(result);
    } catch (reason) {
      if (controller.signal.aborted || abortRef.current !== controller) return;
      setError(messageOf(reason));
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
        setRepairingIndex(null);
        setPhase(null);
      }
    }
  };

  return { repair, cancel, reset, repairingIndex, phase, error, isRepairing: repairingIndex !== null };
}
