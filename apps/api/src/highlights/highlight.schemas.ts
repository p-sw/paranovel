import { z } from 'zod';
import type { ToolDefinition } from '../ai/ai.types';

export const highlightPlanValidator = z.strictObject({
  afterParagraphId: z.number().int().positive(),
  altText: z.string().trim().min(1).max(1_000),
  prompt: z.string().trim().min(1).max(1_000),
  orientation: z.enum(['portrait', 'square', 'landscape']),
  allowNSFW: z.boolean(),
});
export type HighlightPlan = z.infer<typeof highlightPlanValidator>;

export const generateAnimeImageTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'generate_anime_image',
    description: 'Generate the episode’s single highlight illustration using approved appearance canon and place it after a supplied paragraph.',
    strict: true,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        afterParagraphId: { type: 'integer', minimum: 1 },
        altText: { type: 'string', minLength: 1, maxLength: 1_000 },
        prompt: { type: 'string', minLength: 1, maxLength: 1_000 },
        orientation: { type: 'string', enum: ['portrait', 'square', 'landscape'] },
        allowNSFW: { type: 'boolean' },
      },
      required: ['afterParagraphId', 'altText', 'prompt', 'orientation', 'allowNSFW'],
    },
  },
};

// Keep this tiny text-only boundary rule aligned with contracts/highlight.ts.
// The API is CommonJS; importing the web contracts' ESM runtime is unnecessary.
export function highlightParagraphs(content: string) {
  return Array.from(content.matchAll(/[^\r\n]+/g))
    .filter((match) => match[0].trim().length > 0)
    .map((match, index) => ({ id: index + 1, text: match[0], start: match.index!, end: match.index! + match[0].length }));
}
