import type { arcs } from '../database/schema';
import { parseJson } from '../shared/utils';

export function formatArcMemory(arc: Pick<typeof arcs.$inferSelect,
  'title' | 'startEpisodeNumber' | 'endEpisodeNumber' | 'goal' | 'conflict'
  | 'reversalPlanJson' | 'milestonePlanJson' | 'episodeDirectionsJson' | 'status'>): string {
  const storedMilestones = parseJson<unknown>(arc.milestonePlanJson, []);
  const legacyReversals = parseJson<unknown>(arc.reversalPlanJson, []);
  const milestones = Array.isArray(storedMilestones) && storedMilestones.length > 0
    ? storedMilestones
    : Array.isArray(legacyReversals)
      ? legacyReversals.map((beat) => (
          beat && typeof beat === 'object' && !Array.isArray(beat)
            ? { ...(beat as Record<string, unknown>), type: 'REVERSAL' }
            : beat
        ))
      : [];
  const milestoneText = Array.isArray(milestones)
    ? milestones.filter((milestone): milestone is { episode: number; type: string; description: string } =>
      milestone !== null && typeof milestone === 'object' && Number.isInteger(milestone.episode)
      && milestone.episode > 0 && typeof milestone.type === 'string'
      && typeof milestone.description === 'string',
    ).map((milestone) => (
      `${milestone.episode}화 [${milestone.type}] — ${milestone.description}`
    )).join('\n')
    : '';
  const storedDirections = parseJson<unknown>(arc.episodeDirectionsJson, []);
  const directionText = Array.isArray(storedDirections)
    ? storedDirections.filter((direction): direction is { episode: number; title: string; direction: string } =>
      direction !== null && typeof direction === 'object' && Number.isInteger(direction.episode)
      && direction.episode > 0 && typeof direction.title === 'string'
      && typeof direction.direction === 'string',
    ).map((direction) => (
      `${direction.episode}화 「${direction.title}」 — ${direction.direction}`
    )).join('\n')
    : '';
  const statusLabel = arc.status === 'ACTIVE' ? '보호된 현재 계획'
    : arc.status === 'COMPLETE' ? '완료된 이전 계획'
      : arc.status === 'PLANNED' ? '변경 가능한 미래 계획' : '폐기된 계획';
  return `${arc.title}\n상태: ${statusLabel}\n범위: ${arc.startEpisodeNumber}–${arc.endEpisodeNumber}화\n목표: ${arc.goal}\n갈등: ${arc.conflict}\n회차별 마일스톤:\n${milestoneText}\n회차별 전개:\n${directionText}`;
}
