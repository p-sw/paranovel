import type { JsonSchema, ToolDefinition } from './ai.types';
import { z } from 'zod';

const stringArray = { type: 'array', items: { type: 'string' } } as const;
const canonCategoryValidator = z.enum([
  'CHARACTER',
  'CHARACTER_APPEARANCE',
  'LOCATION',
  'ORGANIZATION',
  'ABILITY',
  'RULE',
  'TIMELINE',
  'OTHER',
]);
const canonDraftValidator = z.object({
  category: canonCategoryValidator,
  name: z.string().trim().min(1).max(200),
  aliases: z.array(z.string()),
  content: z.string().trim().min(1).max(50_000),
  metadata: z.record(z.string(), z.unknown()),
});

export const arcMilestoneTypeValidator = z.enum([
  'GOAL',
  'REVERSAL',
  'ESCALATION',
  'CLIMAX',
  'RESOLUTION',
  'OTHER',
]);

export const arcMilestoneValidator = z.object({
  id: z.string().trim().min(1).max(200).optional(),
  episode: z.number().int().positive(),
  type: arcMilestoneTypeValidator,
  description: z.string().min(1).max(10_000).regex(/\S/),
});

export const arcEpisodeDirectionValidator = z.object({
  episode: z.number().int().positive(),
  title: z.string().trim().min(1).max(200),
  direction: z.string().trim().min(1).max(20_000),
});

function validateMilestones(
  milestones: z.infer<typeof arcMilestoneValidator>[],
  start: number,
  end: number,
  context: z.RefinementCtx,
  path: PropertyKey[] = ['milestones'],
): void {
  milestones.forEach((milestone, index) => {
    if (milestone.episode < start || milestone.episode > end) {
      context.addIssue({
        code: 'custom',
        message: 'Milestone episodes must be inside their arc',
        path: [...path, index, 'episode'],
      });
    }
  });
}

function validateExactEpisodeDirections(
  directions: z.infer<typeof arcEpisodeDirectionValidator>[],
  start: number,
  end: number,
  context: z.RefinementCtx,
  path: PropertyKey[] = ['episodeDirections'],
): void {
  const expectedLength = end - start + 1;
  if (directions.length !== expectedLength) {
    context.addIssue({
      code: 'custom',
      message: `Episode directions must contain exactly ${expectedLength} entries`,
      path,
    });
  }
  directions.forEach((direction, index) => {
    const expectedEpisode = start + index;
    if (direction.episode !== expectedEpisode) {
      context.addIssue({
        code: 'custom',
        message: `Episode direction ${index + 1} must be for episode ${expectedEpisode}`,
        path: [...path, index, 'episode'],
      });
    }
  });
}

const projectBlueprintArcMilestonesValidator = z.object({
  title: z.string().trim().min(1).max(200),
  startEpisode: z.number().int().positive(),
  endEpisode: z.number().int().positive(),
  goal: z.string().trim().min(1).max(10_000),
  conflict: z.string().trim().min(1).max(10_000),
  milestones: z.array(arcMilestoneValidator).min(1),
});

const projectBlueprintBaseShape = {
  title: z.string().trim().min(1).max(200),
  logline: z.string().trim().min(1).max(2_000),
  genreTags: z.array(z.string().trim().min(1)).min(1),
  writingDirection: z.string().max(20_000),
  defaultTargetChars: z.number().int().min(500).max(30_000),
  targetEpisode: z.number().int().min(5).max(2_000),
  targetEpisodeSource: z.enum(['USER', 'AI']),
  canon: z.array(canonDraftValidator),
};

