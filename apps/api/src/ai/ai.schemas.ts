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

export const projectBlueprintValidator = z
  .object({
    title: z.string().trim().min(1).max(200),
    logline: z.string().trim().min(1).max(2_000),
    genreTags: z.array(z.string().trim().min(1)).min(1),
    details: z.string().max(20_000),
    defaultTargetChars: z.number().int().min(500).max(30_000),
    targetEpisode: z.number().int().min(5).max(2_000),
    targetEpisodeSource: z.enum(['USER', 'AI']),
    canon: z.array(canonDraftValidator),
    arcs: z.array(z.object({
      title: z.string().trim().min(1).max(200),
      startEpisode: z.number().int().positive(),
      endEpisode: z.number().int().positive(),
      goal: z.string().trim().min(1).max(10_000),
      conflict: z.string().trim().min(1).max(10_000),
      reversalPlan: z.array(
        z.object({ episode: z.number().int().positive(), description: z.string().trim().min(1).max(10_000) }),
      ),
    })).min(1).max(100),
  })
  .superRefine((blueprint, context) => {
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
      arc.reversalPlan.forEach((beat, beatIndex) => {
        if (beat.episode < arc.startEpisode || beat.episode > arc.endEpisode) {
          context.addIssue({
            code: 'custom', message: 'Reversal episodes must be inside their arc', path: ['arcs', index, 'reversalPlan', beatIndex, 'episode'],
          });
        }
      });
    });
    if (blueprint.arcs.at(-1)?.endEpisode !== blueprint.targetEpisode) {
      context.addIssue({
        code: 'custom', message: 'The final arc must end at targetEpisode', path: ['targetEpisode'],
      });
    }
  });

export const arcPlanValidator = z
  .object({
    title: z.string().trim().min(1).max(200),
    startEpisodeNumber: z.number().int().positive(),
    endEpisodeNumber: z.number().int().positive(),
    goal: z.string().trim().min(1).max(10_000),
    conflict: z.string().trim().min(1).max(10_000),
    reversalPlan: z.array(
      z.object({ episode: z.number().int().positive(), description: z.string().trim().min(1).max(10_000) }),
    ),
    episodeDirections: z.array(
      z.object({
        episode: z.number().int().positive(),
        title: z.string().trim().min(1).max(200),
        direction: z.string().trim().min(1).max(20_000),
      }),
    ),
    conflicts: z.array(z.string()),
  })
  .superRefine((value, context) => {
      const span = value.endEpisodeNumber - value.startEpisodeNumber + 1;
      if (span < 5 || span > 20) {
        context.addIssue({ code: 'custom', message: 'Arc plan must span between 5 and 20 episodes' });
      }
      value.reversalPlan.forEach((beat, index) => {
        if (beat.episode < value.startEpisodeNumber || beat.episode > value.endEpisodeNumber) {
          context.addIssue({
            code: 'custom', message: 'Reversal episodes must be inside their arc', path: ['reversalPlan', index, 'episode'],
          });
        }
      });
      value.episodeDirections.forEach((direction, index) => {
        if (direction.episode < value.startEpisodeNumber || direction.episode > value.endEpisodeNumber) {
          context.addIssue({
            code: 'custom', message: 'Episode directions must be inside their arc', path: ['episodeDirections', index, 'episode'],
          });
        }
      });
    });

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

export const projectBlueprintSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: 'string', minLength: 1, maxLength: 200 },
    logline: { type: 'string', minLength: 1, maxLength: 2000 },
    genreTags: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },
    details: { type: 'string', maxLength: 20000 },
    defaultTargetChars: { type: 'integer', minimum: 500, maximum: 30000 },
    targetEpisode: { type: 'integer', minimum: 5, maximum: 2000 },
    targetEpisodeSource: { type: 'string', enum: ['USER', 'AI'] },
    canon: worldbuildingSchema.properties
      ? (worldbuildingSchema.properties as Record<string, unknown>).suggestions
      : { type: 'array' },
    arcs: {
      type: 'array',
      minItems: 1,
      maxItems: 100,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string', minLength: 1, maxLength: 200 },
          startEpisode: { type: 'integer', minimum: 1 },
          endEpisode: { type: 'integer', minimum: 1 },
          goal: { type: 'string', minLength: 1, maxLength: 10000 },
          conflict: { type: 'string', minLength: 1, maxLength: 10000 },
          reversalPlan: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                episode: { type: 'integer', minimum: 1 },
                description: { type: 'string', minLength: 1, maxLength: 10000 },
              },
              required: ['episode', 'description'],
            },
          },
        },
        required: ['title', 'startEpisode', 'endEpisode', 'goal', 'conflict', 'reversalPlan'],
      },
    },
  },
  required: [
    'title', 'logline', 'genreTags', 'details', 'defaultTargetChars',
    'targetEpisode', 'targetEpisodeSource', 'canon', 'arcs',
  ],
};

export const arcPlanSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: 'string', minLength: 1, maxLength: 200 },
    startEpisodeNumber: { type: 'integer', minimum: 1 },
    endEpisodeNumber: { type: 'integer', minimum: 1 },
    goal: { type: 'string', minLength: 1, maxLength: 10000 },
    conflict: { type: 'string', minLength: 1, maxLength: 10000 },
    reversalPlan: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          episode: { type: 'integer', minimum: 1 },
          description: { type: 'string', minLength: 1, maxLength: 10000 },
        },
        required: ['episode', 'description'],
      },
    },
    episodeDirections: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          episode: { type: 'integer', minimum: 1 },
          title: { type: 'string', minLength: 1, maxLength: 200 },
          direction: { type: 'string', minLength: 1, maxLength: 20000 },
        },
        required: ['episode', 'title', 'direction'],
      },
    },
    conflicts: stringArray,
  },
  required: [
    'title',
    'startEpisodeNumber',
    'endEpisodeNumber',
    'goal',
    'conflict',
    'reversalPlan',
    'episodeDirections',
    'conflicts',
  ],
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
