import {
  Injectable,
  InternalServerErrorException,
  OnModuleInit,
} from '@nestjs/common';
import matter from 'gray-matter';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, isAbsolute, resolve } from 'node:path';
import { interpolate, sha256 } from '../shared/utils';

export const REQUIRED_PROMPT_IDS = [
  'novelist-core',
  'memory-contract',
  'reference-tools',
  'reference-research',
  'project-interview',
  'project-blueprint',
  'worldbuilding-generate',
  'arc-plan',
  'episode-direction',
  'episode-draft',
  'episode-continue',
  'scene-extract',
  'episode-memory-extract',
  'continuity-review',
  'continuity-repair',
  'improvement-extract',
  'comparison-draft',
  'project-chat',
] as const;

export type PromptId = (typeof REQUIRED_PROMPT_IDS)[number];

export interface PromptDefinition {
  id: string;
  version: string;
  task: string;
  responseMode: 'text' | 'json' | 'tool';
  requiredVariables: string[];
  system: string;
  user: string;
  path: string;
  checksum: string;
  modifiedAtMs: number;
}

export interface RenderedPrompt {
  system: string;
  user: string;
  refs: Array<{ id: string; version: string; checksum: string }>;
}

function splitSections(content: string): { system: string; user: string } {
  const systemMarker = /^## System\s*$/m.exec(content);
  const userMarker = /^## User\s*$/m.exec(content);
  if (!systemMarker) {
    throw new Error('must contain a "## System" section');
  }
  const systemStart = systemMarker.index + systemMarker[0].length;
  const userStart = userMarker ? userMarker.index + userMarker[0].length : content.length;
  const systemEnd = userMarker?.index ?? content.length;
  return {
    system: content.slice(systemStart, systemEnd).trim(),
    user: userMarker ? content.slice(userStart).trim() : '',
  };
}

@Injectable()
export class PromptRegistryService implements OnModuleInit {
  private readonly cache = new Map<string, PromptDefinition>();
  readonly directory: string;

  constructor() {
    const configured = process.env.PROMPTS_DIR;
    const candidates = configured
      ? isAbsolute(configured)
        ? [configured]
        : [
            resolve(process.cwd(), configured),
            resolve(process.cwd(), '../..', configured),
            resolve(__dirname, '../../../../', configured),
          ]
      : [
          resolve(process.cwd(), 'prompts'),
          resolve(process.cwd(), '../..', 'prompts'),
          resolve(__dirname, '../../../../prompts'),
        ];
    this.directory = candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
  }

  onModuleInit(): void {
    this.validateAll();
  }

  validateAll(): void {
    if (!existsSync(this.directory)) {
      throw new InternalServerErrorException(
        `Prompt directory does not exist: ${this.directory}`,
      );
    }
    const promptFiles = readdirSync(this.directory).filter((file) => file.endsWith('.md'));
    const fileIds = new Set(promptFiles.map((file) => basename(file, '.md')));
    const missing = REQUIRED_PROMPT_IDS.filter((id) => !fileIds.has(id));
    if (missing.length > 0) {
      throw new InternalServerErrorException(
        `Missing required prompt files: ${missing.join(', ')}`,
      );
    }
    const declaredIds = new Set<string>();
    for (const file of promptFiles) {
      const prompt = this.load(basename(file, '.md'), true);
      if (declaredIds.has(prompt.id)) {
        throw new InternalServerErrorException(`Duplicate prompt id: ${prompt.id}`);
      }
      declaredIds.add(prompt.id);
    }
  }

  get(promptId: PromptId | string): PromptDefinition {
    return this.load(promptId, false);
  }

