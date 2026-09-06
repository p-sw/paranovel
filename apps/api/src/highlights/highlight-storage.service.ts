import { Injectable, Logger } from '@nestjs/common';
import { existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { DatabaseService } from '../database/database.service';
import { id } from '../shared/utils';

const fileNamePattern = /^[a-f0-9-]+\.(?:webp|png|jpg)$/i;
const temporaryPattern = /^[a-f0-9-]+\.(?:webp|png|jpg)\.[a-f0-9-]+\.tmp$/i;
const logger = new Logger('HighlightStorage');

export function highlightStorageDirectory(): string {
  const dbPath = process.env.DB_PATH === ':memory:' ? './data/paranovel.sqlite' : process.env.DB_PATH ?? './data/paranovel.sqlite';
  return process.env.IMAGE_STORAGE_PATH
    ? resolve(process.env.IMAGE_STORAGE_PATH)
    : resolve(dirname(resolve(dbPath)), 'images');
}

/** Called only with server-generated filenames, never with request paths. */
export function removeHighlightFile(fileName: string): void {
  if (!fileNamePattern.test(fileName) && !temporaryPattern.test(fileName)) throw new Error('Invalid stored image filename');
  try { unlinkSync(resolve(highlightStorageDirectory(), fileName)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}

export function flushHighlightFileCleanup(database: DatabaseService): void {
  const rows = database.connection.prepare('SELECT file_name FROM highlight_file_cleanup').all() as Array<{ file_name: string }>;
  for (const row of rows) {
    try {
      // A download retry can legitimately reuse its server-generated filename.
      // An old cleanup entry must never unlink the newly referenced result.
      const referenced = database.connection.prepare('SELECT 1 FROM episode_highlights WHERE file_name = ? LIMIT 1').get(row.file_name);
      if (!referenced) removeHighlightFile(row.file_name);
      database.connection.prepare('DELETE FROM highlight_file_cleanup WHERE file_name = ?').run(row.file_name);
    } catch {
      // Keep the durable cleanup entry so startup or the next operation retries.
      logger.warn('하이라이트 이미지 파일 정리를 다시 시도해야 합니다.');
    }
  }
}

@Injectable()
export class HighlightStorageService {
  constructor(private readonly database: DatabaseService) {}

  async write(fileName: string, bytes: Buffer): Promise<void> {
    const destination = this.path(fileName);
    mkdirSync(highlightStorageDirectory(), { recursive: true });
    const temporaryName = `${fileName}.${id()}.tmp`;
    try {
      await writeFile(resolve(highlightStorageDirectory(), temporaryName), bytes, { flag: 'wx' });
      await rename(resolve(highlightStorageDirectory(), temporaryName), destination);
    } finally {
      removeHighlightFile(temporaryName);
    }
  }

  path(fileName: string): string {
    if (!fileNamePattern.test(fileName)) throw new Error('Invalid stored image filename');
    return resolve(highlightStorageDirectory(), fileName);
  }

  cleanup(): void { flushHighlightFileCleanup(this.database); }

  recover(): void {
    this.cleanup();
    const directory = highlightStorageDirectory();
    if (!existsSync(directory)) return;
    const referenced = new Set((this.database.connection.prepare('SELECT file_name FROM episode_highlights WHERE file_name IS NOT NULL').all() as Array<{ file_name: string }>).map((row) => row.file_name));
    for (const fileName of readdirSync(directory)) {
      if (temporaryPattern.test(fileName) || (fileNamePattern.test(fileName) && !referenced.has(fileName))) {
        try { removeHighlightFile(fileName); } catch { logger.warn('중단된 이미지 파일을 정리하지 못했습니다.'); }
      }
    }
  }
}
