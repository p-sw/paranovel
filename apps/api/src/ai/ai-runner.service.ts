import { BadGatewayException, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service';
import { aiRuns } from '../database/schema';
import {
  PromptRegistryService,
  type PromptId,
} from '../prompts/prompt-registry.service';
import { id, now, sha256, stringifyJson } from '../shared/utils';
import type {
  ChatMessage,
  CompletionRequest,
  CompletionResult,
  CompletionUsage,
  PromptRunInput,
  ToolDefinition,
} from './ai.types';
import { OpenRouterGateway } from './openrouter.gateway';
import {
  TavilySearchService,
  tavilySearchTool,
  type ReferenceSearchResult,
} from './tavily-search.service';
import type { ZodType } from 'zod';

const MEMORY_VARIABLE_KEYS = [
  'project_context',
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

@Injectable()
export class AiRunnerService {
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

  async completeChat<T>(
    input: PromptRunInput & {
      validator: ZodType<T>;
      readTools: ToolDefinition[];
      readTool: (name: string, argumentsJson: string) => Promise<unknown>;
    },
    onRunStarted?: (runId: string) => void,
  ): Promise<{ runId: string; value: T }> {
    let value: T | undefined;
    const { runId } = await this.execute({ ...input, modelRole: 'CHAT', includeReferenceTools: input.readTools.some((tool) => tool.function.name === tavilySearchTool.function.name) }, async (request) => {
      const messages = [...request.messages];
      let usage: CompletionUsage = {};
      let calls = 0;
      let referenceSearches = 0;
      let remainingCharacters = 60_000;
      for (let round = 0; round < 4 && calls < 8; round += 1) {
        input.signal?.throwIfAborted();
        const response = await this.gateway.complete({
          ...request, messages: [...messages], schema: undefined,
          tools: input.readTools, toolChoice: 'auto', maxTokens: 2_000,
        });
        usage = addUsage(usage, response.usage);
        if (!response.toolCalls.length) break;
        messages.push(response.assistantMessage ?? {
          role: 'assistant', content: response.content || null, tool_calls: response.toolCalls,
        });
        for (const call of response.toolCalls) {
          input.signal?.throwIfAborted();
          let result: unknown;
          if (calls >= 8 || remainingCharacters <= 0) {
            result = { error: 'READ_LIMIT_REACHED' };
          } else {
            calls += 1;
            if (call.function.name === tavilySearchTool.function.name && referenceSearches >= MAX_REFERENCE_SEARCHES) {
              result = { error: 'SEARCH_LIMIT_REACHED' };
            } else {
              if (call.function.name === tavilySearchTool.function.name) referenceSearches += 1;
              result = await input.readTool(call.function.name, call.function.arguments);
            }
          }
          let content = stringifyJson(result);
          if (content.length > remainingCharacters && remainingCharacters > 0) {
            content = stringifyJson({ truncated: true, excerpt: content.slice(0, Math.max(0, remainingCharacters - 100)) });
          }
          remainingCharacters = Math.max(0, remainingCharacters - content.length);
          messages.push({ role: 'tool', tool_call_id: call.id, content });
        }
      }
      let lastError: unknown;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const response = await this.gateway.complete({
          ...request, messages: [...messages], tools: undefined, toolChoice: 'none',
        });
        usage = addUsage(usage, response.usage);
        try {
          value = input.validator.parse(JSON.parse(response.content));
          return { ...response, usage };
        } catch (error) { lastError = error; }
      }
      throw new BadGatewayException(`AI returned invalid chat output after one retry: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
    }, onRunStarted);
    return { runId, value: value as T };
  }

  async completeText(input: PromptRunInput): Promise<{ runId: string; result: CompletionResult }> {
    return this.execute(input, (request) => this.gateway.complete(request));
  }

  async completeTool<T>(
    input: PromptRunInput & {
      tool: ToolDefinition;
      validator: ZodType<T>;
      validateValue?: (value: T) => boolean;
    },
  ): Promise<{ runId: string; value: T }> {
    let value: T | undefined;
    const { runId } = await this.execute({ ...input, tools: [input.tool], toolChoice: 'required' }, async (request) => {
      let usage: CompletionUsage = {};
      // Only planning is retried. The caller executes the paid image API once,
      // after tool name, schema and placement have all been validated.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        let result: CompletionResult;
        try { result = await this.gateway.complete(request); }
        catch { throw new BadGatewayException('이미지 장면 분석 요청을 처리하지 못했습니다.'); }
        usage = addUsage(usage, result.usage);
        const call = result.toolCalls.length === 1 ? result.toolCalls[0] : undefined;
        if (call?.function.name !== input.tool.function.name) continue;
        try {
          const parsed = input.validator.parse(JSON.parse(call.function.arguments));
          if (input.validateValue && !input.validateValue(parsed)) continue;
          value = parsed;
          return { ...result, usage };
        } catch { /* A malformed tool plan is safe to ask for once more. */ }
      }
      throw new BadGatewayException('AI가 올바른 이미지 생성 계획을 반환하지 못했습니다.');
    });
    return { runId, value: value as T };
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
      input.modelRole === 'CHAT' ? this.chatModel()
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
