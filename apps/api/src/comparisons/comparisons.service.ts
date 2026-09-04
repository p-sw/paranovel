import { BadRequestException, Injectable } from '@nestjs/common';
import { AiRunnerService } from '../ai/ai-runner.service';
import type { StreamEvent } from '../episodes/episodes.service';
import { ImprovementsService } from '../improvements/improvements.service';
import { requireString, stringifyJson } from '../shared/utils';

@Injectable()
export class ComparisonsService {
  constructor(
    private readonly ai: AiRunnerService,
    private readonly improvements: ImprovementsService,
  ) {}

  async generate(
    body: unknown,
    emit: (event: StreamEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const input = (body ?? {}) as Record<string, unknown>;
    const unexpected = Object.keys(input).filter(
      (key) => key !== 'brief' && key !== 'targetChars',
    );
    if (unexpected.length > 0) {
      throw new BadRequestException(
        `Comparison generation only accepts brief and targetChars; unexpected: ${unexpected.join(', ')}`,
      );
    }
    const brief = requireString(input.brief, 'brief', { max: 30_000 });
    const rawTarget = input.targetChars ?? 5_000;
    const targetChars = Number(rawTarget);
    if (!Number.isInteger(targetChars) || targetChars < 300 || targetChars > 100_000) {
      throw new BadRequestException('targetChars must be between 300 and 100000');
    }
    emit({ type: 'stage', stage: 'WRITING' });
    const globalImprovements = this.improvements.list();
    const generated = await this.ai.streamText(
      {
        task: 'comparison_draft',
        promptId: 'comparison-draft',
        variables: {
          direction_brief: brief,
          genre_tags: [],
          target_length: targetChars,
          global_improvements: stringifyJson(globalImprovements),
        },
        includeMemoryContract: false,
        maxTokens: 32_000,
        signal,
      },
      (text) => emit({ type: 'delta', text }),
      (runId) => emit({ type: 'meta', runId }),
    );
    emit({
      type: 'done',
      content: generated.result.content,
      blocked: false,
      issues: [],
    });
  }
}