function validateBlueprintArcSequence(
  blueprint: {
    targetEpisode: number;
    arcs: Array<{
      startEpisode: number;
      endEpisode: number;
      milestones: z.infer<typeof arcMilestoneValidator>[];
      episodeDirections?: z.infer<typeof arcEpisodeDirectionValidator>[];
    }>;
  },
  context: z.RefinementCtx,
): void {
  blueprint.arcs.forEach((arc, index) => {
    const span = arc.endEpisode - arc.startEpisode + 1;
    if (span < 5 || span > 20) {
      context.addIssue({
        code: 'custom', message: 'Blueprint arcs must span between 5 and 20 episodes', path: ['arcs', index],
      });
    }
    const expectedStart = index === 0 ? 1 : blueprint.arcs[index - 1]!.endEpisode + 1;
    if (arc.startEpisode !== expectedStart) {
      context.addIssue({
        code: 'custom', message: 'Blueprint arcs must be contiguous from episode 1', path: ['arcs', index, 'startEpisode'],
      });
    }
    validateMilestones(arc.milestones, arc.startEpisode, arc.endEpisode, context, ['arcs', index, 'milestones']);
    if (arc.episodeDirections) {
      validateExactEpisodeDirections(
        arc.episodeDirections,
        arc.startEpisode,
        arc.endEpisode,
        context,
        ['arcs', index, 'episodeDirections'],
      );
    }
  });
  if (blueprint.arcs.at(-1)?.endEpisode !== blueprint.targetEpisode) {
    context.addIssue({
      code: 'custom', message: 'The final arc must end at targetEpisode', path: ['targetEpisode'],
    });
  }
}

export const episodeDirectionValidator = z.object({
  title: z.string().min(1).max(200).regex(/\S/),
  direction: z.string().min(1).max(20_000).regex(/\S/),
  conflicts: z.array(z.string()),
});

export const continuityReviewValidator = z.object({
  issues: z.array(
    z.object({
      category: z.enum(['CANON', 'TIMELINE', 'SCENE']),
      severity: z.enum(['WARNING', 'BLOCKING']),
      excerpt: z.string(),
      explanation: z.string(),
      evidenceRefs: z.array(z.string()),
      repairInstruction: z.string(),
    }),
  ),
});

export const improvementCandidatesValidator = z.object({
  candidates: z.array(
    z.object({
      title: z.string().min(1),
      rule: z.string().min(1),
      rationale: z.string(),
      category: z.string(),
      tags: z.array(z.string()),
      beforeExample: z.string(),
      afterExample: z.string(),
      confidence: z.number().min(0).max(1),
      duplicateOfId: z.string().nullable(),
      conflictsWithIds: z.array(z.string()),
    }),
  ),
});

export const sceneExtractionValidator = z.object({
  location: z.string().nullable(),
  time: z.string().nullable(),
  pointOfView: z.string().nullable(),
  characters: z.array(z.string()),
  goal: z.string().nullable(),
});

export const episodeMemoryValidator = z.object({
  events: z.array(z.string()),
  emotionalChanges: z.array(
    z.object({ character: z.string(), from: z.string(), to: z.string(), cause: z.string() }),
  ),
  newForeshadowing: z.array(z.string()),
  resolvedForeshadowing: z.array(z.string()),
  endScene: sceneExtractionValidator,
  canonCandidates: z.array(canonDraftValidator),
});

export const worldbuildingValidator = z.object({
  suggestions: z.array(canonDraftValidator),
  conflicts: z.array(z.string()),
});

export const projectBlueprintMilestonesValidator = z.object({
  ...projectBlueprintBaseShape,
  arcs: z.array(projectBlueprintArcMilestonesValidator).min(1).max(100),
}).superRefine(validateBlueprintArcSequence);

export const projectBlueprintValidator = z.object({
  ...projectBlueprintBaseShape,
  arcs: z.array(projectBlueprintArcMilestonesValidator.extend({
    episodeDirections: z.array(arcEpisodeDirectionValidator),
  })).min(1).max(100),
}).superRefine(validateBlueprintArcSequence);

