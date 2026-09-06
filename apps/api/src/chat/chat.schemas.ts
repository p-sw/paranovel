import { z } from 'zod';

export const chatKindValidator = z.enum(['PROJECT', 'CANON', 'ARC', 'IMPROVEMENT']);
export type ChatKind = z.infer<typeof chatKindValidator>;
export const chatOperationValidator = z.enum(['CREATE', 'UPDATE', 'DELETE']);
export type ChatOperation = z.infer<typeof chatOperationValidator>;

export const chatOutputValidator = z.strictObject({
  reply: z.string().trim().min(1).max(40_000),
  proposals: z.array(z.strictObject({
    kind: chatKindValidator,
    operation: chatOperationValidator,
    targetId: z.string().min(1).nullable(),
    title: z.string().trim().min(1).max(200),
    changesJson: z.string().max(100_000),
  })).max(12),
});
export type ChatOutput = z.infer<typeof chatOutputValidator>;
const { $schema: _, ...outputSchema } = z.toJSONSchema(chatOutputValidator);
export const chatOutputSchema = outputSchema;

const short = z.string().trim().min(1).max(200);
export const editableValidators = {
  PROJECT: z.strictObject({
    title: short,
    logline: z.string().trim().min(1).max(2_000),
    genreTags: z.array(z.string().trim().min(1)).min(1),
    writingDirection: z.string().max(20_000),
    defaultTargetChars: z.number().int().min(500).max(30_000),
  }),
  CANON: z.strictObject({
    category: z.enum(['CHARACTER', 'CHARACTER_APPEARANCE', 'LOCATION', 'ORGANIZATION', 'ABILITY', 'RULE', 'TIMELINE', 'OTHER']),
    name: short,
    aliases: z.array(z.string()),
    content: z.string().trim().min(1).max(50_000),
    metadata: z.record(z.string(), z.unknown()),
    status: z.enum(['ACTIVE', 'PENDING', 'ACCEPTED', 'REJECTED']),
  }),
  ARC: z.strictObject({
    title: short,
    startEpisodeNumber: z.number().int().positive(),
    endEpisodeNumber: z.number().int().positive(),
    goal: z.string().trim().min(1).max(10_000),
    conflict: z.string().trim().min(1).max(10_000),
    reversalPlan: z.array(z.strictObject({
      id: z.string().optional(),
      episode: z.number().int().positive(),
      description: z.string().trim().min(1),
    })),
    status: z.enum(['PLANNED', 'ACTIVE', 'COMPLETE', 'ARCHIVED']),
  }),
  IMPROVEMENT: z.strictObject({
    title: short,
    rule: z.string().trim().min(1).max(5_000),
    rationale: z.string().max(5_000),
    category: z.string().trim().min(1).max(100),
    tags: z.array(z.string()),
    beforeExample: z.string().max(20_000),
    afterExample: z.string().max(20_000),
    active: z.boolean(),
  }),
};

export const creationDefaults: Record<ChatKind, Record<string, unknown>> = {
  PROJECT: {},
  CANON: { aliases: [], metadata: {}, status: 'ACTIVE' },
  ARC: { reversalPlan: [], status: 'PLANNED' },
  IMPROVEMENT: { rationale: '', category: 'STYLE', tags: [], beforeExample: '', afterExample: '', active: true },
};

export function editableFields(kind: ChatKind, value: Record<string, unknown>): Record<string, unknown> {
  const normalized = kind === 'PROJECT' && value.writingDirection === undefined && typeof value.details === 'string'
    ? { ...value, writingDirection: value.details }
    : value;
  return Object.fromEntries(Object.keys(editableValidators[kind].shape)
    .filter((key) => normalized[key] !== undefined).map((key) => [key, normalized[key]]));
}
