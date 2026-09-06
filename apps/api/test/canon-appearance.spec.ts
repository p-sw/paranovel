import { ConflictException } from '@nestjs/common';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  episodeMemorySchema, episodeMemoryValidator,
  projectBlueprintSchema, projectBlueprintValidator,
  worldbuildingSchema, worldbuildingValidator,
} from '../src/ai/ai.schemas';
import { CanonService } from '../src/canon/canon.service';
import { DatabaseService } from '../src/database/database.service';
import { EpisodesService } from '../src/episodes/episodes.service';
import { MemoryService } from '../src/memory/memory.service';
import { ProjectsService } from '../src/projects/projects.service';

const appearance = {
  category: 'CHARACTER_APPEARANCE', name: '하린', aliases: ['기록관'],
  content: '머리카락: 은색 긴 생머리\n눈동자: 보라색\n피부: 올리브색\n복장: 남색 코트\n장신구: 초승달 귀걸이',
  metadata: {},
};
const extractedMemory = {
  events: ['하린이 문을 열었다.'], emotionalChanges: [], newForeshadowing: [], resolvedForeshadowing: [],
  endScene: { location: '문 앞', time: null, pointOfView: '하린', characters: ['하린'], goal: null },
  canonCandidates: [appearance],
};

describe('character appearance canon', () => {
  let database: DatabaseService;
  let memory: MemoryService;
  let projects: ProjectsService;
  let canon: CanonService;
  let projectId: string;

  beforeEach(() => {
    vi.stubEnv('DB_PATH', ':memory:');
    vi.stubEnv('OPENROUTER_EMBEDDING_DIMENSIONS', '4');
    database = new DatabaseService();
    memory = new MemoryService(database, { embeddings: async (texts: string[]) => texts.map(() => [0, 1, 0, 1]) } as never);
    projects = new ProjectsService(database);
    canon = new CanonService(database, memory, {} as never);
    projectId = projects.createInternal({ title: '기록의 문', logline: '기억을 읽는 기록관', genreTags: ['판타지'] }).id;
  });
  afterEach(() => { database.onApplicationShutdown(); vi.unstubAllEnvs(); });

  it('keeps visual candidates out of AI memory until approved and preserves details after reindexing', async () => {
    await canon.create(projectId, { category: 'CHARACTER', name: appearance.name, content: '기억을 읽는 기록관' });
    const pending = await canon.create(projectId, { ...appearance, status: 'PENDING' });
    expect(JSON.parse((await memory.assemble(projectId, '하린')).canon)).toHaveLength(1);
    expect(await memory.search(projectId, '초승달 귀걸이', 10)).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceId: pending.id }),
    ]));

    const approved = await canon.update(projectId, pending.id, { expectedRevision: pending.revision, status: 'ACTIVE' });
    expect(approved).toMatchObject({ ...appearance, revision: 2, status: 'ACTIVE' });
    expect(JSON.parse((await memory.assemble(projectId, '하린')).canon)).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: appearance.category, content: appearance.content }),
    ]));
    await memory.reindexProject(projectId);
    expect(await memory.search(projectId, '초승달 귀걸이', 10)).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceId: approved.id, content: expect.stringContaining(appearance.content) }),
    ]));
    await expect(canon.update(projectId, approved.id, { expectedRevision: pending.revision, content: '잘못된 수정' }))
      .rejects.toBeInstanceOf(ConflictException);
  });

  it('extracts appearance beside a same-name character without adding repeated appearance candidates', async () => {
    await canon.create(projectId, { category: 'CHARACTER', name: appearance.name, content: '기억을 읽는 기록관' });
    const service = new EpisodesService(database, projects, memory, {
      completeJson: vi.fn().mockResolvedValue({ value: { ...extractedMemory, canonCandidates: [appearance, appearance] } }),
    } as never);
    const episode = await service.create(projectId, { title: '문 앞에서', direction: '하린이 문을 연다.', content: '은발의 하린이 초승달 귀걸이를 만지며 문을 열었다.' });
    await service.finalize(projectId, episode.id, { expectedRevision: episode.revision });
    const records = canon.list(projectId);
    expect(records).toHaveLength(2);
    expect(records.find((record) => record.category === 'CHARACTER_APPEARANCE')).toMatchObject({
      ...appearance, status: 'PENDING', sourceEpisodeId: episode.id,
    });
  });

  it('accepts appearance in worldbuilding, project blueprints and episode extraction output contracts', () => {
    expect(worldbuildingValidator.parse({ suggestions: [appearance], conflicts: [] }).suggestions).toEqual([appearance]);
    expect(episodeMemoryValidator.parse(extractedMemory).canonCandidates).toEqual([appearance]);
    expect(projectBlueprintValidator.parse({
      title: '기록의 문', logline: '기억을 읽는 기록관', genreTags: ['판타지'], details: '', defaultTargetChars: 5000,
      targetEpisode: 8, targetEpisodeSource: 'USER', canon: [appearance],
      arcs: [{ title: '첫 기록', startEpisode: 1, endEpisode: 8, goal: '기록을 찾는다', conflict: '왕실의 방해', reversalPlan: [] }],
    }).canon).toEqual([appearance]);
    for (const [schema, field] of [[worldbuildingSchema, 'suggestions'], [projectBlueprintSchema, 'canon'], [episodeMemorySchema, 'canonCandidates']] as const) {
      const properties = schema.properties as Record<string, { items: { properties: { category: { enum: string[] } } } }>;
      expect(properties[field]!.items.properties.category.enum).toContain('CHARACTER_APPEARANCE');
    }
  });
});