const arcMilestonePlanShape = {
  title: z.string().trim().min(1).max(200),
  startEpisodeNumber: z.number().int().positive(),
  endEpisodeNumber: z.number().int().positive(),
  goal: z.string().trim().min(1).max(10_000),
  conflict: z.string().trim().min(1).max(10_000),
  milestones: z.array(arcMilestoneValidator).min(1),
  conflicts: z.array(z.string()),
};

export const arcMilestonePlanValidator = z.object(arcMilestonePlanShape)
  .superRefine((value, context) => {
    const span = value.endEpisodeNumber - value.startEpisodeNumber + 1;
    if (span < 5 || span > 20) {
      context.addIssue({ code: 'custom', message: 'Arc plan must span between 5 and 20 episodes' });
    }
    validateMilestones(value.milestones, value.startEpisodeNumber, value.endEpisodeNumber, context);
  });

export const arcPlanValidator = z.object({
  ...arcMilestonePlanShape,
  episodeDirections: z.array(arcEpisodeDirectionValidator),
}).superRefine((value, context) => {
  const span = value.endEpisodeNumber - value.startEpisodeNumber + 1;
  if (span < 5 || span > 20) {
    context.addIssue({ code: 'custom', message: 'Arc plan must span between 5 and 20 episodes' });
  }
  validateMilestones(value.milestones, value.startEpisodeNumber, value.endEpisodeNumber, context);
  validateExactEpisodeDirections(
    value.episodeDirections,
    value.startEpisodeNumber,
    value.endEpisodeNumber,
    context,
  );
});

const arcEpisodeDirectionsResultValidator = z.object({
  episodeDirections: z.array(arcEpisodeDirectionValidator),
});

export function arcEpisodeDirectionsValidatorForRange(start: number, end: number) {
  return arcEpisodeDirectionsResultValidator.superRefine((value, context) => {
    validateExactEpisodeDirections(value.episodeDirections, start, end, context);
  });
}

export type ArcMilestone = z.infer<typeof arcMilestoneValidator>;
export type ArcEpisodeDirection = z.infer<typeof arcEpisodeDirectionValidator>;
export type ProjectBlueprintMilestones = z.infer<typeof projectBlueprintMilestonesValidator>;
export type ProjectBlueprint = z.infer<typeof projectBlueprintValidator>;
export type ArcMilestonePlan = z.infer<typeof arcMilestonePlanValidator>;

export const episodeDirectionSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: 'string', minLength: 1, maxLength: 200 },
    direction: { type: 'string', minLength: 1, maxLength: 20_000 },
    conflicts: stringArray,
  },
  required: ['title', 'direction', 'conflicts'],
};

export const continuityReviewSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    issues: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          category: {
            type: 'string',
            enum: ['CANON', 'TIMELINE', 'SCENE'],
            description: 'CANON: 확정 설정 모순, TIMELINE: 실제 사건의 시간·시간대 모순, SCENE: 장소·공간 모순. 시점·시제·회상·문체·구성은 검사하지 않는다.',
          },
          severity: { type: 'string', enum: ['WARNING', 'BLOCKING'] },
          excerpt: { type: 'string' },
          explanation: { type: 'string' },
          evidenceRefs: stringArray,
          repairInstruction: { type: 'string' },
        },
        required: [
          'category',
          'severity',
          'excerpt',
          'explanation',
          'evidenceRefs',
          'repairInstruction',
        ],
      },
    },
  },
  required: ['issues'],
};

export const improvementCandidatesSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    candidates: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string' },
          rule: { type: 'string' },
          rationale: { type: 'string' },
          category: { type: 'string' },
          tags: stringArray,
          beforeExample: { type: 'string' },
          afterExample: { type: 'string' },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          duplicateOfId: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          conflictsWithIds: stringArray,
        },
        required: [
          'title',
          'rule',
          'rationale',
          'category',
          'tags',
          'beforeExample',
          'afterExample',
          'confidence',
          'duplicateOfId',
          'conflictsWithIds',
        ],
      },
    },
  },
  required: ['candidates'],
};

