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
const arcMilestone = z.strictObject({
  id: z.string().trim().min(1).max(200).optional(),
  episode: z.number().int().positive(),
  type: z.enum(['GOAL', 'REVERSAL', 'ESCALATION', 'CLIMAX', 'RESOLUTION', 'OTHER']),
  description: z.string().min(1).max(10_000).regex(/\S/),
});
const arcEpisodeDirection = z.strictObject({
  episode: z.number().int().positive(),
  title: short,
  direction: z.string().trim().min(1).max(20_000),
});
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
    milestones: z.array(arcMilestone).min(1),
    episodeDirections: z.array(arcEpisodeDirection),
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
  ARC: { status: 'PLANNED' },
  IMPROVEMENT: { rationale: '', category: 'STYLE', tags: [], beforeExample: '', afterExample: '', active: true },
};

export function editableFields(kind: ChatKind, value: Record<string, unknown>): Record<string, unknown> {
  let normalized = kind === 'PROJECT' && value.writingDirection === undefined && typeof value.details === 'string'
    ? { ...value, writingDirection: value.details }
    : value;
  if (kind === 'ARC' && normalized.milestones === undefined && Array.isArray(normalized.reversalPlan)) {
    const milestones = normalized.reversalPlan.flatMap((raw) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
      const reversal = raw as Record<string, unknown>;
      if (!Number.isInteger(reversal.episode) || typeof reversal.description !== 'string') return [];
      return [{
        ...(typeof reversal.id === 'string' && reversal.id ? { id: reversal.id } : {}),
        episode: reversal.episode,
        type: 'REVERSAL',
        description: reversal.description,
      }];
    });
    if (
      milestones.length === 0
      && Number.isInteger(normalized.endEpisodeNumber ?? normalized.endEpisode)
      && typeof normalized.goal === 'string'
      && normalized.goal.trim()
    ) {
      milestones.push({
        episode: normalized.endEpisodeNumber ?? normalized.endEpisode,
        type: 'GOAL',
        description: normalized.goal,
      });
    }
    normalized = { ...normalized, milestones };
  }
  if (kind === 'ARC' && normalized.episodeDirections === undefined) {
    const start = normalized.startEpisodeNumber ?? normalized.startEpisode;
    const end = normalized.endEpisodeNumber ?? normalized.endEpisode;
    const title = normalized.title;
    const goal = normalized.goal;
    const milestones = normalized.milestones;
    if (
      Number.isInteger(start)
      && Number.isInteger(end)
      && Number(end) >= Number(start)
      && typeof title === 'string'
      && title.trim()
      && typeof goal === 'string'
      && goal.trim()
      && Array.isArray(milestones)
    ) {
      normalized = {
        ...normalized,
        episodeDirections: Array.from(
          { length: Number(end) - Number(start) + 1 },
          (_, index) => {
            const episode = Number(start) + index;
            const milestone = milestones.find((item) => (
              item && typeof item === 'object' && !Array.isArray(item)
              && (item as Record<string, unknown>).episode === episode
            )) as Record<string, unknown> | undefined;
            return {
              episode,
              title: `${episode}화`,
              direction: typeof milestone?.description === 'string'
                ? milestone.description
                : goal,
            };
          },
        ),
      };
    }
  }
  return Object.fromEntries(Object.keys(editableValidators[kind].shape)
    .filter((key) => normalized[key] !== undefined).map((key) => [key, normalized[key]]));
}
