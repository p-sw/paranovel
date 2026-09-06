import { aiStreamEventSchema } from '@paranovel/contracts';
import type { ChatHistory, ChatProposal, ChatThread, ChatThreadSummary, EditorAiHistory, EditorAiInput, EditorAiMessage, EpisodeOrder, UpdateEpisodeOrderInput } from '@paranovel/contracts';
import type {
  Arc,
  ArcPlanProposal,
  CanonEntry,
  CanonCategory,
  CreateSideStoryGroupInput,
  ContinuityIssue,
  CurrentScene,
  Episode,
  EpisodeFlow,
  Improvement,
  ImprovementCandidate,
  ImprovementSuggestion,
  Project,
  ProjectBlueprint,
  ProjectSessionResult,
  SideStoryCollection,
  SideStoryGroup,
  StreamEvent,
  StreamResult,
} from '../types';

export type EpisodePlanContext =
  | { episodeId: string; expectedRevision?: number }
  | {
      kind: 'SIDE_STORY';
      sideStoryGroupId: string | null;
      branchFromEpisodeId: string | null;
    };

export class ApiError extends Error {
  status: number;
  details?: unknown;

  constructor(message: string, status: number, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.details = details;
  }
}

type JsonOptions = Omit<RequestInit, 'body'> & { body?: unknown };

type ArcMutableFields = Pick<Arc, 'title' | 'startEpisode' | 'endEpisode' | 'goal' | 'conflict' | 'reversalPlan'>;
type ArcWritableStatus = Extract<Arc['status'], 'PLANNED' | 'ACTIVE'>;
type CreateArcInput = ArcMutableFields & {
  status?: ArcWritableStatus;
  confirmProtected?: boolean;
};
type UpdateArcInput = Partial<ArcMutableFields> & {
  expectedRevision: number;
  status?: ArcWritableStatus;
  confirmProtected?: boolean;
};

async function json<T>(path: string, options: JsonOptions = {}): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...options,
    headers: {
      Accept: 'application/json',
      ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...options.headers,
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  const contentType = response.headers.get('content-type') ?? '';
  const payload = contentType.includes('application/json')
    ? await response.json()
    : await response.text();

  if (!response.ok) {
    const message =
      typeof payload === 'object' && payload && 'message' in payload
        ? String(payload.message)
        : typeof payload === 'string' && payload
          ? payload
          : '요청을 처리하지 못했습니다.';
    throw new ApiError(message, response.status, payload);
  }

  return payload as T;
}

