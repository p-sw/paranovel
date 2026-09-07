import { BadGatewayException, Injectable, Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service';
import { aiRuns } from '../database/schema';
import {
  PromptRegistryService,
  type PromptId,
} from '../prompts/prompt-registry.service';
import { sanitizeLogText, serializeError } from '../shared/error-log';
import { id, now, sha256, stringifyJson } from '../shared/utils';
import type {
  ChatMessage,
  ChatStreamEvent,
  CompletionRequest,
  CompletionResult,
  CompletionUsage,
  PromptRunInput,
  ToolCall,
  ToolDefinition,
} from './ai.types';
import { OpenRouterGateway } from './openrouter.gateway';
import { JsonReplyStream } from './json-reply-stream';
import {
  TavilySearchService,
  tavilySearchTool,
  type ReferenceSearchResult,
} from './tavily-search.service';
import type { ZodType } from 'zod';

const MEMORY_VARIABLE_KEYS = [
  'project_context',
  'writing_direction',
  'improvements',
  'canon',
  'current_arc',
  'current_scene',
  'recent_summaries',
  'open_foreshadowing',
  'retrieved_memories',
  'previous_episode_memories',
] as const;

const REFERENCE_PROMPT_IDS = new Set([
  'project-blueprint',
  'worldbuilding-generate',
  'arc-plan',
  'episode-direction',
  'episode-draft',
  'episode-continue',
  'comparison-draft',
]);
const MAX_REFERENCE_SEARCHES = 3;

function addUsage(total: CompletionUsage, usage: CompletionUsage): CompletionUsage {
  return {
    promptTokens: usage.promptTokens === undefined
      ? total.promptTokens : (total.promptTokens ?? 0) + usage.promptTokens,
    completionTokens: usage.completionTokens === undefined
      ? total.completionTokens : (total.completionTokens ?? 0) + usage.completionTokens,
  };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function toolContentWithinBudget(result: unknown, budget: number): string {
  const content = stringifyJson(result);
  if (content.length <= budget) return content;
  const truncated = (length: number): string => stringifyJson({ truncated: true, excerpt: content.slice(0, length) });
  if (truncated(0).length > budget) return '';
  let lower = 0;
  let upper = Math.min(content.length, budget);
  while (lower < upper) {
    const middle = Math.ceil((lower + upper) / 2);
    if (truncated(middle).length <= budget) lower = middle;
    else upper = middle - 1;
  }
  return truncated(lower);
}

@Injectable()
export class AiRunnerService {
  private readonly logger = new Logger(AiRunnerService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly prompts: PromptRegistryService,
    private readonly gateway: OpenRouterGateway,
    private readonly tavily: TavilySearchService,
  ) {}

  writingModel(): string {
    return process.env.AI_WRITING_MODEL ?? 'google/gemini-3.8-flash';
  }

  improvementModel(): string {
    return process.env.AI_IMPROVEMENT_MODEL ?? 'openai/gpt-5.6-luna';
  }

  chatModel(): string {
    return process.env.AI_CHAT_MODEL ?? 'openai/gpt-5.6-luna';
  }

  imageTagModel(): string {
    return process.env.AI_IMAGE_TAG_MODEL?.trim() || 'openai/gpt-5.6-luna';
  }

  async completeChat<T>(
    input: PromptRunInput & {
      validator: ZodType<T>;
      readTools: ToolDefinition[];
      readTool: (name: string, argumentsJson: string) => Promise<unknown>;
      resolveAfterTools?: () => T | undefined;
      toolMaxTokens?: number;
      onEvent?: (event: ChatStreamEvent) => void;
      // Only independent tools belong here. All other calls are ordering barriers.
      parallelToolNames?: string[];
    },
    onRunStarted?: (runId: string) => void,
  ): Promise<{ runId: string; value: T }> {
    let value: T | undefined;
    const { runId } = await this.execute({ ...input, modelRole: input.modelRole ?? 'CHAT', includeReferenceTools: input.readTools.some((tool) => tool.function.name === tavilySearchTool.function.name) }, async (request) => {
      const messages = [...request.messages];
      let usage: CompletionUsage = {};
      let calls = 0;
      let referenceSearches = 0;
      let remainingCharacters = 60_000;
      const parallelTools = new Set(input.parallelToolNames ?? []);
      const complete = (completionRequest: CompletionRequest, onDelta: (text: string) => void) =>
        input.onEvent ? this.gateway.streamText(completionRequest, onDelta) : this.gateway.complete(completionRequest);
      const runTool = async (call: ToolCall): Promise<unknown> => {
        input.signal?.throwIfAborted();
        // Reserve limits before the first await, in the model's call order.
        if (calls >= 8 || remainingCharacters <= 0) return { error: 'READ_LIMIT_REACHED' };
        calls += 1;
        if (call.function.name === tavilySearchTool.function.name) {
          if (referenceSearches >= MAX_REFERENCE_SEARCHES) return { error: 'SEARCH_LIMIT_REACHED' };
          referenceSearches += 1;
        }
        input.onEvent?.({ type: 'tool_start', callId: call.id, name: call.function.name });
        try {
          const result = await input.readTool(call.function.name, call.function.arguments);
          input.signal?.throwIfAborted();
          return result;
        } finally {
          if (!input.signal?.aborted) input.onEvent?.({ type: 'tool_end', callId: call.id, name: call.function.name });
        }
      };
      for (let round = 0; round < 4 && calls < 8; round += 1) {
        input.signal?.throwIfAborted();
        const response = await complete({
          ...request, messages: [...messages], schema: undefined,
          tools: input.readTools, toolChoice: 'auto', maxTokens: input.toolMaxTokens ?? 2_000,
        }, () => undefined);
        usage = addUsage(usage, response.usage);
        if (!response.toolCalls.length) break;
        messages.push(response.assistantMessage ?? {
          role: 'assistant', content: response.content || null, tool_calls: response.toolCalls,
        });
        for (let index = 0; index < response.toolCalls.length;) {
          const batch: ToolCall[] = [response.toolCalls[index++]!];
          if (parallelTools.has(batch[0]!.function.name)) {
            while (index < response.toolCalls.length && parallelTools.has(response.toolCalls[index]!.function.name)) {
              batch.push(response.toolCalls[index++]!);
            }
          }
          const results = await Promise.allSettled(batch.map(runTool));
          input.signal?.throwIfAborted();
          const failure = results.find((result) => result.status === 'rejected');
          if (failure?.status === 'rejected') throw failure.reason;
          for (let position = 0; position < batch.length; position += 1) {
            const result = results[position]!;
            if (result.status !== 'fulfilled') continue;
            const content = toolContentWithinBudget(result.value, remainingCharacters);
            remainingCharacters -= content.length;
            messages.push({ role: 'tool', tool_call_id: batch[position]!.id, content });
            // Sequential tools can produce an authoritative reply (e.g. images).
            // Finish before starting later calls or another model round.
            const terminalValue = input.resolveAfterTools?.();
            if (terminalValue !== undefined) {
              value = input.validator.parse(terminalValue);
              const reply = (value as { reply?: unknown } | null)?.reply;
              if (typeof reply === 'string' && reply) input.onEvent?.({ type: 'delta', text: reply });
              return { ...response, content: stringifyJson(value), toolCalls: [], usage };
            }
          }
        }
      }
      let lastError: unknown;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        input.signal?.throwIfAborted();
        if (attempt > 0) input.onEvent?.({ type: 'reset' });
        const replyStream = new JsonReplyStream((text) => input.onEvent?.({ type: 'delta', text }));
        const response = await complete({
          ...request, messages: [...messages], tools: undefined, toolChoice: 'none',
        }, (text) => replyStream.write(text));
        usage = addUsage(usage, response.usage);
        input.signal?.throwIfAborted();
        try {
          value = input.validator.parse(JSON.parse(response.content));
        } catch (error) { lastError = error; continue; }
        const reply = (value as { reply?: unknown } | null)?.reply;
        if (input.onEvent && typeof reply === 'string' && reply !== replyStream.text) {
          input.onEvent({ type: 'reset' });
          if (reply) input.onEvent({ type: 'delta', text: reply });
        }
        return { ...response, usage };
      }
      throw new BadGatewayException(`AI returned invalid chat output after one retry: ${lastError instanceof Error ? lastError.message : String(lastError)}`, { cause: lastError });
    }, onRunStarted);
    return { runId, value: value as T };
  }

  async completeText(input: PromptRunInput): Promise<{ runId: string; result: CompletionResult }> {
    return this.execute(input, (request) => this.gateway.complete(request));
  }

  async completeJson<T>(
    input: PromptRunInput & { validator: ZodType<T> },
  ): Promise<{ runId: string; value: T }> {
    let value: T | undefined;
    const { runId } = await this.execute(input, async (request) => {
      let lastError: unknown;
      let usage: CompletionUsage = {};
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const result = await this.gateway.complete(request);
        usage = addUsage(usage, result.usage);
        try {
          const parsed: unknown = JSON.parse(result.content);
          value = input.validator.parse(parsed);
          return { ...result, usage };
        } catch (error) {
          lastError = error;
        }
      }
      throw new BadGatewayException(
        `AI returned invalid structured output for ${input.task} after one retry: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
        { cause: lastError },
      );
    });
    return { runId, value: value as T };
  }

  async streamText(
    input: PromptRunInput,
    onDelta: (text: string) => void,
    onRunStarted?: (runId: string) => void,
  ): Promise<{ runId: string; result: CompletionResult }> {
    return this.execute(input, (request) => this.gateway.streamText(request, onDelta), onRunStarted);
  }

  private async execute(
    input: PromptRunInput,
    invoke: (request: Parameters<OpenRouterGateway['complete']>[0]) => Promise<CompletionResult>,
    onRunStarted?: (runId: string) => void,
  ): Promise<{ runId: string; result: CompletionResult }> {
    const startedAt = Date.now();
    const referenceSearchEnabled = this.tavily.isConfigured()
      && REFERENCE_PROMPT_IDS.has(input.promptId)
      && !input.tools?.length
      && input.toolChoice !== 'none';
    const rendered = this.prompts.render(input.promptId as PromptId, input.variables, {
      includeCore: input.includeCore,
      includeMemoryContract: input.includeMemoryContract,
      includeReferenceTools: referenceSearchEnabled || input.includeReferenceTools,
    });
    const researchPrompt = referenceSearchEnabled
      ? this.prompts.render('reference-research', {
          task_context: { system: rendered.system, user: rendered.user },
        }, { includeCore: false, includeMemoryContract: false, includeReferenceTools: true })
      : undefined;
    const promptRefs = [...rendered.refs];
    for (const ref of researchPrompt?.refs ?? []) {
      if (!promptRefs.some((existing) => existing.id === ref.id)) promptRefs.push(ref);
    }
    const model =
      input.modelRole === 'IMAGE_TAG' ? this.imageTagModel()
        : input.modelRole === 'CHAT' ? this.chatModel()
          : input.modelRole === 'IMPROVEMENT' ? this.improvementModel() : this.writingModel();
    const runId = id();
    const createdAt = now();
    const memoryVariables = Object.fromEntries(
      MEMORY_VARIABLE_KEYS.filter((key) => key in input.variables).map((key) => [
        key,
        input.variables[key],
      ]),
    );
    this.database.orm.insert(aiRuns).values({
      id: runId,
      task: input.task,
      projectId: input.projectId ?? null,
      episodeId: input.episodeId ?? null,
      model,
      promptRefsJson: stringifyJson(promptRefs),
      contextHash: sha256(`${rendered.system}\n${rendered.user}${input.history ? `\n${stringifyJson(input.history)}` : ''}${researchPrompt ? `\n${researchPrompt.system}\n${researchPrompt.user}` : ''}`),
      memoryRevisionHash: sha256(stableJson(memoryVariables)),
      inputTokens: null,
      outputTokens: null,
      latencyMs: null,
      status: 'RUNNING',
      error: null,
      createdAt,
      completedAt: null,
    }).run();
    onRunStarted?.(runId);
    try {
      const research = researchPrompt
        ? await this.researchReferences({
            model,
            messages: [
              { role: 'system', content: researchPrompt.system },
              { role: 'user', content: researchPrompt.user },
            ],
            tools: [tavilySearchTool],
            toolChoice: 'auto',
            temperature: 0.2,
            maxTokens: 1_500,
            signal: input.signal,
          })
        : { references: [], usage: {} };
      input.signal?.throwIfAborted();
      const messages: ChatMessage[] = [
        { role: 'system', content: rendered.system },
        { role: 'user', content: rendered.user },
        ...(input.history ?? []),
      ];
      if (research.references.length > 0) {
        messages.push({
          role: 'user',
          content: stringifyJson({ tavily_references: research.references }),
        });
      }
      // Research completes before final generation so tool narration cannot
      // enter the editor stream or interfere with strict JSON validation.
      const completion = await invoke({
        model,
        messages,
        schema: input.schema,
        tools: input.tools,
        toolChoice: input.toolChoice,
        temperature: input.temperature,
        maxTokens: input.maxTokens,
        signal: input.signal,
      });
      const result = { ...completion, usage: addUsage(research.usage, completion.usage) };
      this.database.orm
        .update(aiRuns)
        .set({
          status: 'SUCCEEDED',
          model: result.model,
          inputTokens: result.usage.promptTokens ?? null,
          outputTokens: result.usage.completionTokens ?? null,
          latencyMs: Date.now() - startedAt,
          completedAt: now(),
        })
        .where(eq(aiRuns.id, runId))
        .run();
      return { runId, result };
    } catch (error) {
      const context = {
        runId: sanitizeLogText(runId), task: sanitizeLogText(input.task), model: sanitizeLogText(model),
        projectId: input.projectId === undefined ? null : sanitizeLogText(input.projectId),
        episodeId: input.episodeId === undefined ? null : sanitizeLogText(input.episodeId),
      };
      this.logger.error({ event: 'ai_run_failed', ...context,
        elapsedMs: Date.now() - startedAt, error: serializeError(error) });
      try {
        this.database.orm
          .update(aiRuns)
          .set({
            status: input.signal?.aborted ? 'CANCELLED' : 'FAILED',
            error: error instanceof Error ? error.message.slice(0, 2_000) : String(error),
            latencyMs: Date.now() - startedAt,
            completedAt: now(),
          })
          .where(eq(aiRuns.id, runId))
          .run();
      } catch (persistenceError) {
        this.logger.error({ event: 'ai_run_failure_status_write_failed', ...context,
          elapsedMs: Date.now() - startedAt, error: serializeError(persistenceError) });
      }
      throw error;
    }
  }

  private async researchReferences(
    request: CompletionRequest,
  ): Promise<{ references: ReferenceSearchResult[]; usage: CompletionUsage }> {
    const messages = [...request.messages];
    const references: ReferenceSearchResult[] = [];
    let usage: CompletionUsage = {};
    let searchCount = 0;
    for (let round = 0; round < MAX_REFERENCE_SEARCHES; round += 1) {
      request.signal?.throwIfAborted();
      const result = await this.gateway.complete({ ...request, messages: [...messages] });
      usage = addUsage(usage, result.usage);
      if (result.toolCalls.length === 0) break;
      messages.push(result.assistantMessage ?? {
        role: 'assistant',
        content: result.content || null,
        tool_calls: result.toolCalls,
      });
      for (const call of result.toolCalls) {
        request.signal?.throwIfAborted();
        let reference: ReferenceSearchResult;
        if (searchCount >= MAX_REFERENCE_SEARCHES) {
          reference = { results: [], error: { code: 'SEARCH_LIMIT_REACHED' } };
        } else if (call.function.name !== tavilySearchTool.function.name) {
          searchCount += 1;
          reference = { results: [], error: { code: 'UNKNOWN_TOOL' } };
        } else {
          searchCount += 1;
          reference = await this.tavily.search(call.function.arguments, request.signal);
        }
        references.push(reference);
        messages.push({ role: 'tool', tool_call_id: call.id, content: stringifyJson(reference) });
      }
      if (searchCount >= MAX_REFERENCE_SEARCHES) break;
    }
    return { references, usage };
  }
}
