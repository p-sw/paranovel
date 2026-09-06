import {
  arcSchema as sharedArcSchema,
  projectBlueprintSchema as sharedProjectBlueprintSchema,
  projectSchema as sharedProjectSchema,
} from '@paranovel/contracts';
import { describe, expect, it } from 'vitest';
import { arcPlanValidator, projectBlueprintValidator } from '../src/ai/ai.schemas';

const validBlueprint = {
  title: '달 없는 밤',
  logline: '기록관이 사라진 달을 되찾는다.',
  genreTags: ['판타지'],
  details: '달빛이 기억을 보관하는 세계',
  defaultTargetChars: 5000,
  targetEpisode: 10,
  targetEpisodeSource: 'USER' as const,
  canon: [],
  arcs: [
    { title: '도난', startEpisode: 1, endEpisode: 5, goal: '흔적을 찾는다.', conflict: '왕실의 추격', reversalPlan: [{ episode: 4, description: '달이 스스로 사라졌음이 드러난다.' }] },
    { title: '귀환', startEpisode: 6, endEpisode: 10, goal: '달을 되돌린다.', conflict: '기억의 대가', reversalPlan: [] },
  ],
};

describe('full project arc blueprint contract', () => {
  it('accepts one contiguous plan from episode 1 through the target ending', () => {
    expect(projectBlueprintValidator.parse(validBlueprint).arcs).toHaveLength(2);
    expect(sharedProjectBlueprintSchema.parse(validBlueprint).targetEpisode).toBe(10);
  });

  it.each([
    ['empty arcs', (value: typeof validBlueprint) => { value.arcs = []; }],
    ['late first arc', (value: typeof validBlueprint) => { value.arcs[0]!.startEpisode = 2; }],
    ['gap', (value: typeof validBlueprint) => { value.arcs[1]!.startEpisode = 7; }],
    ['short arc', (value: typeof validBlueprint) => { value.arcs[0]!.endEpisode = 4; value.arcs[1]!.startEpisode = 5; }],
    ['wrong ending', (value: typeof validBlueprint) => { value.targetEpisode = 11; }],
    ['out-of-range reversal', (value: typeof validBlueprint) => { value.arcs[0]!.reversalPlan[0]!.episode = 8; }],
  ])('rejects %s in both runtime and shared schemas', (_name, change) => {
    const input = structuredClone(validBlueprint);
    change(input);
    expect(projectBlueprintValidator.safeParse(input).success).toBe(false);
    expect(sharedProjectBlueprintSchema.safeParse(input).success).toBe(false);
  });

  it('rejects arc-planner reversals and directions outside the proposed range', () => {
    const proposal = {
      title: '다음 문', startEpisodeNumber: 6, endEpisodeNumber: 10,
      goal: '문을 연다.', conflict: '수문장이 막는다.',
      reversalPlan: [{ episode: 99, description: '조력자의 정체가 드러난다.' }],
      episodeDirections: [{ episode: 5, title: '잘못된 회차', direction: '범위 밖의 일이다.' }],
      conflicts: [],
    };
    const parsed = arcPlanValidator.safeParse(proposal);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.map((issue) => issue.path.join('.'))).toEqual(
        expect.arrayContaining(['reversalPlan.0.episode', 'episodeDirections.0.episode']),
      );
    }
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
      reversalPlan: [{ episode: 9, description: '범위 밖 반전' }],
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
