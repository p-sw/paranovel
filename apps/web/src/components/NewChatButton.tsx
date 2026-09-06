import { useRef } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { api, messageOf } from '../api/client';
import { createIdempotencyKey } from '../lib';
import { Button } from './Ui';

export function NewChatButton({ projectId }: { projectId: string }) {
  const navigate = useNavigate();
  const client = useQueryClient();
  const requestId = useRef<string | null>(null);
  const creating = useRef(false);
  const mutation = useMutation({
    mutationFn: (clientThreadId: string) => api.chat.createThread(projectId, clientThreadId),
    onSuccess: (thread) => {
      void client.invalidateQueries({ queryKey: ['chat-threads', projectId] });
      requestId.current = null;
      navigate(`/projects/${projectId}/chat/${encodeURIComponent(thread.id)}`);
    },
    onSettled: () => { creating.current = false; },
  });

  return <div className="min-w-0">
    <Button busy={mutation.isPending} onClick={() => {
      if (creating.current) return;
      creating.current = true;
      requestId.current ??= createIdempotencyKey();
      mutation.mutate(requestId.current);
    }}><Plus className="size-4" aria-hidden="true" />새 채팅</Button>
    {mutation.isError ? <p className="mt-2 max-w-xs text-sm text-red-700" role="alert">{messageOf(mutation.error)}</p> : null}
  </div>;
}
