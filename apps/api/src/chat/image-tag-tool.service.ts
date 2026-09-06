import { Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { AiRunnerService } from '../ai/ai-runner.service';
import type { ToolDefinition } from '../ai/ai.types';
import { CanonService } from '../canon/canon.service';
import { ProjectsService } from '../projects/projects.service';

export const IMAGE_TAG_TOOL_NAME = 'generate_image_tags';

export const imageTagArgumentsValidator = z.strictObject({
  characterAppearanceIds: z.array(z.string().trim().min(1).max(200)).max(6)
    .describe('Confirmed CHARACTER_APPEARANCE canon IDs for the people to depict. Use [] when no person is requested.'),
  locationId: z.string().trim().min(1).max(200).nullable()
    .describe('One confirmed LOCATION canon ID, or null when no place is requested.'),
  additionalDescription: z.string().trim().max(5_000)
    .describe('Transient visual direction from the user, such as pose, expression, action, weather, lighting, or composition. Use an empty string when omitted.'),
});

const imageTagValidator = z.string().trim().min(1).max(80)
  .regex(/^[a-z0-9]+(?:_[a-z0-9]+)*$/, 'Tags must use lowercase English words, numbers, and underscores only');
export const imageTagOutputValidator = z.strictObject({
  tags: z.array(imageTagValidator).min(1).max(80),
});
const { $schema: _outputMeta, ...imageTagOutputSchema } = z.toJSONSchema(imageTagOutputValidator);
const { $schema: _argumentMeta, ...imageTagArgumentSchema } = z.toJSONSchema(imageTagArgumentsValidator);

export const generateImageTagsTool: ToolDefinition = {
  type: 'function',
  function: {
    name: IMAGE_TAG_TOOL_NAME,
    description: 'Run the dedicated image-tag AI for a user request to turn confirmed character appearance and/or location canon plus optional scene direction into Danbooru-style tags. Resolve exact confirmed canon IDs first. Call this instead of writing tags yourself.',
    parameters: imageTagArgumentSchema,
    strict: true,
  },
};

export interface ImageTagToolResult {
  tags: string[];
  tagString: string;
  sourceCanonIds: string[];
}

export function isImageTagToolResult(value: unknown): value is ImageTagToolResult {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<ImageTagToolResult>;
  return Array.isArray(candidate.tags) && candidate.tags.every((tag) => typeof tag === 'string')
    && typeof candidate.tagString === 'string' && Array.isArray(candidate.sourceCanonIds)
    && candidate.sourceCanonIds.every((entryId) => typeof entryId === 'string');
}

type ToolFailureCode = 'INVALID_ARGUMENTS' | 'TARGET_REQUIRED' | 'CANON_NOT_FOUND'
  | 'CANON_NOT_CONFIRMED' | 'WRONG_CANON_CATEGORY' | 'CONTEXT_TOO_LARGE';

function failure(error: ToolFailureCode, message: string) {
  return { error, message } as const;
}

@Injectable()
export class ImageTagToolService {
  constructor(
    private readonly projects: ProjectsService,
    private readonly canon: CanonService,
    private readonly ai: AiRunnerService,
  ) {}

  async call(projectId: string, argumentsJson: string, signal?: AbortSignal): Promise<ImageTagToolResult | ReturnType<typeof failure>> {
    this.projects.get(projectId);
    signal?.throwIfAborted();
    let raw: unknown;
    try { raw = JSON.parse(argumentsJson); }
    catch { return failure('INVALID_ARGUMENTS', '이미지 태그 생성 도구의 인자를 올바른 JSON으로 다시 작성해 주세요.'); }
    const parsed = imageTagArgumentsValidator.safeParse(raw);
    if (!parsed.success) return failure('INVALID_ARGUMENTS', '인물 외형 ID, 장소 ID, 추가 설명을 도구 계약에 맞게 다시 지정해 주세요.');
    const characterIds = [...new Set(parsed.data.characterAppearanceIds)];
    if (!characterIds.length && parsed.data.locationId === null) {
      return failure('TARGET_REQUIRED', '태그를 만들 인물 외형이나 장소 정사를 하나 이상 지정해 주세요.');
    }

    const selected = [] as Array<ReturnType<CanonService['get']>>;
    const load = (entryId: string) => {
      let entry: ReturnType<CanonService['get']>;
      try { entry = this.canon.get(projectId, entryId); }
      catch (error) {
        if (error instanceof NotFoundException) return failure('CANON_NOT_FOUND', `현재 작품에서 정사 ID ${entryId}을(를) 찾지 못했습니다.`);
        throw error;
      }
      if (entry.status !== 'ACTIVE' && entry.status !== 'ACCEPTED') {
        return failure('CANON_NOT_CONFIRMED', `${entry.name}은(는) 아직 확정 정사가 아닙니다.`);
      }
      return entry;
    };
    for (const entryId of characterIds) {
      const entry = load(entryId);
      if ('error' in entry) return entry;
      if (entry.category !== 'CHARACTER_APPEARANCE') {
        return failure('WRONG_CANON_CATEGORY', `${entry.name}은(는) CHARACTER_APPEARANCE 정사가 아닙니다.`);
      }
      selected.push(entry);
    }
    if (parsed.data.locationId) {
      const entry = load(parsed.data.locationId);
      if ('error' in entry) return entry;
      if (entry.category !== 'LOCATION') return failure('WRONG_CANON_CATEGORY', `${entry.name}은(는) LOCATION 정사가 아닙니다.`);
      selected.push(entry);
    }

    const appearances = selected.filter((entry) => entry.category === 'CHARACTER_APPEARANCE')
      .map((entry) => ({ ref: `canon:${entry.id}`, category: entry.category, name: entry.name, aliases: entry.aliases, content: entry.content }));
    const location = selected.find((entry) => entry.category === 'LOCATION');
    const locationInput = location
      ? { ref: `canon:${location.id}`, category: location.category, name: location.name, aliases: location.aliases, content: location.content }
      : null;
    const canonInput = { characterAppearances: appearances, location: locationInput };
    const canonJson = JSON.stringify(canonInput);
    const contextCharacters = canonJson.length + parsed.data.additionalDescription.length;
    const configuredLimit = Number(process.env.AI_MANDATORY_CONTEXT_MAX_CHARS ?? 400_000);
    const contextLimit = Number.isFinite(configuredLimit) && configuredLimit > 0 ? configuredLimit : 400_000;
    if (contextCharacters > contextLimit) {
      return failure('CONTEXT_TOO_LARGE', '선택한 인물 외형과 장소 정사가 AI 문맥 한도를 초과했습니다. 대상을 줄여 주세요.');
    }

    const result = await this.ai.completeJson({
      task: 'image_tag_generation',
      promptId: 'image-tag-generation',
      projectId,
      modelRole: 'IMAGE_TAG',
      variables: {
        canon: canonJson,
        additional_description: parsed.data.additionalDescription,
      },
      schema: { name: 'image_tags', value: imageTagOutputSchema },
      validator: imageTagOutputValidator,
      includeCore: false,
      includeMemoryContract: false,
      maxTokens: 2_000,
      signal,
    });
    const validated = imageTagOutputValidator.parse(result.value);
    const tags = [...new Set(validated.tags)];
    return {
      tags,
      tagString: tags.join(', '),
      sourceCanonIds: selected.map((entry) => entry.id),
    };
  }
}
