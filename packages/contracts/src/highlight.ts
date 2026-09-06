import { z } from 'zod';

export const highlightImageSchema = z.object({
  id: z.string().min(1),
  url: z.string().min(1),
  altText: z.string(),
  generatedSourceRevision: z.number().int().positive(),
  generatedSourceContent: z.string(),
  anchorSourceContent: z.string(),
  anchorText: z.string().min(1),
  anchorOffset: z.number().int().nonnegative(),
  createdAt: z.string(),
});
export type HighlightImage = z.infer<typeof highlightImageSchema>;

export const highlightGenerationSchema = z.object({
  id: z.string().min(1),
  status: z.enum(['RUNNING', 'SUCCEEDED', 'FAILED']),
  error: z.string().nullable(),
  retryableDownload: z.boolean(),
  idempotencyKey: z.string().min(1),
  expectedRevision: z.number().int().positive(),
});
export type HighlightGeneration = z.infer<typeof highlightGenerationSchema>;

export const highlightStateSchema = z.object({
  configured: z.boolean(),
  image: highlightImageSchema.nullable(),
  generation: highlightGenerationSchema.nullable(),
});
export type HighlightState = z.infer<typeof highlightStateSchema>;

/** Textarea and String#slice offsets are UTF-16, including Korean and emoji. */
export function highlightParagraphs(content: string): Array<{ id: number; text: string; start: number; end: number }> {
  return Array.from(content.matchAll(/[^\r\n]+/g))
    .filter((match) => match[0].trim().length > 0)
    .map((match, index) => ({ id: index + 1, text: match[0], start: match.index!, end: match.index! + match[0].length }));
}

export function resolveHighlightAnchor(
  content: string,
  image: Pick<HighlightImage, 'anchorSourceContent' | 'anchorText' | 'anchorOffset'>,
): number | null {
  if (content === image.anchorSourceContent) return image.anchorOffset;
  const matches = highlightParagraphs(content).filter((paragraph) => paragraph.text === image.anchorText);
  return matches.length === 1 ? matches[0]!.end : null;
}