async function ndjson(
  path: string,
  body: unknown,
  onEvent: (event: StreamEvent, accumulated: string) => void,
  signal?: AbortSignal,
  options: { allowReplacement?: boolean } = {},
): Promise<StreamResult> {
  const response = await fetch(`/api${path}`, {
    method: 'POST',
    headers: {
      Accept: 'application/x-ndjson',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const payload = await response.text();
    throw new ApiError(payload || 'AI 요청을 시작하지 못했습니다.', response.status);
  }
  if (!response.body) {
    throw new ApiError('스트리밍 응답 본문이 없습니다.', 502);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let runId: string | undefined;
  let issues: StreamResult['issues'] = [];
  let blocked = false;
  let baseRevision: number | undefined;
  let completed = false;
  let preservingDraft = false;

  const consume = (line: string) => {
    if (!line.trim() || completed) return;
    let event: StreamEvent;
    try {
      event = aiStreamEventSchema.parse(JSON.parse(line));
    } catch {
      throw new ApiError('AI 응답을 해석하지 못했습니다.', 502, line);
    }
    if (event.type === 'meta') {
      runId = event.runId;
      baseRevision = event.baseRevision;
    }
    // The completed writing stream is immutable during post-processing.
    // Only an explicit repair request may replace it at completion.
    if (event.type === 'reset' || (event.type === 'stage' && ['CHECKING', 'REPAIRING'].includes(event.stage))) {
      preservingDraft = true;
    }
    if (event.type === 'delta' && !preservingDraft) content += event.text;
    if (event.type === 'done') {
      if (!event.content.trim()) {
        throw new ApiError('AI가 빈 원고를 반환했습니다. 생성된 원고를 확인하고 다시 시도해 주세요.', 502);
      }
      if (!options.allowReplacement && event.content !== content) {
        throw new ApiError('완료 응답의 본문이 생성된 초안과 달라 반영하지 않았습니다. 원래 초안을 확인해 주세요.', 502);
      }
      content = event.content;
      issues = event.issues;
      blocked = event.blocked;
      baseRevision = event.baseRevision ?? baseRevision;
      completed = true;
    }
    if (event.type === 'error') throw new ApiError(event.message, 502);
    onEvent(event, content);
  };

  const abort = () => { void reader.cancel(signal?.reason).catch(() => undefined); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    while (!completed) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) consume(line);
      if (done) break;
    }
    if (buffer.trim()) consume(buffer);
    if (!completed) {
      throw new ApiError('AI 응답이 완료되기 전에 연결이 끊겼습니다. 생성된 원고를 확인해 주세요.', 502);
    }
    return { content, issues, blocked, runId, baseRevision };
  } finally {
    signal?.removeEventListener('abort', abort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export const api = {
  editorAi: {
    history: (projectId: string, episodeId: string) =>
      json<EditorAiHistory>(`/projects/${projectId}/episodes/${episodeId}/editor-ai/messages`),
    send: (projectId: string, episodeId: string, input: EditorAiInput) =>
      json<EditorAiHistory>(`/projects/${projectId}/episodes/${episodeId}/editor-ai/messages`, { method: 'POST', body: input }),
    apply: (projectId: string, episodeId: string, messageId: string) =>
      json<{ episode: Episode; message: EditorAiMessage }>(`/projects/${projectId}/episodes/${episodeId}/editor-ai/messages/${encodeURIComponent(messageId)}/apply`, { method: 'POST' }),
  },
  chat: {
    threads: (projectId: string) => json<ChatThreadSummary[]>(`/projects/${projectId}/chat/threads`),
    createThread: (projectId: string, clientThreadId: string) =>
      json<ChatThread>(`/projects/${projectId}/chat/threads`, { method: 'POST', body: { clientThreadId } }),
    history: (projectId: string, threadId?: string) =>
      json<ChatHistory>(`/projects/${projectId}/chat/${threadId ? `threads/${encodeURIComponent(threadId)}/` : ''}messages`),
    send: (projectId: string, input: { content: string; clientMessageId: string }, threadId?: string) =>
      json<ChatHistory>(`/projects/${projectId}/chat/${threadId ? `threads/${encodeURIComponent(threadId)}/` : ''}messages`, { method: 'POST', body: input }),
    apply: (projectId: string, proposalId: string) =>
      json<{ proposal: ChatProposal }>(`/projects/${projectId}/chat/proposals/${proposalId}/apply`, { method: 'POST' }),
  },
  projects: {
    list: () => json<Project[]>('/projects'),
    get: (projectId: string) => json<Project>(`/projects/${projectId}`),
    update: (
      projectId: string,
      input: Partial<Pick<Project, 'title' | 'logline' | 'genreTags' | 'writingDirection' | 'defaultTargetChars'>> & {
        expectedRevision: number;
      },
    ) =>
      json<Project>(`/projects/${projectId}`, { method: 'PATCH', body: input }),
    remove: (projectId: string) => json<void>(`/projects/${projectId}`, { method: 'DELETE' }),
  },
  sessions: {
    start: (input: { logline: string; genreTags: string[] }) =>
      json<ProjectSessionResult>('/project-sessions', { method: 'POST', body: input }),
    get: (sessionId: string) => json<ProjectSessionResult>(`/project-sessions/${sessionId}`),
    respond: (
      sessionId: string,
      input: { questionId: string; answer?: string | string[]; otherAnswer?: string; skipOptional?: true; position?: number; expectedState?: string },
    ) =>
      json<ProjectSessionResult>(`/project-sessions/${sessionId}/respond`, { method: 'POST', body: input }),
    commit: (sessionId: string, blueprint: ProjectBlueprint, expectedState?: string) =>
      json<{ project: Project }>(`/project-sessions/${sessionId}/commit`, {
        method: 'POST',
        body: { blueprint: { ...blueprint, defaultTargetChars: blueprint.defaultTargetChars ?? 5000 }, ...(expectedState ? { expectedState } : {}) },
      }),
  },
  episodes: {
    order: (projectId: string) => json<EpisodeOrder>(`/projects/${projectId}/episodes/order`),
    updateOrder: (projectId: string, input: UpdateEpisodeOrderInput) =>
      json<EpisodeOrder>(`/projects/${projectId}/episodes/order`, { method: 'PUT', body: input }),
    list: (projectId: string) => json<Episode[]>(`/projects/${projectId}/episodes`),
    get: (projectId: string, episodeId: string) =>
      json<Episode>(`/projects/${projectId}/episodes/${episodeId}`),
    flow: (projectId: string, episodeId: string) =>
      json<EpisodeFlow>(`/projects/${projectId}/episodes/${episodeId}/flow`),
    create: (
      projectId: string,
      input: { title: string; direction: string; content?: string; incomplete?: boolean; forceNeedsReview?: boolean },
      idempotencyKey: string,
    ) =>
      json<Episode>(`/projects/${projectId}/episodes`, {
        method: 'POST',
        body: input,
        headers: { 'Idempotency-Key': idempotencyKey },
      }),
    propose: (projectId: string, hint?: string, signal?: AbortSignal, context?: EpisodePlanContext) =>
      json<{ title: string; direction: string; conflicts: string[] }>(`/projects/${projectId}/episodes/propose`, {
        method: 'POST',
        body: { ...(hint ? { hint } : {}), ...context },
        signal,
      }),
    refine: (
      projectId: string,
      input: {
        title: string;
        direction?: string;
        instruction: string;
        episodeId?: string;
        expectedRevision?: number;
        kind?: 'SIDE_STORY';
        sideStoryGroupId?: string | null;
        branchFromEpisodeId?: string | null;
      },
      signal?: AbortSignal,
    ) =>
      json<{ title: string; direction: string; conflicts: string[] }>(`/projects/${projectId}/episodes/refine`, {
        method: 'POST',
        body: input,
        signal,
      }),
    generate: (
      projectId: string,
      input: { title: string; direction: string; episodeId?: string; expectedRevision?: number },
      onEvent: (event: StreamEvent, content: string) => void,
      signal?: AbortSignal,
    ) => ndjson(`/projects/${projectId}/episodes/generate`, input, onEvent, signal),
    repair: (
      projectId: string,
      input: { title: string; direction: string; content: string; issue: ContinuityIssue; episodeId?: string; expectedRevision?: number },
      onEvent: (event: StreamEvent, content: string) => void,
      signal?: AbortSignal,
    ) => ndjson(`/projects/${projectId}/episodes/repair`, input, onEvent, signal, { allowReplacement: true }),
    update: (
      projectId: string,
      episodeId: string,
      input: {
        expectedRevision: number;
        title?: string;
        direction?: string;
        content?: string;
        incomplete?: boolean;
        forceNeedsReview?: boolean;
      },
    ) => json<Episode>(`/projects/${projectId}/episodes/${episodeId}`, { method: 'PATCH', body: input }),
    remove: (projectId: string, episodeId: string, expectedRevision: number) =>
      json<void>(`/projects/${projectId}/episodes/${episodeId}`, {
        method: 'DELETE',
        body: { expectedRevision },
      }),
    finalize: (projectId: string, episodeId: string, expectedRevision: number) =>
      json<Episode>(`/projects/${projectId}/episodes/${episodeId}/finalize`, {
        method: 'POST',
        body: { expectedRevision },
      }),
    continue: (
      projectId: string,
      episodeId: string,
      input: { expectedRevision: number; cursorOffset: number },
      onEvent: (event: StreamEvent, content: string) => void,
      signal?: AbortSignal,
    ) => ndjson(`/projects/${projectId}/episodes/${episodeId}/continue`, input, onEvent, signal),
    repairContinuation: (
      projectId: string,
      episodeId: string,
      input: { expectedRevision: number; cursorOffset: number; content: string; issue: ContinuityIssue },
      onEvent: (event: StreamEvent, content: string) => void,
      signal?: AbortSignal,
    ) => ndjson(`/projects/${projectId}/episodes/${episodeId}/repair`, input, onEvent, signal, { allowReplacement: true }),
    replaceSelection: (
      projectId: string,
      episodeId: string,
      input: {
        expectedRevision: number;
        start: number;
        end: number;
        selectedText: string;
        replacement: string;
      },
    ) =>
      json<{ episode: Episode }>(
        `/projects/${projectId}/episodes/${episodeId}/selection-replacements`,
        { method: 'POST', body: input },
      ),
  },
  sideStories: {
    list: (projectId: string) =>
      json<SideStoryCollection>(`/projects/${projectId}/side-stories`),
    create: (
      projectId: string,
      input: {
        title: string;
        direction?: string;
        content?: string;
        incomplete?: boolean;
        forceNeedsReview?: boolean;
        groupId: string | null;
        branchFromEpisodeId: string | null;
      },
      idempotencyKey: string,
    ) => json<Episode>(`/projects/${projectId}/side-stories`, {
      method: 'POST',
      body: input,
      headers: { 'Idempotency-Key': idempotencyKey },
    }),
  },
  sideStoryGroups: {
    list: (projectId: string) =>
      json<SideStoryGroup[]>(`/projects/${projectId}/side-story-groups`),
    get: (projectId: string, groupId: string) =>
      json<SideStoryGroup>(`/projects/${projectId}/side-story-groups/${encodeURIComponent(groupId)}`),
    create: (projectId: string, input: CreateSideStoryGroupInput, idempotencyKey: string) =>
      json<SideStoryGroup>(`/projects/${projectId}/side-story-groups`, {
        method: 'POST',
        body: input,
        headers: { 'Idempotency-Key': idempotencyKey },
      }),
    update: (
      projectId: string,
      groupId: string,
      input: { expectedRevision: number; title?: string; description?: string },
    ) =>
      json<SideStoryGroup>(`/projects/${projectId}/side-story-groups/${encodeURIComponent(groupId)}`, { method: 'PATCH', body: input }),
  },
  scenes: {
    get: (projectId: string, episodeId: string) =>
      json<CurrentScene>(`/projects/${projectId}/episodes/${episodeId}/scene`),
    update: (
      projectId: string,
      episodeId: string,
      input: Partial<Omit<CurrentScene, 'episodeId' | 'sourceRevision'>> & { expectedRevision: number },
    ) =>
      json<CurrentScene>(`/projects/${projectId}/episodes/${episodeId}/scene`, {
        method: 'PATCH',
        body: input,
      }),
  },
  memory: {
    reindex: (projectId: string) =>
      json<{ indexed?: number }>(`/projects/${projectId}/memory/reindex`, { method: 'POST' }),
  },
  canon: {
    list: (projectId: string) => json<CanonEntry[]>(`/projects/${projectId}/canon`),
    create: (projectId: string, input: {
      category: CanonCategory;
      name: string;
      aliases?: string[];
      content: string;
      metadata?: Record<string, unknown>;
      status?: 'ACTIVE' | 'PENDING';
      sourceEpisodeId?: string;
    }) =>
      json<CanonEntry>(`/projects/${projectId}/canon`, { method: 'POST', body: input }),
    update: (
      projectId: string,
      canonId: string,
      input: Partial<CanonEntry> & { expectedRevision: number },
    ) =>
      json<CanonEntry>(`/projects/${projectId}/canon/${canonId}`, { method: 'PATCH', body: input }),
    remove: (projectId: string, canonId: string) =>
      json<void>(`/projects/${projectId}/canon/${canonId}`, { method: 'DELETE' }),
    generate: (projectId: string) =>
      json<{ suggestions: Array<Partial<CanonEntry>>; conflicts: string[] }>(`/projects/${projectId}/canon/generate`, {
        method: 'POST',
      }),
  },
  arcs: {
    list: (projectId: string) => json<Arc[]>(`/projects/${projectId}/arcs`),
    current: (projectId: string) => json<Arc | null>(`/projects/${projectId}/arcs/current`),
    plan: (projectId: string, request?: string) =>
      json<ArcPlanProposal>(`/projects/${projectId}/arcs/plan`, {
        method: 'POST',
        body: request?.trim() ? { request: request.trim() } : {},
      }),
    create: (projectId: string, input: CreateArcInput) =>
      json<Arc>(`/projects/${projectId}/arcs`, {
        method: 'POST',
        body: {
          ...input,
          startEpisodeNumber: input.startEpisode,
          endEpisodeNumber: input.endEpisode,
        },
      }),
    update: (projectId: string, arcId: string, input: UpdateArcInput) => {
      const { startEpisode, endEpisode, ...rest } = input;
      return json<Arc>(`/projects/${projectId}/arcs/${arcId}`, {
        method: 'PATCH',
        body: {
          ...rest,
          ...(startEpisode === undefined ? {} : { startEpisodeNumber: startEpisode }),
          ...(endEpisode === undefined ? {} : { endEpisodeNumber: endEpisode }),
        },
      });
    },
    remove: (projectId: string, arcId: string, expectedRevision: number) =>
      json<void>(`/projects/${projectId}/arcs/${arcId}`, {
        method: 'DELETE',
        body: { expectedRevision },
      }),
  },
  improvements: {
    list: (projectId?: string) =>
      json<Improvement[]>(`/improvements${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`),
    create: (input: ImprovementSuggestion & { scope: 'GLOBAL' | 'PROJECT'; projectId?: string | null }) =>
      json<Improvement>('/improvements', { method: 'POST', body: input }),
    update: (id: string, input: Partial<Improvement> & { expectedRevision: number }) =>
      json<Improvement>(`/improvements/${id}`, { method: 'PATCH', body: input }),
    remove: (id: string) => json<void>(`/improvements/${id}`, { method: 'DELETE' }),
    candidates: (input: {
      source: 'EDITOR' | 'COMPARISON';
      projectId?: string;
      original: string;
      revised: string;
    }) =>
      json<{ candidates: ImprovementCandidate[] }>('/improvement-candidates', {
        method: 'POST',
        body: input,
      }),
    accept: (
      input: { projectId?: string; candidates: ImprovementCandidate[] },
      idempotencyKey: string,
    ) =>
      json<{ improvements: Improvement[] }>('/improvements/batch', {
        method: 'POST',
        body: input,
        headers: { 'Idempotency-Key': idempotencyKey },
      }),
  },
  comparisons: {
    generate: (
      input: { brief: string; targetChars?: number },
      onEvent: (event: StreamEvent, content: string) => void,
      signal?: AbortSignal,
    ) => ndjson('/comparisons/generate', input, onEvent, signal),
  },
};

export function isConflict(error: unknown): error is ApiError {
  return error instanceof ApiError && error.status === 409;
}

export function messageOf(error: unknown): string {
  if (error instanceof DOMException && error.name === 'AbortError') return '생성을 중단했습니다.';
  if (error instanceof Error) return error.message;
  return '알 수 없는 오류가 발생했습니다.';
}