  render(
    taskPromptId: PromptId,
    variables: Record<string, unknown>,
    options: { includeCore?: boolean; includeMemoryContract?: boolean; includeReferenceTools?: boolean } = {},
  ): RenderedPrompt {
    const prompts: PromptDefinition[] = [];
    if (options.includeCore !== false && taskPromptId !== 'novelist-core') {
      prompts.push(this.get('novelist-core'));
    }
    if (
      options.includeMemoryContract !== false &&
      !['novelist-core', 'memory-contract', 'project-interview', 'project-blueprint'].includes(
        taskPromptId,
      )
    ) {
      prompts.push(this.get('memory-contract'));
    }
    if (options.includeReferenceTools && taskPromptId !== 'reference-tools') {
      prompts.push(this.get('reference-tools'));
    }
    const task = this.get(taskPromptId);
    prompts.push(task);

    const missing = task.requiredVariables.filter((key) => !(key in variables));
    if (missing.length > 0) {
      throw new InternalServerErrorException(
        `Prompt ${task.id} is missing variables: ${missing.join(', ')}`,
      );
    }
    const system = prompts
      .map((prompt) => interpolate(prompt.system, variables))
      .filter(Boolean)
      .join('\n\n');
    const user = interpolate(task.user, variables);
    const unresolved = [...system.matchAll(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g), ...user.matchAll(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g)];
    if (unresolved.length > 0) {
      throw new InternalServerErrorException(
        `Prompt ${task.id} has unresolved variables: ${[...new Set(unresolved.map((match) => match[1]))].join(', ')}`,
      );
    }
    return {
      system,
      user,
      refs: prompts.map(({ id, version, checksum }) => ({ id, version, checksum })),
    };
  }

  private load(promptId: string, force: boolean): PromptDefinition {
    const path = resolve(this.directory, `${promptId}.md`);
    if (!existsSync(path)) {
      throw new InternalServerErrorException(`Prompt file not found: ${path}`);
    }
    const modifiedAtMs = statSync(path).mtimeMs;
    const cached = this.cache.get(promptId);
    if (!force && cached?.modifiedAtMs === modifiedAtMs) return cached;

    try {
      const raw = readFileSync(path, 'utf8');
      const parsed = matter(raw);
      const data = parsed.data as Record<string, unknown>;
      const sections = splitSections(parsed.content);
      const definition: PromptDefinition = {
        id: typeof data.id === 'string' ? data.id : '',
        version: String(data.version ?? ''),
        task: typeof data.task === 'string' ? data.task : '',
        responseMode:
          data.responseMode === 'json' || data.responseMode === 'tool'
            ? data.responseMode
            : data.responseMode === 'text'
              ? 'text'
              : (() => {
                  throw new Error('frontmatter responseMode must be text, json, or tool');
                })(),
        requiredVariables: Array.isArray(data.requiredVariables)
          ? data.requiredVariables.filter((value): value is string => typeof value === 'string')
          : [],
        ...sections,
        path,
        checksum: sha256(raw),
        modifiedAtMs,
      };
      if (definition.id !== promptId) {
        throw new Error(`frontmatter id must be "${promptId}"`);
      }
      if (!definition.version || !definition.task || !definition.system) {
        throw new Error('frontmatter version/task and System content are required');
      }
      if (!['novelist-core', 'memory-contract'].includes(promptId) && !definition.user) {
        throw new Error('task prompts must contain a non-empty "## User" section');
      }
      const templateVariables = [definition.system, definition.user]
        .flatMap((section) =>
          [...section.matchAll(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g)].map(
            (match) => match[1]!,
          ),
        );
      const uniqueTemplateVariables = new Set(templateVariables);
      const uniqueRequiredVariables = new Set(definition.requiredVariables);
      if (uniqueRequiredVariables.size !== definition.requiredVariables.length) {
        throw new Error('requiredVariables contains duplicates');
      }
      const undeclared = [...uniqueTemplateVariables].filter(
        (variable) => !uniqueRequiredVariables.has(variable),
      );
      const unused = definition.requiredVariables.filter(
        (variable) => !uniqueTemplateVariables.has(variable),
      );
      if (undeclared.length > 0 || unused.length > 0) {
        throw new Error(
          [
            undeclared.length ? `undeclared template variables: ${undeclared.join(', ')}` : '',
            unused.length ? `unused requiredVariables: ${unused.join(', ')}` : '',
          ]
            .filter(Boolean)
            .join('; '),
        );
      }
      this.cache.set(promptId, definition);
      return definition;
    } catch (error) {
      throw new InternalServerErrorException(
        `Invalid prompt ${path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
