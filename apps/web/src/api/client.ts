import type {
  Arc,
  ArcPlanProposal,
  CanonEntry,
  CanonCategory,
  CurrentScene,
  Episode,
  Improvement,
  ImprovementCandidate,
  ImprovementSuggestion,
  Project,
  ProjectBlueprint,
  ProjectSessionResult,
  StreamEvent,
  StreamResult,
} from '../types';

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

  const consume = (line: string) => {
    if (!line.trim()) return;
    let event: StreamEvent;
    try {
      event = JSON.parse(line) as StreamEvent;
    } catch {
      throw new ApiError('AI 응답을 해석하지 못했습니다.', 502, line);
    }
    if (event.type === 'meta') {
      runId = event.runId;
      baseRevision = event.baseRevision;
    }
    if (event.type === 'delta') content += event.text;
    if (event.type === 'reset') content = '';
    if (event.type === 'done') {
      content = event.content;
      issues = event.issues;
      blocked = event.blocked;
      baseRevision = event.baseRevision ?? baseRevision;
    }
    if (event.type === 'error') throw new ApiError(event.message, 502);
    onEvent(event, content);
  };

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) consume(line);
    if (done) break;
  }
  if (buffer.trim()) consume(buffer);

  return { content, issues, blocked, runId, baseRevision };
}

export const api = {
  projects: {
    list: () => json<Project[]>('/projects'),
    get: (projectId: string) => json<Project>(`/projects/${projectId}`),
    update: (
      projectId: string,
      input: Partial<Pick<Project, 'title' | 'logline' | 'genreTags' | 'details' | 'defaultTargetChars'>> & {
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
      input: { questionId: string; answer?: string | string[]; skipOptional?: true },
    ) =>
      json<ProjectSessionResult>(`/project-sessions/${sessionId}/respond`, { method: 'POST', body: input }),
    commit: (sessionId: string, blueprint: ProjectBlueprint) =>
      json<{ project: Project }>(`/project-sessions/${sessionId}/commit`, {
        method: 'POST',
        body: { blueprint: { ...blueprint, defaultTargetChars: blueprint.defaultTargetChars ?? 5000 } },
      }),
  },
  episodes: {
    list: (projectId: string) => json<Episode[]>(`/projects/${projectId}/episodes`),
    get: (projectId: string, episodeId: string) =>
      json<Episode>(`/projects/${projectId}/episodes/${episodeId}`),
    create: (
      projectId: string,
      input: { title: string; direction: string; content?: string; forceNeedsReview?: boolean },
      idempotencyKey: string,
    ) =>
      json<Episode>(`/projects/${projectId}/episodes`, {
        method: 'POST',
        body: input,
        headers: { 'Idempotency-Key': idempotencyKey },
      }),
    propose: (projectId: string, hint?: string) =>
      json<{ title: string; direction: string; conflicts: string[] }>(`/projects/${projectId}/episodes/propose`, {
        method: 'POST',
        body: hint ? { hint } : {},
      }),
    generate: (
      projectId: string,
      input: { title: string; direction: string },
      onEvent: (event: StreamEvent, content: string) => void,
      signal?: AbortSignal,
    ) => ndjson(`/projects/${projectId}/episodes/generate`, input, onEvent, signal),
    update: (
      projectId: string,
      episodeId: string,
      input: {
        expectedRevision: number;
        title?: string;
        direction?: string;
        content?: string;
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
    create: (projectId: string, input: {
      title: string;
      startEpisode: number;
      endEpisode: number;
      goal: string;
      conflict: string;
      reversalPlan: Array<{ id?: string; episode: number; description: string }>;
      status?: Arc['status'];
      twistPlan?: string;
    }) =>
      json<Arc>(`/projects/${projectId}/arcs`, {
        method: 'POST',
        body: {
          ...input,
          startEpisodeNumber: input.startEpisode,
          endEpisodeNumber: input.endEpisode,
        },
      }),
    update: (projectId: string, arcId: string, input: Partial<Arc> & { expectedRevision: number }) => {
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
    remove: (projectId: string, arcId: string) =>
      json<void>(`/projects/${projectId}/arcs/${arcId}`, { method: 'DELETE' }),
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
