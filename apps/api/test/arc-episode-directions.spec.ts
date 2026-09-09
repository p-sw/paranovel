import { describe, expect, it, vi } from 'vitest';
import {
  ArcEpisodeDirectionsService,
  type ArcEpisodeDirectionsInput,
} from '../src/ai/arc-episode-directions.service';

function input(index: number): ArcEpisodeDirectionsInput {
  const startEpisodeNumber = index * 5 + 1;
  const endEpisodeNumber = startEpisodeNumber + 4;
  return {
    projectId: 'project',
    projectContext: { title: '달의 문' },
    writingDirection: '3인칭 제한 시점',
    canon: [],
    surroundingArcs: [],
    arc: {
      title: `${index + 1}번 아크`,
      startEpisodeNumber,
      endEpisodeNumber,
      goal: '다음 문을 연다.',
      conflict: '수문장이 막는다.',
      milestones: [{
        episode: endEpisodeNumber,
        type: 'GOAL',
        description: '문을 연다.',
      }],
    },
  };
}

describe('ArcEpisodeDirectionsService', () => {
  it('keeps result order while limiting a batch to four concurrent generations', async () => {
    let active = 0;
    let maximumActive = 0;
    const releases: Array<() => void> = [];
    const completeJson = vi.fn((request) => new Promise((resolve) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      releases.push(() => {
        active -= 1;
        const arc = request.variables.arc_milestones;
        resolve({
          value: {
            episodeDirections: Array.from(
              { length: arc.endEpisodeNumber - arc.startEpisodeNumber + 1 },
              (_, offset) => ({
                episode: arc.startEpisodeNumber + offset,
                title: `${arc.title} ${offset + 1}화`,
                direction: '이전 사건의 결과를 받아 다음 마일스톤으로 전진한다.',
              }),
            ),
          },
        });
      });
    }));
    const service = new ArcEpisodeDirectionsService({ completeJson } as never);

    const generating = service.generateMany(Array.from({ length: 7 }, (_, index) => input(index)));
    await vi.waitFor(() => expect(completeJson).toHaveBeenCalledTimes(4));
    expect(maximumActive).toBe(4);
    releases.splice(0).forEach((release) => release());
    await vi.waitFor(() => expect(completeJson).toHaveBeenCalledTimes(7));
    releases.splice(0).forEach((release) => release());

    const result = await generating;
    expect(maximumActive).toBe(4);
    expect(result.map((directions) => directions[0]!.episode)).toEqual([1, 6, 11, 16, 21, 26, 31]);
    expect(completeJson.mock.calls[0]![0]).toMatchObject({
      task: 'arc_episode_directions',
      promptId: 'arc-episode-directions',
      projectId: 'project',
      schema: { name: 'arc_episode_directions' },
      maxTokens: 16_000,
    });
  });
});
