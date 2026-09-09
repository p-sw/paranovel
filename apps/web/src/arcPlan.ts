import type { ArcEpisodeDirection, ArcMilestone, ArcMilestoneType } from './types';

export const MILESTONE_TYPES: ArcMilestoneType[] = [
  'GOAL',
  'REVERSAL',
  'ESCALATION',
  'CLIMAX',
  'RESOLUTION',
  'OTHER',
];

export const MILESTONE_TYPE_LABELS: Record<ArcMilestoneType, string> = {
  GOAL: '목표',
  REVERSAL: '반전',
  ESCALATION: '고조',
  CLIMAX: '클라이맥스',
  RESOLUTION: '해결',
  OTHER: '기타',
};

export function episodeDirectionsForRange(
  startEpisode: number,
  endEpisode: number,
  current: ArcEpisodeDirection[] = [],
): ArcEpisodeDirection[] {
  const span = endEpisode - startEpisode + 1;
  if (!Number.isInteger(startEpisode) || !Number.isInteger(endEpisode) || startEpisode < 1 || span < 1 || span > 2_000) {
    return current;
  }
  const byEpisode = new Map(current.map((item) => [item.episode, item]));
  return Array.from({ length: span }, (_, index) => {
    const episode = startEpisode + index;
    return byEpisode.get(episode) ?? { episode, title: '', direction: '' };
  });
}

export function episodeDirectionsIssue(
  startEpisode: number,
  endEpisode: number,
  directions: ArcEpisodeDirection[],
): string {
  const span = endEpisode - startEpisode + 1;
  if (directions.length !== span) return '시작 회차부터 끝 회차까지 모든 회차의 전개 방향을 입력해 주세요.';
  const episodes = new Set<number>();
  for (const item of directions) {
    if (!Number.isInteger(item.episode) || item.episode < startEpisode || item.episode > endEpisode || episodes.has(item.episode)) {
      return '회차별 전개는 아크 범위의 각 회차에 정확히 하나씩 있어야 합니다.';
    }
    episodes.add(item.episode);
    if (!item.title.trim() || !item.direction.trim()) return `${item.episode}화의 제목과 전개 방향을 모두 입력해 주세요.`;
    if (item.title.trim().length > 200 || item.direction.trim().length > 20_000) {
      return `${item.episode}화의 제목은 200자, 전개 방향은 20,000자 이하여야 합니다.`;
    }
  }
  for (let episode = startEpisode; episode <= endEpisode; episode += 1) {
    if (!episodes.has(episode)) return `${episode}화의 전개 방향을 입력해 주세요.`;
  }
  return '';
}

export function legacyMilestones(input: {
  endEpisode: number;
  goal: string;
  milestones?: ArcMilestone[];
  reversalPlan?: Array<{ id?: string; episode: number; description: string }>;
}): ArcMilestone[] {
  if (input.milestones?.length) return input.milestones;
  if (input.reversalPlan?.length) {
    return input.reversalPlan.map((item) => ({ ...item, type: 'REVERSAL' }));
  }
  return [{ episode: input.endEpisode, type: 'GOAL', description: input.goal }];
}