export const episodeMemorySchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    events: stringArray,
    emotionalChanges: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          character: { type: 'string' },
          from: { type: 'string' },
          to: { type: 'string' },
          cause: { type: 'string' },
        },
        required: ['character', 'from', 'to', 'cause'],
      },
    },
    newForeshadowing: stringArray,
    resolvedForeshadowing: stringArray,
    endScene: {
      type: 'object',
      additionalProperties: false,
      properties: {
        location: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        time: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        pointOfView: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        characters: stringArray,
        goal: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      },
      required: ['location', 'time', 'pointOfView', 'characters', 'goal'],
    },
    canonCandidates: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          category: {
            type: 'string',
            enum: ['CHARACTER', 'CHARACTER_APPEARANCE', 'LOCATION', 'ORGANIZATION', 'ABILITY', 'RULE', 'TIMELINE', 'OTHER'],
          },
          name: { type: 'string', minLength: 1, maxLength: 200 },
          aliases: stringArray,
          content: { type: 'string', minLength: 1, maxLength: 50000 },
          metadata: { type: 'object', additionalProperties: true },
        },
        required: ['category', 'name', 'aliases', 'content', 'metadata'],
      },
    },
  },
  required: [
    'events',
    'emotionalChanges',
    'newForeshadowing',
    'resolvedForeshadowing',
    'endScene',
    'canonCandidates',
  ],
};

export const sceneExtractionSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    location: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    time: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    pointOfView: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    characters: stringArray,
    goal: { anyOf: [{ type: 'string' }, { type: 'null' }] },
  },
  required: ['location', 'time', 'pointOfView', 'characters', 'goal'],
};

export const worldbuildingSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    suggestions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          category: {
            type: 'string',
            enum: ['CHARACTER', 'CHARACTER_APPEARANCE', 'LOCATION', 'ORGANIZATION', 'ABILITY', 'RULE', 'TIMELINE', 'OTHER'],
          },
          name: { type: 'string', minLength: 1, maxLength: 200 },
          aliases: stringArray,
          content: { type: 'string', minLength: 1, maxLength: 50000 },
          metadata: { type: 'object', additionalProperties: true },
        },
        required: ['category', 'name', 'aliases', 'content', 'metadata'],
      },
    },
    conflicts: stringArray,
  },
  required: ['suggestions', 'conflicts'],
};

const arcMilestoneJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', minLength: 1, maxLength: 200 },
    episode: { type: 'integer', minimum: 1 },
    type: { type: 'string', enum: ['GOAL', 'REVERSAL', 'ESCALATION', 'CLIMAX', 'RESOLUTION', 'OTHER'] },
    description: { type: 'string', minLength: 1, maxLength: 10000 },
  },
  required: ['episode', 'type', 'description'],
} as const;

const arcEpisodeDirectionJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    episode: { type: 'integer', minimum: 1 },
    title: { type: 'string', minLength: 1, maxLength: 200 },
    direction: { type: 'string', minLength: 1, maxLength: 20000 },
  },
  required: ['episode', 'title', 'direction'],
} as const;

const projectBlueprintProperties = {
  title: { type: 'string', minLength: 1, maxLength: 200 },
  logline: { type: 'string', minLength: 1, maxLength: 2000 },
  genreTags: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },
  writingDirection: {
    type: 'string',
    maxLength: 20_000,
    description: '시점, 시제, 문체, 분위기, 문장 호흡, 묘사와 대화 비중, 피할 표현처럼 모든 집필에 계속 적용할 지침',
  },
  defaultTargetChars: { type: 'integer', minimum: 500, maximum: 30000 },
  targetEpisode: { type: 'integer', minimum: 5, maximum: 2000 },
  targetEpisodeSource: { type: 'string', enum: ['USER', 'AI'] },
  canon: worldbuildingSchema.properties
    ? (worldbuildingSchema.properties as Record<string, unknown>).suggestions
    : { type: 'array' },
} as const;

const projectBlueprintArcMilestonesJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: 'string', minLength: 1, maxLength: 200 },
    startEpisode: { type: 'integer', minimum: 1 },
    endEpisode: { type: 'integer', minimum: 1 },
    goal: { type: 'string', minLength: 1, maxLength: 10000 },
    conflict: { type: 'string', minLength: 1, maxLength: 10000 },
    milestones: { type: 'array', minItems: 1, items: arcMilestoneJsonSchema },
  },
  required: ['title', 'startEpisode', 'endEpisode', 'goal', 'conflict', 'milestones'],
} as const;

export const projectBlueprintMilestonesSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ...projectBlueprintProperties,
    arcs: {
      type: 'array',
      minItems: 1,
      maxItems: 100,
      items: projectBlueprintArcMilestonesJsonSchema,
    },
  },
  required: [
    'title', 'logline', 'genreTags', 'writingDirection', 'defaultTargetChars',
    'targetEpisode', 'targetEpisodeSource', 'canon', 'arcs',
  ],
};

export const projectBlueprintSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ...projectBlueprintProperties,
    arcs: {
      type: 'array',
      minItems: 1,
      maxItems: 100,
      items: {
        ...projectBlueprintArcMilestonesJsonSchema,
        properties: {
          ...projectBlueprintArcMilestonesJsonSchema.properties,
          episodeDirections: { type: 'array', items: arcEpisodeDirectionJsonSchema },
        },
        required: [...projectBlueprintArcMilestonesJsonSchema.required, 'episodeDirections'],
      },
    },
  },
  required: [
    'title', 'logline', 'genreTags', 'writingDirection', 'defaultTargetChars',
    'targetEpisode', 'targetEpisodeSource', 'canon', 'arcs',
  ],
};

const arcMilestonePlanProperties = {
  title: { type: 'string', minLength: 1, maxLength: 200 },
  startEpisodeNumber: { type: 'integer', minimum: 1 },
  endEpisodeNumber: { type: 'integer', minimum: 1 },
  goal: { type: 'string', minLength: 1, maxLength: 10000 },
  conflict: { type: 'string', minLength: 1, maxLength: 10000 },
  milestones: { type: 'array', minItems: 1, items: arcMilestoneJsonSchema },
  conflicts: stringArray,
} as const;

const arcMilestonePlanRequired = [
  'title',
  'startEpisodeNumber',
  'endEpisodeNumber',
  'goal',
  'conflict',
  'milestones',
  'conflicts',
] as const;

export const arcMilestonePlanSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: arcMilestonePlanProperties,
  required: [...arcMilestonePlanRequired],
};

export const arcPlanSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ...arcMilestonePlanProperties,
    episodeDirections: {
      type: 'array',
      items: arcEpisodeDirectionJsonSchema,
    },
  },
  required: [...arcMilestonePlanRequired, 'episodeDirections'],
};

export const arcEpisodeDirectionsSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    episodeDirections: { type: 'array', items: arcEpisodeDirectionJsonSchema },
  },
  required: ['episodeDirections'],
};

export const projectInterviewTools: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'ask_project_details',
      description: 'Ask exactly one missing project question.',
      strict: true,
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          field: { type: 'string' },
          prompt: { type: 'string' },
          inputType: { type: 'string', enum: ['text', 'long_text', 'single', 'multi'] },
          options: stringArray,
          required: { type: 'boolean' },
          suggestedAnswer: { type: 'string', maxLength: 200 },
        },
        required: ['id', 'field', 'prompt', 'inputType', 'options', 'required', 'suggestedAnswer'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'complete_project_interview',
      description: 'Finish when enough user intent has been collected.',
      strict: true,
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          confirmedFacts: stringArray,
          assumptions: stringArray,
        },
        required: ['confirmedFacts', 'assumptions'],
      },
    },
  },
];
