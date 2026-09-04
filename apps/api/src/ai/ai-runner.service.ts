import { BadGatewayException, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service';
import { aiRuns } from '../database/schema';
import {
  PromptRegistryService,
  type PromptId,
} from '../prompts/prompt-registry.service';
import { id, now, sha256, stringifyJson } from '../shared/utils';
import type { CompletionResult, PromptRunInput } from './ai.types';
import { OpenRouterGateway } from './openrouter.gateway';
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
  ) {}

  writingModel(): string {
    return process.env.AI_WRITING_MODEL ?? 'google/gemini-3.8-flash';
  }

  improvementModel(): string {
    return process.env.AI_IMPROVEMENT_MODEL ?? 'openai/gpt-5.6-luna';
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
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const result = await this.gateway.complete(request);
        try {
          const parsed: unknown = JSON.parse(result.content);
          value = input.validator.parse(parsed);
          return result;
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
    const rendered = this.prompts.render(input.promptId as PromptId, input.variables, {
      includeCore: input.includeCore,
      includeMemoryContract: input.includeMemoryContract,
    });
    const model =
      input.modelRole === 'IMPROVEMENT' ? this.improvementModel() : this.writingModel();
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
      promptRefsJson: stringifyJson(rendered.refs),
      contextHash: sha256(`${rendered.system}\n${rendered.user}`),
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
      const result = await invoke({
        model,
        messages: [
          { role: 'system', content: rendered.system },
          { role: 'user', content: rendered.user },
        ],
        schema: input.schema,
        tools: input.tools,
        toolChoice: input.toolChoice,
        temperature: input.temperature,
        maxTokens: input.maxTokens,
        signal: input.signal,
      });
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
}
