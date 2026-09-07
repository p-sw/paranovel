import {
  BadGatewayException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import type {
  ChatMessage,
  CompletionRequest,
  CompletionResult,
  ToolCall,
} from './ai.types';

interface ToolCallDelta {
  [key: string]: unknown;
  index: number;
  id?: string;
  type?: 'function';
  function?: { name?: string; arguments?: string };
}

interface OpenRouterChoice {
  index?: number;
  message?: ChatMessage;
  delta?: Partial<Omit<ChatMessage, 'tool_calls'>> & { tool_calls?: ToolCallDelta[] };
  finish_reason?: string | null;
}

interface OpenRouterResponse {
  model?: string;
  choices?: OpenRouterChoice[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string };
}

@Injectable()
export class OpenRouterGateway {
  private readonly apiKey = process.env.OPENROUTER_API_KEY;
  private readonly baseUrl = (
    process.env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1'
  ).replace(/\/$/, '');

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const response = await this.requestWithRetry(request, false);
    const payload = (await response.json()) as OpenRouterResponse;
    if (!response.ok) this.throwUpstream(response.status, payload.error?.message);
    const message = payload.choices?.[0]?.message;
    if (!message) throw new BadGatewayException('OpenRouter returned no completion choice');
    return {
      content: message.content ?? '',
      toolCalls: message.tool_calls ?? [],
      usage: {
        promptTokens: payload.usage?.prompt_tokens,
        completionTokens: payload.usage?.completion_tokens,
      },
      model: payload.model ?? request.model,
      assistantMessage: { ...message, role: 'assistant', content: message.content ?? null },
    };
  }

  async streamText(
    request: CompletionRequest,
    onDelta: (text: string) => void,
  ): Promise<CompletionResult> {
    const response = await this.requestWithRetry(request, true);
    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as OpenRouterResponse;
      this.throwUpstream(response.status, payload.error?.message);
    }
    if (!response.body) throw new BadGatewayException('OpenRouter returned no stream body');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let eventData: string[] = [];
    let finished = false;
    let receivedChoice = false;
    let receivedFinish = false;
    let content = '';
    let model = request.model;
    let usage: CompletionResult['usage'] = {};
    const assistantMessage: ChatMessage = { role: 'assistant', content: null };
    const toolCallsByIndex = new Map<number, ToolCall>();
    const reasoningDetails: Array<Record<string, unknown>> = [];

    const consumeEvent = (): void => {
      request.signal?.throwIfAborted();
      const data = eventData.join('\n');
      eventData = [];
      if (!data || finished) return;
      if (data.trim() === '[DONE]') { finished = true; return; }
      const event = JSON.parse(data) as OpenRouterResponse;
      if (event.error) throw new BadGatewayException(event.error.message ?? 'OpenRouter stream failed');
      model = event.model ?? model;
      const choice = event.choices?.find((item) => (item.index ?? 0) === 0);
      if (choice) receivedChoice = true;
      if (choice?.finish_reason === 'error') throw new BadGatewayException('OpenRouter stream failed');
      if (choice?.finish_reason) receivedFinish = true;
      const delta = choice?.delta;
      if (delta?.content) {
        content += delta.content;
        onDelta(delta.content);
      }
      if (delta?.reasoning) assistantMessage.reasoning = (assistantMessage.reasoning ?? '') + delta.reasoning;
      for (const detail of delta?.reasoning_details ?? []) {
        if (!detail || typeof detail !== 'object') continue;
        const fragment = detail as Record<string, unknown>;
        const previous = [...reasoningDetails].reverse().find((item) =>
          (fragment.type === undefined || item.type === fragment.type)
          && (fragment.index !== undefined ? item.index === fragment.index
            : fragment.id !== undefined ? item.id === fragment.id : true));
        if (!previous) { reasoningDetails.push({ ...fragment }); continue; }
        for (const [key, value] of Object.entries(fragment)) {
          if (['text', 'summary', 'data', 'signature'].includes(key) && typeof value === 'string') {
            previous[key] = (typeof previous[key] === 'string' ? previous[key] : '') + value;
          } else if (value !== null && value !== undefined) previous[key] = value;
        }
      }
      for (const fragment of delta?.tool_calls ?? []) {
        if (!Number.isInteger(fragment.index) || fragment.index < 0) {
          throw new BadGatewayException('OpenRouter returned an invalid tool call index');
        }
        const call = toolCallsByIndex.get(fragment.index) ?? {
          id: '', type: 'function', function: { name: '', arguments: '' },
        };
        const { index: _index, id: _id, type: _type, function: _function, ...metadata } = fragment;
        Object.assign(call, metadata);
        call.id += fragment.id ?? '';
        call.function = {
          ...call.function, ...fragment.function,
          name: call.function.name + (fragment.function?.name ?? ''),
          arguments: call.function.arguments + (fragment.function?.arguments ?? ''),
        };
        toolCallsByIndex.set(fragment.index, call);
      }
      if (event.usage) {
        usage = {
          promptTokens: event.usage.prompt_tokens,
          completionTokens: event.usage.completion_tokens,
        };
      }
    };

    const consumeLine = (line: string): void => {
      if (!line) consumeEvent();
      else if (line.startsWith('data:')) eventData.push(line.slice(5).replace(/^ /, ''));
    };
    const abort = (): void => { void reader.cancel(request.signal?.reason).catch(() => undefined); };
    request.signal?.addEventListener('abort', abort, { once: true });
    try {
      while (!finished) {
        request.signal?.throwIfAborted();
        const { done, value } = await reader.read();
        request.signal?.throwIfAborted();
        buffer += decoder.decode(value, { stream: !done });
        let lineEnd: number;
        while ((lineEnd = buffer.search(/[\r\n]/)) !== -1) {
          // A CRLF delimiter can be split between transport chunks.
          if (!done && buffer[lineEnd] === '\r' && lineEnd === buffer.length - 1) break;
          const line = buffer.slice(0, lineEnd);
          const delimiterLength = buffer[lineEnd] === '\r' && buffer[lineEnd + 1] === '\n' ? 2 : 1;
          buffer = buffer.slice(lineEnd + delimiterLength);
          consumeLine(line);
        }
        if (done) {
          if (buffer) consumeLine(buffer);
          consumeEvent();
          break;
        }
      }
      if (!receivedChoice || (!finished && !receivedFinish)) {
        throw new BadGatewayException('OpenRouter stream ended before completion');
      }
      const toolCalls = [...toolCallsByIndex.entries()].sort(([left], [right]) => left - right).map(([, call]) => call);
      if (toolCalls.some((call) => !call.id || !call.function.name)) {
        throw new BadGatewayException('OpenRouter returned an incomplete tool call');
      }
      assistantMessage.content = content || null;
      if (toolCalls.length) assistantMessage.tool_calls = toolCalls;
      if (reasoningDetails.length) assistantMessage.reasoning_details = reasoningDetails;
      return { content, toolCalls, usage, model, assistantMessage };
    } finally {
      request.signal?.removeEventListener('abort', abort);
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }

  async embeddings(input: string[]): Promise<number[][]> {
    if (input.length === 0) return [];
    this.assertConfigured();
    const model =
      process.env.OPENROUTER_EMBEDDING_MODEL ?? 'openai/text-embedding-3-small';
    const dimensions = Number.parseInt(
      process.env.OPENROUTER_EMBEDDING_DIMENSIONS ?? '1536',
      10,
    );
    const response = await fetch(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ input, model, dimensions }),
    });
    const payload = (await response.json().catch(() => ({}))) as {
      data?: Array<{ index: number; embedding: number[] }>;
      error?: { message?: string };
    };
    if (!response.ok) this.throwUpstream(response.status, payload.error?.message);
    const ordered = [...(payload.data ?? [])].sort((a, b) => a.index - b.index);
    if (ordered.length !== input.length) {
      throw new BadGatewayException('OpenRouter returned an incomplete embeddings response');
    }
    return ordered.map((item) => item.embedding);
  }

  private async requestWithRetry(
    request: CompletionRequest,
    stream: boolean,
  ): Promise<Response> {
    this.assertConfigured();
    const body: Record<string, unknown> = {
      model: request.model,
      messages: request.messages,
      stream,
      temperature: request.temperature,
      max_tokens: request.maxTokens,
    };
    if (stream) body.stream_options = { include_usage: true };
    if (request.schema) {
      body.response_format = {
        type: 'json_schema',
        json_schema: {
          name: request.schema.name,
          strict: true,
          schema: request.schema.value,
        },
      };
      body.provider = { require_parameters: true };
    }
    if (request.tools) {
      body.tools = request.tools;
      body.tool_choice = request.toolChoice ?? 'required';
      body.parallel_tool_calls = true;
      body.provider = { require_parameters: true };
    }

    let last: Response | undefined;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      last = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: request.signal,
      });
      if (![429, 500, 502, 503, 529].includes(last.status) || attempt === 2) return last;
      await last.body?.cancel();
      await new Promise<void>((resolve, reject) => {
        request.signal?.throwIfAborted();
        const abort = (): void => {
          clearTimeout(timeout);
          reject(request.signal?.reason ?? new DOMException('Aborted', 'AbortError'));
        };
        const timeout = setTimeout(() => {
          request.signal?.removeEventListener('abort', abort);
          resolve();
        }, 250 * 2 ** attempt);
        request.signal?.addEventListener('abort', abort, { once: true });
      });
    }
    return last!;
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': process.env.APP_URL ?? 'http://localhost:3000',
      'X-Title': 'Paranovel',
    };
  }

  private assertConfigured(): void {
    if (!this.apiKey) {
      throw new ServiceUnavailableException('OPENROUTER_API_KEY is not configured');
    }
  }

  private throwUpstream(status: number, message?: string): never {
    if (status === 401 || status === 402 || status === 429) {
      throw new ServiceUnavailableException(
        message ?? `OpenRouter is unavailable (${status})`,
      );
    }
    throw new BadGatewayException(message ?? `OpenRouter request failed (${status})`);
  }
}
