import { describe, expect, it } from 'vitest';
import { episodeBackupKey, parseEpisodeDraftBackup, shouldOfferEpisodeBackup } from './episodeBackup';

const server = {
  title: '서버 제목',
  direction: '서버 방향',
  content: '서버 원고',
  revision: 3,
  updatedAt: '2026-09-05T00:00:00.000Z',
};

describe('episode draft recovery', () => {
  it('isolates storage by episode id', () => {
    expect(episodeBackupKey('episode-a')).toBe('paranovel.draft.episode-a');
    expect(episodeBackupKey('episode-a')).not.toBe(episodeBackupKey('episode-b'));
  });

  it('offers a differing backup based on the current server revision', () => {
    expect(shouldOfferEpisodeBackup({
      title: '서버 제목',
      direction: '서버 방향',
      content: '저장되지 않은 원고',
      savedAt: '2026-09-04T23:59:00.000Z',
      baseRevision: 3,
    }, server)).toBe(true);
  });

  it('ignores identical and stale backups', () => {
    expect(shouldOfferEpisodeBackup({ ...server, savedAt: '2026-09-05T00:01:00.000Z', baseRevision: 3 }, server)).toBe(false);
    expect(shouldOfferEpisodeBackup({
      title: '오래된 제목',
      direction: server.direction,
      content: server.content,
      savedAt: '2026-09-04T20:00:00.000Z',
      baseRevision: 2,
    }, server)).toBe(false);
  });

  it('rejects malformed storage values', () => {
    expect(parseEpisodeDraftBackup('{bad json')).toBeNull();
    expect(parseEpisodeDraftBackup(JSON.stringify({ content: 'missing fields' }))).toBeNull();
  });
});
