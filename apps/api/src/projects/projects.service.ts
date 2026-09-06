import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, count, eq, isNull, max } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service';
import { episodes, memoryChunks, projects } from '../database/schema';
import {
  id,
  now,
  optionalString,
  parseJson,
  requireString,
  stringifyJson,
  stringArray,
} from '../shared/utils';

export interface ProjectView {
  id: string;
  title: string;
  logline: string;
  genreTags: string[];
  details: string;
  defaultTargetChars: number;
  revision: number;
  episodeCount: number;
  lastEpisodeNumber: number | null;
  nextEpisodeNumber: number;
  createdAt: string;
  updatedAt: string;
}

@Injectable()
export class ProjectsService {
  constructor(private readonly database: DatabaseService) {}

  list(): ProjectView[] {
    return this.database.orm
      .select()
      .from(projects)
      .where(isNull(projects.deletedAt))
      .all()
      .map((row) => this.toView(row));
  }

  get(projectId: string): ProjectView {
    const row = this.database.orm
      .select()
      .from(projects)
      .where(and(eq(projects.id, projectId), isNull(projects.deletedAt)))
      .get();
    if (!row) throw new NotFoundException('Project not found');
    return this.toView(row);
  }

  createInternal(input: {
    title: string;
    logline: string;
    genreTags: string[];
    details?: string;
    defaultTargetChars?: number;
    id?: string;
  }): ProjectView {
    const stamp = now();
    const row = {
      id: input.id ?? id(),
      title: requireString(input.title, 'title', { max: 200 }),
      logline: requireString(input.logline, 'logline', { max: 2_000 }),
      genreTagsJson: stringifyJson(input.genreTags),
      detailsJson: stringifyJson(input.details ?? ''),
      defaultTargetChars: input.defaultTargetChars ?? 5_000,
      nextEpisodeNumber: 1,
      revision: 1,
      createdAt: stamp,
      updatedAt: stamp,
      deletedAt: null,
    };
    this.database.orm.insert(projects).values(row).run();
    return this.toView(row);
  }

  update(projectId: string, body: unknown): ProjectView {
    this.get(projectId);
    const input = (body ?? {}) as Record<string, unknown>;
    const expectedRevision = Number(input.expectedRevision);
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
      throw new BadRequestException('expectedRevision is required');
    }
    const current = this.database.orm.select().from(projects).where(eq(projects.id, projectId)).get()!;
    const changes: Partial<typeof projects.$inferInsert> = {
      updatedAt: now(),
      revision: current.revision + 1,
    };
    if ('title' in input) changes.title = requireString(input.title, 'title', { max: 200 });
    if ('logline' in input) changes.logline = requireString(input.logline, 'logline', { max: 2_000 });
    if ('genreTags' in input) {
      const tags = stringArray(input.genreTags, 'genreTags');
      if (tags.length === 0) throw new BadRequestException('At least one genre tag is required');
      changes.genreTagsJson = stringifyJson(tags);
    }
    if ('details' in input) {
      changes.detailsJson = stringifyJson(optionalString(input.details, 'details', 20_000) ?? '');
    }
    if ('defaultTargetChars' in input) {
      const value = Number(input.defaultTargetChars);
      if (!Number.isInteger(value) || value < 500 || value > 30_000) {
        throw new BadRequestException('defaultTargetChars must be between 500 and 30000');
      }
      changes.defaultTargetChars = value;
    }
    const result = this.database.orm
      .update(projects)
      .set(changes)
      .where(and(eq(projects.id, projectId), eq(projects.revision, expectedRevision)))
      .run();
    if (result.changes !== 1) throw new ConflictException('Project revision is stale');
    return this.get(projectId);
  }

  remove(projectId: string): void {
    this.get(projectId);
    const chunkIds = this.database.orm
      .select({ id: memoryChunks.id })
      .from(memoryChunks)
      .where(eq(memoryChunks.projectId, projectId))
      .all();
    this.database.connection.transaction(() => {
      for (const chunk of chunkIds) {
        this.database.connection
          .prepare('DELETE FROM memory_chunks_fts WHERE chunk_id = ?')
          .run(chunk.id);
        if (this.database.vectorAvailable) {
          this.database.connection
            .prepare('DELETE FROM memory_chunks_vec WHERE chunk_id = ?')
            .run(chunk.id);
        }
      }
      this.database.orm.delete(projects).where(eq(projects.id, projectId)).run();
    })();
  }

  private toView(row: typeof projects.$inferSelect): ProjectView {
    const aggregate = this.database.orm
      .select({ count: count(), last: max(episodes.number) })
      .from(episodes)
      .where(and(
        eq(episodes.projectId, row.id),
        eq(episodes.kind, 'MAIN'),
        isNull(episodes.deletedAt),
      ))
      .get();
    const last = aggregate?.last ?? null;
    return {
      id: row.id,
      title: row.title,
      logline: row.logline,
      genreTags: parseJson(row.genreTagsJson, []),
      details: parseJson(row.detailsJson, row.detailsJson),
      defaultTargetChars: row.defaultTargetChars,
      revision: row.revision,
      episodeCount: aggregate?.count ?? 0,
      lastEpisodeNumber: last,
      nextEpisodeNumber: row.nextEpisodeNumber,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
