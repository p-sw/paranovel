import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import type { ToolDefinition } from './ai.types';

const searchArguments = z.strictObject({
  query: z.string().trim().min(1).max(400),
  search_depth: z.enum(['basic', 'advanced']).default('basic'),
  max_results: z.number().int().min(1).max(5).default(5),
});

const searchResponse = z.object({
  results: z.array(z.object({
    title: z.string(),
    url: z.url().refine((url) => /^https?:\/\//i.test(url)),
    content: z.string(),
    score: z.number().optional(),
  })),
});

export const tavilySearchTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'tavily_search',
    description: 'Search the web with Tavily for factual references used in novel planning and writing.',
    strict: true,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 400 },
        search_depth: { type: 'string', enum: ['basic', 'advanced'] },
        max_results: { type: 'integer', minimum: 1, maximum: 5 },
      },
      required: ['query', 'search_depth', 'max_results'],
    },
  },
};

export interface ReferenceSearchResult {
  query?: string;
  results: Array<{ title: string; url: string; content: string; score?: number }>;
  error?: {
    code: 'NOT_CONFIGURED' | 'INVALID_ARGUMENTS' | 'UPSTREAM_ERROR' | 'INVALID_RESPONSE'
      | 'TIMEOUT' | 'NETWORK_ERROR' | 'SEARCH_LIMIT_REACHED' | 'UNKNOWN_TOOL';
    status?: number;
  };
}

@Injectable()
export class TavilySearchService {
  private readonly apiKey = process.env.TAVILY_API_KEY?.trim();

  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  async search(argumentsJson: string, signal?: AbortSignal): Promise<ReferenceSearchResult> {
    signal?.throwIfAborted();
    if (!this.isConfigured()) return { results: [], error: { code: 'NOT_CONFIGURED' } };

    let rawArguments: unknown;
    try {
      rawArguments = JSON.parse(argumentsJson);
    } catch {
      return { results: [], error: { code: 'INVALID_ARGUMENTS' } };
    }
    const parsed = searchArguments.safeParse(rawArguments);
    if (!parsed.success) return { results: [], error: { code: 'INVALID_ARGUMENTS' } };
    const args = parsed.data;
    const timeout = AbortSignal.timeout(15_000);

    try {
      const response = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          ...args,
          topic: 'general',
          auto_parameters: false,
          include_answer: false,
          include_raw_content: false,
          include_images: false,
        }),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      if (!response.ok) {
        // Provider error bodies may echo credentials or request data.
        await response.body?.cancel();
        return { query: args.query, results: [], error: { code: 'UPSTREAM_ERROR', status: response.status } };
      }
      const payload = searchResponse.safeParse(await response.json());
      signal?.throwIfAborted();
      timeout.throwIfAborted();
      if (!payload.success) {
        return { query: args.query, results: [], error: { code: 'INVALID_RESPONSE' } };
      }
      return {
        query: args.query,
        results: payload.data.results.slice(0, args.max_results).map((result) => ({
          title: result.title.slice(0, 300),
          url: result.url,
          content: result.content.slice(0, 2_000),
          score: result.score,
        })),
      };
    } catch (error) {
      signal?.throwIfAborted();
      return {
        query: args.query,
        results: [],
        error: {
          code: timeout.aborted ? 'TIMEOUT'
            : error instanceof SyntaxError ? 'INVALID_RESPONSE' : 'NETWORK_ERROR',
        },
      };
    }
  }
}
