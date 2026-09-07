import { useEffect, useRef, useState } from 'react';
import type { AiConversationEvent } from '@paranovel/contracts';

export interface ConversationProgress {
  text: string;
  tools: Record<string, string>;
}

const emptyProgress = (): ConversationProgress => ({ text: '', tools: {} });

export function useConversationStream(identity: string) {
  const [progress, setProgress] = useState<ConversationProgress>(emptyProgress);
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => () => { controllerRef.current?.abort(); }, [identity]);

  const start = () => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setProgress(emptyProgress());
    return {
      signal: controller.signal,
      onEvent: (event: AiConversationEvent | { type: 'start' | 'complete' | 'error' }) => {
        if (controller.signal.aborted) return;
        setProgress((previous) => {
          if (event.type === 'reset') return emptyProgress();
          if (event.type === 'delta') return { ...previous, text: previous.text + event.text };
          if (event.type === 'tool_start') return { ...previous, tools: { ...previous.tools, [event.callId]: event.name } };
          if (event.type === 'tool_end') {
            const tools = { ...previous.tools };
            delete tools[event.callId];
            return { ...previous, tools };
          }
          return previous;
        });
      },
    };
  };

  return { progress, start, isAborted: () => controllerRef.current?.signal.aborted ?? false };
}
