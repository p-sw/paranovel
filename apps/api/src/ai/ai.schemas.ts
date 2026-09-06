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
  name: z.string().min(1),
  aliases: z.array(z.string()),
  content: z.string().min(1),
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
      category: z.enum(['CANON', 'TIMELINE', 'CHARACTER', 'ARC', 'SCENE', 'FORESHADOWING', 'STYLE']),
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
    title: z.string().trim().min(1),
    logline: z.string().trim().min(1),
    genreTags: z.array(z.string().trim().min(1)).min(1),
    details: z.string(),
    defaultTargetChars: z.number().int().min(500).max(30_000),
    canon: z.array(canonDraftValidator),
    arc: z.object({
      title: z.string().trim().min(1),
      startEpisode: z.number().int().positive(),
      endEpisode: z.number().int().positive(),
      goal: z.string().trim().min(1),
      conflict: z.string().trim().min(1),
      reversalPlan: z.array(
        z.object({ episode: z.number().int().positive(), description: z.string().trim().min(1) }),
      ),
    }),
  })
  .refine(
    ({ arc }) => {
      const span = arc.endEpisode - arc.startEpisode + 1;
      return span >= 5 && span <= 20;
    },
    { message: 'Blueprint arc must span between 5 and 20 episodes', path: ['arc'] },
  );

export const arcPlanValidator = z
  .object({
    title: z.string().min(1),
    startEpisodeNumber: z.number().int().positive(),
    endEpisodeNumber: z.number().int().positive(),
    goal: z.string().min(1),
    conflict: z.string().min(1),
    reversalPlan: z.array(
      z.object({ episode: z.number().int().positive(), description: z.string().min(1) }),
    ),
    episodeDirections: z.array(
      z.object({
        episode: z.number().int().positive(),
        title: z.string().min(1),
        direction: z.string().min(1),
      }),
    ),
    conflicts: z.array(z.string()),
  })
  .refine(
    (value) => {
      const span = value.endEpisodeNumber - value.startEpisodeNumber + 1;
      return span >= 5 && span <= 20;
    },
    { message: 'Arc plan must span between 5 and 20 episodes' },
  );

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
            enum: ['CANON', 'TIMELINE', 'CHARACTER', 'ARC', 'SCENE', 'FORESHADOWING', 'STYLE'],
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
          name: { type: 'string' },
          aliases: stringArray,
          content: { type: 'string' },
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
          name: { type: 'string' },
          aliases: stringArray,
          content: { type: 'string' },
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
    title: { type: 'string' },
    logline: { type: 'string' },
    genreTags: stringArray,
    details: { type: 'string' },
    defaultTargetChars: { type: 'integer', minimum: 500, maximum: 30000 },
    canon: worldbuildingSchema.properties
      ? (worldbuildingSchema.properties as Record<string, unknown>).suggestions
      : { type: 'array' },
    arc: {
      type: 'object',
      additionalProperties: false,
      properties: {
        title: { type: 'string' },
        startEpisode: { type: 'integer', minimum: 1 },
        endEpisode: { type: 'integer', minimum: 1 },
        goal: { type: 'string' },
        conflict: { type: 'string' },
        reversalPlan: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              episode: { type: 'integer', minimum: 1 },
              description: { type: 'string' },
            },
            required: ['episode', 'description'],
          },
        },
      },
      required: ['title', 'startEpisode', 'endEpisode', 'goal', 'conflict', 'reversalPlan'],
    },
  },
  required: ['title', 'logline', 'genreTags', 'details', 'defaultTargetChars', 'canon', 'arc'],
};

export const arcPlanSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: 'string' },
    startEpisodeNumber: { type: 'integer', minimum: 1 },
    endEpisodeNumber: { type: 'integer', minimum: 1 },
    goal: { type: 'string' },
    conflict: { type: 'string' },
    reversalPlan: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          episode: { type: 'integer', minimum: 1 },
          description: { type: 'string' },
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
          title: { type: 'string' },
          direction: { type: 'string' },
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
        },
        required: ['id', 'field', 'prompt', 'inputType', 'options', 'required'],
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