describe('appearance category migration', () => {
  it('upgrades the legacy category constraint without changing existing data or foreign keys', () => {
    const directory = mkdtempSync(join(tmpdir(), 'paranovel-canon-migration-'));
    const dbPath = join(directory, 'legacy.sqlite');
    let initialized: DatabaseService | undefined;
    let legacy: Database.Database | undefined;
    let migrated: DatabaseService | undefined;
    try {
      vi.stubEnv('DB_PATH', dbPath);
      initialized = new DatabaseService();
      const stamp = '2026-01-01T00:00:00.000Z';
      initialized.connection.prepare('INSERT INTO projects (id, title, logline, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
        .run('project', '기록의 문', '기록관의 이야기', stamp, stamp);
      initialized.connection.prepare('INSERT INTO episodes (id, project_id, number, title, direction, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run('episode', 'project', 1, '첫 기록', '문을 연다', stamp, stamp);
      initialized.connection.prepare(`INSERT INTO canon_entries
        (id, project_id, category, name, aliases_json, content, metadata_json, status, revision, source_episode_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run('canon', 'project', 'CHARACTER', '하린', '["기록관"]', '기억을 읽는다.', '{"source":"원문"}', 'ACCEPTED', 7, 'episode', stamp, stamp);
      const before = initialized.connection.prepare('SELECT * FROM canon_entries').all();
      initialized.onApplicationShutdown();

      // Restore the v5 canon table in an otherwise complete database so later,
      // unrelated migrations do not need to be duplicated in this fixture.
      legacy = new Database(dbPath);
      legacy.pragma('foreign_keys = ON');
      legacy.exec(`
        BEGIN;
        CREATE TABLE canon_entries_legacy (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          category TEXT NOT NULL CHECK (category IN ('CHARACTER','LOCATION','ORGANIZATION','ABILITY','RULE','TIMELINE','OTHER')),
          name TEXT NOT NULL, aliases_json TEXT NOT NULL DEFAULT '[]', content TEXT NOT NULL,
          metadata_json TEXT NOT NULL DEFAULT '{}',
          status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','PENDING','ACCEPTED','REJECTED')),
          revision INTEGER NOT NULL DEFAULT 1,
          source_episode_id TEXT REFERENCES episodes(id) ON DELETE SET NULL,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        INSERT INTO canon_entries_legacy SELECT * FROM canon_entries;
        DROP TABLE canon_entries;
        ALTER TABLE canon_entries_legacy RENAME TO canon_entries;
        CREATE INDEX idx_canon_project_category ON canon_entries(project_id, category, status);
        DELETE FROM schema_migrations WHERE version = 6;
        COMMIT;
      `);
      expect(() => legacy!.prepare("UPDATE canon_entries SET category = 'CHARACTER_APPEARANCE'").run()).toThrow(/CHECK constraint/);
      legacy.close();

      migrated = new DatabaseService();
      expect(migrated.connection.prepare('SELECT * FROM canon_entries').all()).toEqual(before);
      expect(migrated.connection.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_canon_project_category'").get()).toBeDefined();
      expect(migrated.connection.pragma('foreign_key_check')).toEqual([]);
      migrated.connection.prepare("UPDATE canon_entries SET category = 'CHARACTER_APPEARANCE'").run();
      expect(() => migrated!.connection.prepare("UPDATE canon_entries SET category = 'INVALID'").run()).toThrow(/CHECK constraint/);
      migrated.connection.prepare("DELETE FROM episodes WHERE id = 'episode'").run();
      expect(migrated.connection.prepare("SELECT source_episode_id FROM canon_entries WHERE id = 'canon'").get())
        .toEqual({ source_episode_id: null });
      migrated.connection.prepare("DELETE FROM projects WHERE id = 'project'").run();
      expect(migrated.connection.prepare('SELECT * FROM canon_entries').all()).toEqual([]);
      migrated.onApplicationShutdown();
      migrated = new DatabaseService();
      expect(migrated.connection.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 6').get()).toEqual({ count: 1 });
    } finally {
      initialized?.onApplicationShutdown();
      if (legacy?.open) legacy.close();
      migrated?.onApplicationShutdown();
      vi.unstubAllEnvs();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
