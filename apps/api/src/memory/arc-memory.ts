import type { arcs } from '../database/schema';
import { parseJson } from '../shared/utils';

export function formatArcMemory(arc: Pick<typeof arcs.$inferSelect, 'title' | 'goal' | 'conflict' | 'reversalPlanJson'>): string {
  const beats = parseJson<unknown>(arc.reversalPlanJson, []);
  const reversals = Array.isArray(beats)
    ? beats.filter((beat): beat is { episode: number; description: string } =>
      beat !== null && typeof beat === 'object' && Number.isInteger(beat.episode)
      && beat.episode > 0 && typeof beat.description === 'string',
    ).map((beat) => `${beat.episode}화 — ${beat.description}`).join('\n')
    : '';
  return `${arc.title}\n목표: ${arc.goal}\n갈등: ${arc.conflict}\n회차별 반전:\n${reversals}`;
}
