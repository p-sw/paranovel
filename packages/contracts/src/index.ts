import { z } from 'zod';

export const idSchema = z.string().min(1);
export const isoDateSchema = z.string().datetime({ offset: true }).or(z.string().datetime());

export const canonCategorySchema = z.enum([
  'CHARACTER',
  'LOCATION',
  'ORGANIZATION',
  'ABILITY',
  'RULE',
  'TIMELINE',
  'OTHER',
]);
export type CanonCategory = z.infer<typeof canonCategorySchema>;

export const improvementScopeSchema = z.enum(['GLOBAL', 'PROJECT']);
export type ImprovementScope = z.infer<typeof improvementScopeSchema>;

export const projectSchema = z.object({
  id: idSchema,
  title: z.string().min(1),
  logline: z.string().min(1),
  genreTags: z.array(z.string().min(1)),
  details: z.string().optional(),
  defaultTargetChars: z.number().int().positive().default(5000),
  revision: z.number().int().positive(),
  nextEpisodeNumber: z.number().int().positive().optional(),
  episodeCount: z.number().int().nonnegative().optional(),
  lastEpisodeNumber: z.number().int().positive().nullable().optional(),
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema,
});
export type Project = z.infer<typeof projectSchema>;

export const setupQuestionSchema = z.object({
  id: z.string().min(1),
  prompt: z.string().min(1),
  inputType: z.enum(['text', 'long_text', 'single', 'multi']),
  options: z.array(z.string()).default([]),
  required: z.boolean(),
  field: z.string().optional(),
});
export type SetupQuestion = z.infer<typeof setupQuestionSchema>;

export const canonDraftSchema = z.object({
  category: canonCategorySchema,
  name: z.string().min(1),
  aliases: z.array(z.string()).default([]),
  content: z.string().min(1),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

export const arcBeatSchema = z.object({
  id: idSchema.optional(),
  episode: z.number().int().positive(),
  description: z.string().min(1),
});

export const arcDraftSchema = z.object({
  title: z.string().min(1),
  startEpisode: z.number().int().positive(),
  endEpisode: z.number().int().positive(),
  goal: z.string().min(1),
  conflict: z.string().min(1),
  reversalPlan: z.array(arcBeatSchema).default([]),
});

export const projectBlueprintSchema = z.object({
  title: z.string().min(1),
  logline: z.string().min(1),
  genreTags: z.array(z.string().min(1)).min(1),
  details: z.string().default(''),
  defaultTargetChars: z.number().int().min(500).max(30_000).default(5_000),
  canon: z.array(canonDraftSchema).default([]),
  arc: arcDraftSchema,
});
export type ProjectBlueprint = z.infer<typeof projectBlueprintSchema>;

export const projectSessionStepSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('question'), question: setupQuestionSchema }),
  z.object({ type: z.literal('ready'), blueprint: projectBlueprintSchema }),
]);
export type ProjectSessionStep = z.infer<typeof projectSessionStepSchema>;

export const episodeSummarySchema = z.object({
  events: z.array(z.string()).default([]),
  emotionalChanges: z
    .array(
      z.object({
        character: z.string(),
        from: z.string(),
        to: z.string(),
        cause: z.string(),
      }),
    )
    .default([]),
  newForeshadowing: z.array(z.string()).default([]),
  resolvedForeshadowing: z.array(z.string()).default([]),
  endScene: z
    .object({
      location: z.string().nullable().default(null),
      time: z.string().nullable().default(null),
      pointOfView: z.string().nullable().default(null),
      characters: z.array(z.string()).default([]),
      goal: z.string().nullable().default(null),
    })
    .optional(),
  sourceRevision: z.number().int().nonnegative(),
  stale: z.boolean(),
  updatedAt: isoDateSchema,
});
export type EpisodeSummary = z.infer<typeof episodeSummarySchema>;

export const episodeSchema = z.object({
  id: idSchema,
  projectId: idSchema,
  number: z.number().int().positive(),
  title: z.string().min(1),
  direction: z.string(),
  content: z.string(),
  revision: z.number().int().nonnegative(),
  status: z.enum(['DRAFT', 'CONFIRMED', 'MEMORY_STALE', 'NEEDS_REVIEW']),
  summary: episodeSummarySchema.nullable().optional(),
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema,
});
export type Episode = z.infer<typeof episodeSchema>;

export const canonEntrySchema = canonDraftSchema.extend({
  id: idSchema,
  projectId: idSchema,
  revision: z.number().int().nonnegative(),
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema,
});
export type CanonEntry = z.infer<typeof canonEntrySchema>;

