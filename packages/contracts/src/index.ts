import { z } from 'zod';

export interface EditorAiInput {
  content: string;
  clientMessageId: string;
  expectedRevision: number;
  selection: { start: number; end: number; text: string };
}

export interface EditorAiEdit {
  title: string;
  start: number;
  end: number;
  original: string;
  replacement: string;
  baseRevision: number;
  status: 'PENDING' | 'APPLIED';
}

export interface EditorAiMessage {
  id: string;
  projectId: string;
  episodeId: string;
  clientMessageId: string;
  role: 'user' | 'assistant';
  content: string;
  status: 'PENDING' | 'COMPLETE' | 'FAILED';
  request: EditorAiInput | null;
  edit: EditorAiEdit | null;
  error: string | null;
  createdAt: string;
}

export interface EditorAiHistory { messages: EditorAiMessage[] }

export const idSchema = z.string().min(1);
export const isoDateSchema = z.string().datetime({ offset: true }).or(z.string().datetime());

export const canonCategorySchema = z.enum([
  'CHARACTER',
  'CHARACTER_APPEARANCE',
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

export const setupAnswerRecordSchema = z.object({
  question: setupQuestionSchema,
  answer: z.union([z.string(), z.array(z.string())]).nullable(),
  skipped: z.boolean(),
  otherAnswer: z.string().optional(),
});
export type SetupAnswerRecord = z.infer<typeof setupAnswerRecordSchema>;

export const setupAnswerRequestSchema = z.object({
  questionId: z.string().min(1),
  answer: z.union([z.string(), z.array(z.string())]).optional(),
  otherAnswer: z.string().trim().min(1).max(10_000).optional(),
  skipOptional: z.literal(true).optional(),
  position: z.number().int().nonnegative().optional(),
  expectedState: z.string().min(1).optional(),
});
export type SetupAnswerRequest = z.infer<typeof setupAnswerRequestSchema>;

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
  kind: z.enum(['MAIN', 'SIDE_STORY']).optional(),
  number: z.number().int().positive().nullable(),
  sideStoryGroupId: idSchema.nullable().optional(),
  branchFromEpisodeId: idSchema.nullable().optional(),
  title: z.string().min(1),
  direction: z.string(),
  content: z.string(),
  revision: z.number().int().nonnegative(),
  status: z.enum(['INCOMPLETE', 'DRAFT', 'CONFIRMED', 'MEMORY_STALE', 'NEEDS_REVIEW']),
  summary: episodeSummarySchema.nullable().optional(),
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema,
});
export type Episode = z.infer<typeof episodeSchema>;

export const episodeOrderSchema = z.object({
  episodes: z.array(episodeSchema),
  slots: z.array(idSchema.nullable()),
  revision: z.string().min(1),
});
export type EpisodeOrder = z.infer<typeof episodeOrderSchema>;

export const updateEpisodeOrderSchema = z.object({
  slots: z.array(idSchema.nullable()),
  expectedRevision: z.string().min(1),
}).strict();
export type UpdateEpisodeOrderInput = z.infer<typeof updateEpisodeOrderSchema>;

export const canonEntrySchema = canonDraftSchema.extend({
  id: idSchema,
  projectId: idSchema,
  sideStoryGroupId: idSchema.nullable().optional(),
  status: z.enum(['ACTIVE', 'PENDING', 'ACCEPTED', 'REJECTED']).optional(),
  sourceEpisodeId: idSchema.nullable().optional(),
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
  sideStoryGroupId: idSchema.nullable().optional(),
  status: z.enum(['PLANNED', 'ACTIVE', 'COMPLETE', 'ARCHIVED']),
  revision: z.number().int().positive(),
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema,
});
export type Arc = z.infer<typeof arcSchema>;

export const sideStoryGroupSchema = z.object({
  id: idSchema,
  projectId: idSchema,
  title: z.string().min(1),
  description: z.string(),
  branchFromEpisodeId: idSchema.nullable(),
  nextEpisodeNumber: z.number().int().positive(),
  revision: z.number().int().positive(),
  canon: z.array(canonEntrySchema),
  arc: arcSchema,
  episodes: z.array(episodeSchema).optional(),
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema,
});
export type SideStoryGroup = z.infer<typeof sideStoryGroupSchema>;

export const sideStoryCollectionSchema = z.object({
  standalone: z.array(episodeSchema),
  groups: z.array(sideStoryGroupSchema.extend({ episodes: z.array(episodeSchema) })),
});
export type SideStoryCollection = z.infer<typeof sideStoryCollectionSchema>;

export const sideStoryGroupSummarySchema = sideStoryGroupSchema.pick({
  id: true,
  projectId: true,
  title: true,
  description: true,
  branchFromEpisodeId: true,
  nextEpisodeNumber: true,
  revision: true,
  createdAt: true,
  updatedAt: true,
});
export type SideStoryGroupSummary = z.infer<typeof sideStoryGroupSummarySchema>;

export const episodeFlowSchema = z.object({
  kind: z.enum(['MAIN', 'SIDE_STORY']),
  label: z.string().min(1),
  group: sideStoryGroupSummarySchema.nullable(),
  episodes: z.array(episodeSchema),
});
export type EpisodeFlow = z.infer<typeof episodeFlowSchema>;

