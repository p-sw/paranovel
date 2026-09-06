import type { arcs } from '../database/schema';
import { parseJson } from '../shared/utils';

export function formatArcMemory(arc: Pick<typeof arcs.$inferSelect,
  'title' | 'startEpisodeNumber' | 'endEpisodeNumber' | 'goal' | 'conflict' | 'reversalPlanJson' | 'status'>): string {
  const beats = parseJson<unknown>(arc.reversalPlanJson, []);
  const reversals = Array.isArray(beats)
    ? beats.filter((beat): beat is { episode: number; description: string } =>
      beat !== null && typeof beat === 'object' && Number.isInteger(beat.episode)
      && beat.episode > 0 && typeof beat.description === 'string',
    ).map((beat) => `${beat.episode}화 — ${beat.description}`).join('\n')
    : '';
  const statusLabel = arc.status === 'ACTIVE' ? '보호된 현재 계획'
    : arc.status === 'COMPLETE' ? '완료된 이전 계획'
      : arc.status === 'PLANNED' ? '변경 가능한 미래 계획' : '폐기된 계획';
  return `${arc.title}\n상태: ${statusLabel}\n범위: ${arc.startEpisodeNumber}–${arc.endEpisodeNumber}화\n목표: ${arc.goal}\n갈등: ${arc.conflict}\n회차별 반전:\n${reversals}`;
}