export const canonCandidateSchema = canonDraftSchema.extend({
  id: idSchema,
  projectId: idSchema,
  sourceEpisodeId: idSchema.nullable(),
  status: z.enum(['PENDING', 'ACCEPTED', 'REJECTED']),
});
export type CanonCandidate = z.infer<typeof canonCandidateSchema>;

export const arcSchema = arcDraftSchema.extend({
  id: idSchema,
  projectId: idSchema,
  status: z.enum(['PLANNED', 'ACTIVE', 'COMPLETE', 'ARCHIVED']),
  revision: z.number().int().positive(),
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema,
});
export type Arc = z.infer<typeof arcSchema>;

export const sceneStateSchema = z.object({
  episodeId: idSchema,
  location: z.string().nullable(),
  time: z.string().nullable(),
  pointOfView: z.string().nullable(),
  characters: z.array(z.string()),
  goal: z.string().nullable(),
  sourceRevision: z.number().int().nonnegative(),
});
export type SceneState = z.infer<typeof sceneStateSchema>;

export const improvementCandidateSchema = z.object({
  title: z.string().min(1),
  rule: z.string().min(1),
  rationale: z.string().min(1),
  category: z.string().default('STYLE'),
  tags: z.array(z.string()).default([]),
  beforeExample: z.string().optional(),
  afterExample: z.string().optional(),
  confidence: z.number().min(0).max(1).default(0.5),
  duplicateOfId: idSchema.nullable().optional(),
  conflictsWithIds: z.array(idSchema).default([]),
});
export type ImprovementCandidate = z.infer<typeof improvementCandidateSchema>;

export const improvementSchema = improvementCandidateSchema.extend({
  id: idSchema,
  scope: improvementScopeSchema,
  projectId: idSchema.nullable(),
  source: z.enum(['EDITOR', 'COMPARISON', 'MANUAL']),
  active: z.boolean(),
  revision: z.number().int().positive(),
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema,
});
export type Improvement = z.infer<typeof improvementSchema>;

export const continuityIssueSchema = z.object({
  category: z.enum(['CANON', 'TIMELINE', 'CHARACTER', 'ARC', 'SCENE', 'FORESHADOWING', 'STYLE']),
  severity: z.enum(['WARNING', 'BLOCKING']),
  excerpt: z.string(),
  explanation: z.string(),
  evidenceRefs: z.array(z.string()).default([]),
  repairInstruction: z.string(),
});
export type ContinuityIssue = z.infer<typeof continuityIssueSchema>;

export const aiStreamEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('meta'), runId: idSchema, baseRevision: z.number().int().optional() }),
  z.object({ type: z.literal('stage'), stage: z.enum(['MEMORY', 'WRITING', 'CHECKING', 'REPAIRING']) }),
  z.object({ type: z.literal('delta'), text: z.string() }),
  z.object({ type: z.literal('reset') }),
  z.object({
    type: z.literal('done'),
    content: z.string(),
    blocked: z.boolean().default(false),
    issues: z.array(continuityIssueSchema).default([]),
    baseRevision: z.number().int().optional(),
  }),
  z.object({ type: z.literal('warning'), message: z.string() }),
  z.object({ type: z.literal('error'), code: z.string(), message: z.string() }),
]);
export type AiStreamEvent = z.infer<typeof aiStreamEventSchema>;

export const updateEpisodeSchema = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
    title: z.string().min(1).optional(),
    direction: z.string().optional(),
    content: z.string().optional(),
    forceNeedsReview: z.boolean().optional(),
  })
  .refine((value) => value.title !== undefined || value.direction !== undefined || value.content !== undefined, {
    message: '수정할 필드가 필요합니다.',
  });
export type UpdateEpisodeInput = z.infer<typeof updateEpisodeSchema>;

export const replaceSelectionSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
  selectedText: z.string().min(1),
  replacement: z.string(),
});
export type ReplaceSelectionInput = z.infer<typeof replaceSelectionSchema>;

export const improvementAnalysisInputSchema = z.object({
  source: z.enum(['EDITOR', 'COMPARISON']),
  projectId: idSchema.optional(),
  original: z.string().min(1),
  revised: z.string().min(1),
});
export type ImprovementAnalysisInput = z.infer<typeof improvementAnalysisInputSchema>;

export const apiErrorSchema = z.object({
  statusCode: z.number().int(),
  code: z.string(),
  message: z.union([z.string(), z.array(z.string())]),
  details: z.unknown().optional(),
  requestId: z.string().optional(),
});
export type ApiErrorBody = z.infer<typeof apiErrorSchema>;
