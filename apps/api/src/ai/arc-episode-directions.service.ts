import { Injectable } from '@nestjs/common';
import {
  arcEpisodeDirectionsSchema,
  arcEpisodeDirectionsValidatorForRange,
  type ArcEpisodeDirection,
  type ArcMilestone,
} from './ai.schemas';
import { AiRunnerService } from './ai-runner.service';

const MAX_CONCURRENCY = 4;

export interface ArcDirectionPlanInput {
  title: string;
  startEpisodeNumber: number;
  endEpisodeNumber: number;
  goal: string;
  conflict: string;
  milestones: ArcMilestone[];
}

export interface ArcEpisodeDirectionsInput {
  projectId?: string;
  projectContext: unknown;
  writingDirection: unknown;
  canon: unknown;
  surroundingArcs: unknown;
  arc: ArcDirectionPlanInput;
  generationRequest?: unknown;
  signal?: AbortSignal;
}

@Injectable()
export class ArcEpisodeDirectionsService {
  constructor(private readonly ai: AiRunnerService) {}

  async generate(input: ArcEpisodeDirectionsInput): Promise<ArcEpisodeDirection[]> {
    const { arc } = input;
    const { value } = await this.ai.completeJson({
      task: 'arc_episode_directions',
      promptId: 'arc-episode-directions',
      projectId: input.projectId,
      variables: {
        project_context: input.projectContext,
        writing_direction: input.writingDirection,
        canon: input.canon,
        surrounding_arcs: input.surroundingArcs,
        arc_milestones: arc,
        generation_request: input.generationRequest ?? '',
      },
      schema: { name: 'arc_episode_directions', value: arcEpisodeDirectionsSchema },
      validator: arcEpisodeDirectionsValidatorForRange(
        arc.startEpisodeNumber,
        arc.endEpisodeNumber,
      ),
      signal: input.signal,
      maxTokens: 16_000,
    });
    return value.episodeDirections;
  }

  async generateMany(inputs: ArcEpisodeDirectionsInput[]): Promise<ArcEpisodeDirection[][]> {
    if (inputs.length === 0) return [];
    const results = new Array<ArcEpisodeDirection[]>(inputs.length);
    let cursor = 0;
    const worker = async () => {
      while (cursor < inputs.length) {
        const index = cursor;
        cursor += 1;
        results[index] = await this.generate(inputs[index]!);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(MAX_CONCURRENCY, inputs.length) }, () => worker()),
    );
    return results;
  }
}
