import {
  arcSchema as sharedArcSchema,
  projectBlueprintSchema as sharedProjectBlueprintSchema,
  projectSchema as sharedProjectSchema,
} from '@paranovel/contracts';
import { describe, expect, it } from 'vitest';
import {
  arcEpisodeDirectionsValidatorForRange,
  arcMilestonePlanValidator,
  arcPlanValidator,
  projectBlueprintMilestonesValidator,
  projectBlueprintValidator,
} from '../src/ai/ai.schemas';

const directions = (start: number, end: number) => Array.from(
  { length: end - start + 1 },
  (_, index) => ({
    episode: start + index,
    title: `${start + index}화`,
    direction: '앞선 결과를 받아 다음 마일스톤으로 나아간다.',
  }),
);

const validBlueprint = {
  title: '달 없는 밤',
  logline: '기록관이 사라진 달을 되찾는다.',
  genreTags: ['판타지'],
  writingDirection: '3인칭 제한 시점과 차분한 문체를 유지한다.',
  defaultTargetChars: 5000,
  targetEpisode: 10,
  targetEpisodeSource: 'USER' as const,
  canon: [],
  arcs: [
    { title: '도난', startEpisode: 1, endEpisode: 5, goal: '흔적을 찾는다.', conflict: '왕실의 추격', milestones: [{ episode: 4, type: 'REVERSAL' as const, description: '달이 스스로 사라졌음이 드러난다.' }], episodeDirections: directions(1, 5) },
    { title: '귀환', startEpisode: 6, endEpisode: 10, goal: '달을 되돌린다.', conflict: '기억의 대가', milestones: [{ episode: 10, type: 'RESOLUTION' as const, description: '달을 되돌린다.' }], episodeDirections: directions(6, 10) },
  ],
};

describe('full project arc blueprint contract', () => {
  it('accepts one contiguous plan from episode 1 through the target ending', () => {
    expect(projectBlueprintValidator.parse(validBlueprint).arcs).toHaveLength(2);
    expect(sharedProjectBlueprintSchema.parse(validBlueprint).targetEpisode).toBe(10);
    expect(projectBlueprintValidator.parse(validBlueprint).writingDirection).toBe(validBlueprint.writingDirection);
    expect(sharedProjectBlueprintSchema.parse(validBlueprint).writingDirection).toBe(validBlueprint.writingDirection);
  });

  it.each([
    ['empty arcs', (value: typeof validBlueprint) => { value.arcs = []; }],
    ['late first arc', (value: typeof validBlueprint) => { value.arcs[0]!.startEpisode = 2; }],
    ['gap', (value: typeof validBlueprint) => { value.arcs[1]!.startEpisode = 7; }],
    ['short arc', (value: typeof validBlueprint) => { value.arcs[0]!.endEpisode = 4; value.arcs[1]!.startEpisode = 5; }],
    ['wrong ending', (value: typeof validBlueprint) => { value.targetEpisode = 11; }],
    ['out-of-range milestone', (value: typeof validBlueprint) => { value.arcs[0]!.milestones[0]!.episode = 8; }],
    ['missing direction', (value: typeof validBlueprint) => { value.arcs[0]!.episodeDirections.pop(); }],
    ['duplicate direction', (value: typeof validBlueprint) => { value.arcs[0]!.episodeDirections[1]!.episode = 1; }],
  ])('rejects %s in both runtime and shared schemas', (_name, change) => {
    const input = structuredClone(validBlueprint);
    change(input);
    expect(projectBlueprintValidator.safeParse(input).success).toBe(false);
    expect(sharedProjectBlueprintSchema.safeParse(input).success).toBe(false);
  });

  it('separates milestone generation from exact per-episode direction coverage', () => {
    const proposal = {
      title: '다음 문', startEpisodeNumber: 6, endEpisodeNumber: 10,
      goal: '문을 연다.', conflict: '수문장이 막는다.',
      milestones: [{ episode: 9, type: 'REVERSAL' as const, description: '조력자의 정체가 드러난다.' }],
      conflicts: [],
    };
    expect(arcMilestonePlanValidator.safeParse(proposal).success).toBe(true);
    expect(arcPlanValidator.safeParse(proposal).success).toBe(false);
    expect(arcEpisodeDirectionsValidatorForRange(6, 10).safeParse({
      episodeDirections: directions(6, 10),
    }).success).toBe(true);
    expect(arcEpisodeDirectionsValidatorForRange(6, 10).safeParse({
      episodeDirections: [{ episode: 5, title: '잘못된 회차', direction: '범위 밖의 일이다.' }],
    }).success).toBe(false);
  });

  it('accepts milestone-only blueprints only in stage one', () => {
    const milestoneBlueprint = {
      ...validBlueprint,
      arcs: validBlueprint.arcs.map(({ episodeDirections: _directions, ...arc }) => arc),
    };
    expect(projectBlueprintMilestonesValidator.safeParse(milestoneBlueprint).success).toBe(true);
    expect(projectBlueprintValidator.safeParse(milestoneBlueprint).success).toBe(false);
  });

  it('keeps standalone project and arc response contracts aligned with persistence rules', () => {
    const storedArc = {
      ...validBlueprint.arcs[0],
      id: 'arc',
      projectId: 'project',
      status: 'ACTIVE' as const,
      revision: 1,
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
    };
    expect(sharedArcSchema.safeParse({ ...storedArc, endEpisode: 4 }).success).toBe(false);
    expect(sharedArcSchema.safeParse({
      ...storedArc,
      milestones: [{ episode: 9, type: 'REVERSAL', description: '범위 밖 반전' }],
    }).success).toBe(false);

    const storedProject = {
      id: 'project', title: '달 없는 밤', logline: '기록관이 달을 찾는다.', genreTags: ['판타지'],
      defaultTargetChars: 5000, revision: 1,
      createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
    };
    expect(sharedProjectSchema.safeParse({ ...storedProject, targetEpisode: 20 }).success).toBe(false);
    expect(sharedProjectSchema.safeParse({ ...storedProject, targetEpisodeSource: 'AI' }).success).toBe(false);
    expect(sharedProjectSchema.safeParse({
      ...storedProject, targetEpisode: 20, targetEpisodeSource: 'AI',
    }).success).toBe(true);
  });
});
