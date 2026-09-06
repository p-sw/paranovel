import type { canonEntries } from '../database/schema';
import { parseJson } from '../shared/utils';

export function formatCanonMemory(entry: Pick<typeof canonEntries.$inferSelect,
  'category' | 'name' | 'aliasesJson' | 'content'>): string {
  const aliases = parseJson<string[]>(entry.aliasesJson, []).filter((alias) => typeof alias === 'string');
  return `${entry.category}: ${entry.name}\n별칭: ${aliases.join(', ')}\n${entry.content}`;
}
