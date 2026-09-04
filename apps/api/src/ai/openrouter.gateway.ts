import {
  BadGatewayException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import type {
  CompletionRequest,
  CompletionResult,
  ToolCall,
} from './ai.types';

interface OpenRouterChoice {
  message?: { content?: string | null; tool_calls?: ToolCall[] };
  delta?: { content?: string | null };
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
    let content = '';
    let model = request.model;
    let usage: CompletionResult['usage'] = {};

    const consume = (line: string): void => {
      if (!line.startsWith('data:')) return;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') return;
      const event = JSON.parse(data) as OpenRouterResponse;
      if (event.error) throw new BadGatewayException(event.error.message ?? 'OpenRouter stream failed');
      model = event.model ?? model;
      const delta = event.choices?.[0]?.delta?.content ?? '';
      if (delta) {
        content += delta;
        onDelta(delta);
      }
      if (event.usage) {
        usage = {
          promptTokens: event.usage.prompt_tokens,
          completionTokens: event.usage.completion_tokens,
        };
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) consume(line.trimEnd());
      if (done) break;
    }
    if (buffer.trim()) consume(buffer.trim());
    return { content, toolCalls: [], usage, model };
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
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(resolve, 250 * 2 ** attempt);
        request.signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timeout);
            reject(request.signal?.reason ?? new DOMException('Aborted', 'AbortError'));
          },
          { once: true },
        );
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
