export interface EpisodeDraftBackup {
  title: string;
  direction: string;
  content: string;
  savedAt: string;
  baseRevision?: number;
}

export interface EpisodeServerDraft {
  title: string;
  direction: string;
  content: string;
  revision: number;
  updatedAt: string;
}

export function episodeBackupKey(episodeId: string): string {
  return `paranovel.draft.${episodeId}`;
}

export function parseEpisodeDraftBackup(raw: string | null): EpisodeDraftBackup | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (
      typeof value.title !== 'string' ||
      typeof value.direction !== 'string' ||
      typeof value.content !== 'string' ||
      typeof value.savedAt !== 'string'
    ) return null;
    return {
      title: value.title,
      direction: value.direction,
      content: value.content,
      savedAt: value.savedAt,
      ...(Number.isInteger(value.baseRevision) ? { baseRevision: Number(value.baseRevision) } : {}),
    };
  } catch {
    return null;
  }
}

export function shouldOfferEpisodeBackup(
  backup: EpisodeDraftBackup,
  server: EpisodeServerDraft,
): boolean {
  const differs =
    backup.title !== server.title ||
    backup.direction !== server.direction ||
    backup.content !== server.content;
  if (!differs) return false;

  // A backup based on the same server revision is necessarily an unsaved local
  // edit. Older-format backups fall back to timestamps.
  if (backup.baseRevision !== undefined && backup.baseRevision >= server.revision) return true;
  const backupTime = Date.parse(backup.savedAt);
  const serverTime = Date.parse(server.updatedAt);
  return Number.isFinite(backupTime) && (!Number.isFinite(serverTime) || backupTime > serverTime);
}

export function readEpisodeDraftBackup(episodeId: string): EpisodeDraftBackup | null {
  try {
    return parseEpisodeDraftBackup(localStorage.getItem(episodeBackupKey(episodeId)));
  } catch {
    return null;
  }
}

export function writeEpisodeDraftBackup(episodeId: string, backup: EpisodeDraftBackup): void {
  try {
    localStorage.setItem(episodeBackupKey(episodeId), JSON.stringify(backup));
  } catch {
    // A storage quota/privacy failure must not interrupt the editor itself.
  }
}

export function clearEpisodeDraftBackup(episodeId: string): void {
  try {
    localStorage.removeItem(episodeBackupKey(episodeId));
  } catch {
    // See writeEpisodeDraftBackup.
  }
}