export const createSideStorySchema = z.object({
  title: z.string().trim().min(1).max(200),
  direction: z.string().max(20_000).optional(),
  content: z.string().max(1_000_000).optional(),
  incomplete: z.boolean().optional(),
  forceNeedsReview: z.boolean().optional(),
  groupId: idSchema.nullable(),
  branchFromEpisodeId: idSchema.nullable(),
}).strict()
  .refine((value) => !(value.groupId && value.branchFromEpisodeId), {
    message: '그룹 외전은 그룹의 분기 회차를 상속합니다.',
  })
  .refine((value) => !value.incomplete || !value.content?.trim(), {
    message: '본문이 있는 외전은 미완성으로 표시할 수 없습니다.',
  });
export type CreateSideStoryInput = z.infer<typeof createSideStorySchema>;

const sideStoryArcBeatSchema = z.object({
  id: z.string().trim().min(1).max(200).optional(),
  episode: z.number().int().positive(),
  description: z.string().trim().min(1).max(10_000),
}).strict();

export const createSideStoryGroupSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(20_000).optional(),
  branchFromEpisodeId: idSchema.nullable(),
  canon: z.string().trim().min(1).max(50_000),
  arc: z.object({
    title: z.string().trim().min(1).max(200),
    goal: z.string().trim().min(1).max(10_000),
    conflict: z.string().trim().min(1).max(10_000),
    endEpisodeNumber: z.number().int().positive().max(20).optional(),
    reversalPlan: z.array(sideStoryArcBeatSchema).optional(),
  }).strict().superRefine((arc, context) => {
    const endEpisodeNumber = arc.endEpisodeNumber ?? 5;
    arc.reversalPlan?.forEach((beat, index) => {
      if (beat.episode > endEpisodeNumber) {
        context.addIssue({
          code: 'custom',
          path: ['reversalPlan', index, 'episode'],
          message: '반전 회차는 외전 그룹 아크 범위 안이어야 합니다.',
        });
      }
    });
  }),
}).strict();
export type CreateSideStoryGroupInput = z.infer<typeof createSideStoryGroupSchema>;

export const updateSideStoryGroupSchema = z.object({
  expectedRevision: z.number().int().positive(),
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(20_000).optional(),
}).strict().refine(
  (value) => value.title !== undefined || value.description !== undefined,
  { message: 'At least one editable field is required' },
);
export type UpdateSideStoryGroupInput = z.infer<typeof updateSideStoryGroupSchema>;

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
  category: z.enum(['CANON', 'TIMELINE', 'SCENE']),
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
    incomplete: z.boolean().optional(),
    forceNeedsReview: z.boolean().optional(),
  })
  .refine((value) => value.title !== undefined || value.direction !== undefined || value.content !== undefined ||
    value.incomplete !== undefined || value.forceNeedsReview === true, {
    message: '수정할 필드가 필요합니다.',
  })
  .refine((value) => !value.incomplete || !value.content?.trim(), {
    message: '본문이 있는 회차는 미완성으로 표시할 수 없습니다.',
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


export const chatProposalSchema = z.object({
  id: idSchema,
  projectId: idSchema,
  messageId: idSchema,
  kind: z.enum(['PROJECT', 'CANON', 'ARC', 'IMPROVEMENT']),
  operation: z.enum(['CREATE', 'UPDATE', 'DELETE']),
  title: z.string(),
  targetId: idSchema.nullable(),
  before: z.record(z.string(), z.unknown()).nullable(),
  after: z.record(z.string(), z.unknown()).nullable(),
  effects: z.array(z.object({
    label: z.string(),
    before: z.record(z.string(), z.unknown()).nullable(),
    after: z.record(z.string(), z.unknown()).nullable(),
  })),
  status: z.enum(['PENDING', 'APPLIED']),
  createdAt: isoDateSchema,
  appliedAt: isoDateSchema.nullable(),
  result: z.record(z.string(), z.unknown()).nullable(),
});
export type ChatProposal = z.infer<typeof chatProposalSchema>;

export const chatMessageSchema = z.object({
  id: idSchema,
  projectId: idSchema,
  clientMessageId: idSchema,
  role: z.enum(['user', 'assistant']),
  content: z.string(),
  status: z.enum(['PENDING', 'COMPLETE', 'FAILED']),
  createdAt: isoDateSchema,
  proposals: z.array(chatProposalSchema),
  error: z.string().optional(),
});
export type ChatMessage = z.infer<typeof chatMessageSchema>;
export const chatThreadSchema = z.object({
  id: idSchema,
  projectId: idSchema,
  title: z.string(),
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema,
});
export type ChatThread = z.infer<typeof chatThreadSchema>;
export const chatThreadSummarySchema = chatThreadSchema.extend({
  preview: z.string(),
  messageCount: z.number().int().nonnegative(),
  status: z.enum(['PENDING', 'COMPLETE', 'FAILED']).nullable(),
});
export type ChatThreadSummary = z.infer<typeof chatThreadSummarySchema>;
export const chatHistorySchema = z.object({ thread: chatThreadSchema.nullable(), messages: z.array(chatMessageSchema) });
export type ChatHistory = z.infer<typeof chatHistorySchema>;
