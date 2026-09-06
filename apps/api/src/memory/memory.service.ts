import {
  Injectable,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import { and, eq, isNull, or } from 'drizzle-orm';
import { OpenRouterGateway } from '../ai/openrouter.gateway';
import { DatabaseService } from '../database/database.service';
import { formatArcMemory } from './arc-memory';
import {
  arcs,
  canonEntries,
  episodeSummaries,
  episodes,
  improvements,
  memoryChunks,
  projects,
  sceneStates,
} from '../database/schema';
import {
  chunkText,
  extractLastParagraph,
  id,
  now,
  parseJson,
  sha256,
  stringifyJson,
} from '../shared/utils';

export interface MemorySearchResult {
  id: string;
  sourceType: string;
  sourceId: string;
  content: string;
  score: number;
}

export interface AssembledMemory {
  projectContext: string;
  canon: string;
  currentArc: string;
  currentScene: string;
  recentSummaries: string;
  openForeshadowing: string;
  retrievedMemories: string;
  improvements: string;
}

@Injectable()
export class MemoryService {
  private readonly logger = new Logger(MemoryService.name);
  private readonly embeddingModel =
    process.env.OPENROUTER_EMBEDDING_MODEL ?? 'openai/text-embedding-3-small';

  constructor(
    private readonly database: DatabaseService,
    private readonly openRouter: OpenRouterGateway,
  ) {}

  async indexSource(input: {
    projectId?: string | null;
    sourceType: string;
    sourceId: string;
    text: string;
    expectedEpisode?: { number: number; revision: number };
  }): Promise<void> {
    const pieces = chunkText(input.text);
    const isEpisode = ['EPISODE', 'EPISODE_SUMMARY'].includes(input.sourceType);
    const sourceEpisode = isEpisode
      ? this.database.orm
          .select({ number: episodes.number, revision: episodes.revision, projectId: episodes.projectId })
          .from(episodes)
          .where(and(eq(episodes.id, input.sourceId), isNull(episodes.deletedAt)))
          .get()
      : undefined;
    if (isEpisode && (!sourceEpisode || sourceEpisode.projectId !== input.projectId ||
      (input.expectedEpisode && (sourceEpisode.number !== input.expectedEpisode.number ||
        sourceEpisode.revision !== input.expectedEpisode.revision)))) return;
    const episodeNumber = sourceEpisode?.number ?? 0;
    let vectors: number[][] = [];
    if (pieces.length > 0) {
      try {
        vectors = await this.openRouter.embeddings(pieces);
      } catch (error) {
        this.logger.warn(
          `Embedding unavailable for ${input.sourceType}/${input.sourceId}; keyword index retained: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    this.database.connection.transaction(() => {
      // Embeddings may finish after a reorder, edit, or deletion. Never restore
      // stale chunks, or delete a newer index that was written in the meantime.
      if (sourceEpisode) {
        const current = this.database.orm.select().from(episodes)
          .where(and(eq(episodes.id, input.sourceId), isNull(episodes.deletedAt))).get();
        if (!current || current.number !== sourceEpisode.number ||
          current.revision !== sourceEpisode.revision) return;
      }
      const oldRows = this.database.orm
        .select({ id: memoryChunks.id })
        .from(memoryChunks)
        .where(and(eq(memoryChunks.sourceType, input.sourceType), eq(memoryChunks.sourceId, input.sourceId)))
        .all();
      const deleteFts = this.database.connection.prepare(
        'DELETE FROM memory_chunks_fts WHERE chunk_id = ?',
      );
      const deleteVec = this.database.vectorAvailable
        ? this.database.connection.prepare(
            'DELETE FROM memory_chunks_vec WHERE chunk_id = ?',
          )
        : undefined;
      for (const row of oldRows) {
        deleteFts.run(row.id);
        deleteVec?.run(row.id);
      }
      this.database.orm
        .delete(memoryChunks)
        .where(
          and(
            eq(memoryChunks.sourceType, input.sourceType),
            eq(memoryChunks.sourceId, input.sourceId),
          ),
        )
        .run();

      const stamp = now();
      pieces.forEach((content, ordinal) => {
        const chunkId = id();
        const vector = vectors[ordinal];
        this.database.orm
          .insert(memoryChunks)
          .values({
            id: chunkId,
            projectId: input.projectId ?? null,
            sourceType: input.sourceType,
            sourceId: input.sourceId,
            ordinal,
            content,
            contentHash: sha256(content),
            embeddingModel: vector ? this.embeddingModel : null,
            embeddingJson: vector ? stringifyJson(vector) : null,
            createdAt: stamp,
            updatedAt: stamp,
          })
          .run();
        this.database.connection
          .prepare(
            'INSERT INTO memory_chunks_fts(chunk_id, project_id, content) VALUES (?, ?, ?)',
          )
          .run(chunkId, input.projectId ?? null, content);
        if (
          vector &&
          vector.length === this.database.embeddingDimensions &&
          this.database.vectorAvailable
        ) {
          const blob = Buffer.from(new Float32Array(vector).buffer);
          this.database.connection
            .prepare(
              `INSERT INTO memory_chunks_vec(
                 chunk_id, project_key, episode_number, embedding
               ) VALUES (?, ?, ?, ?)`,
            )
            .run(
              chunkId,
              input.projectId ?? '__GLOBAL__',
              BigInt(episodeNumber),
              blob,
            );
        }
      });
    })();
  }

  removeSource(sourceType: string, sourceId: string): void {
    const rows = this.database.orm
      .select({ id: memoryChunks.id })
      .from(memoryChunks)
      .where(
        and(eq(memoryChunks.sourceType, sourceType), eq(memoryChunks.sourceId, sourceId)),
      )
      .all();
    this.database.connection.transaction(() => {
      for (const row of rows) {
        this.database.connection
          .prepare('DELETE FROM memory_chunks_fts WHERE chunk_id = ?')
          .run(row.id);
        if (this.database.vectorAvailable) {
          this.database.connection
            .prepare('DELETE FROM memory_chunks_vec WHERE chunk_id = ?')
            .run(row.id);
        }
      }
      this.database.orm
        .delete(memoryChunks)
        .where(
          and(eq(memoryChunks.sourceType, sourceType), eq(memoryChunks.sourceId, sourceId)),
        )
        .run();
    })();
  }

  async search(
    projectId: string,
    query: string,
    limit = 12,
    beforeEpisodeNumber?: number,
  ): Promise<MemorySearchResult[]> {
    const clean = query.trim();
    if (!clean) return [];
    const candidates = new Map<
      string,
      { row: Omit<MemorySearchResult, 'score'>; score: number }
    >();
    const candidateLimit = 20;
    const episodeBoundarySql = beforeEpisodeNumber === undefined
      ? ''
      : `AND (
           m.source_type NOT IN ('EPISODE', 'EPISODE_SUMMARY')
           OR EXISTS (
             SELECT 1 FROM episodes boundary_episode
             WHERE boundary_episode.id = m.source_id
               AND boundary_episode.project_id = ?
               AND boundary_episode.deleted_at IS NULL
               AND boundary_episode.number < ?
           )
         )`;
    const addRanked = (
      rows: Array<{ id: string; sourceType: string; sourceId: string; content: string }>,
      weight: number,
    ): void => {
      rows.forEach((row, index) => {
        const current = candidates.get(row.id);
        const score = weight / (60 + index + 1);
        candidates.set(row.id, {
          row,
          score: (current?.score ?? 0) + score,
        });
      });
    };

    const tokens = [...new Set(clean.split(/\s+/).map((item) => item.replace(/["'():*+-]/g, '')).filter((item) => item.length >= 2))];
    if (tokens.length > 0) {
      const match = tokens.slice(0, 16).map((token) => `"${token.replace(/"/g, '""')}"`).join(' OR ');
      try {
        const rows = this.database.connection
          .prepare(
            `SELECT m.id, m.source_type AS sourceType, m.source_id AS sourceId, m.content
             FROM memory_chunks_fts f
             JOIN memory_chunks m ON m.id = f.chunk_id
             WHERE memory_chunks_fts MATCH ? AND (m.project_id = ? OR m.project_id IS NULL)
             ${episodeBoundarySql}
             ORDER BY bm25(memory_chunks_fts)
             LIMIT ?`,
          )
          .all(
            match,
            projectId,
            ...(beforeEpisodeNumber === undefined
              ? [candidateLimit]
              : [projectId, beforeEpisodeNumber, candidateLimit]),
          ) as Array<{
          id: string;
          sourceType: string;
          sourceId: string;
          content: string;
        }>;
        addRanked(rows, 1);
      } catch (error) {
        this.logger.warn(`FTS query failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (this.database.vectorAvailable) {
      try {
        const [vector] = await this.openRouter.embeddings([clean]);
        if (vector?.length === this.database.embeddingDimensions) {
          const blob = Buffer.from(new Float32Array(vector).buffer);
          const vectorBoundarySql = beforeEpisodeNumber === undefined
            ? ''
            : 'AND v.episode_number < ?';
          const searchPartition = (projectKey: string) =>
            this.database.connection
              .prepare(
                `SELECT m.id, m.source_type AS sourceType,
                        m.source_id AS sourceId, m.content, v.distance
                 FROM memory_chunks_vec v
                 JOIN memory_chunks m ON m.id = v.chunk_id
                 WHERE v.embedding MATCH ? AND k = ?
                   AND v.project_key = ?
                   ${vectorBoundarySql}
                 ORDER BY v.distance`,
              )
              .all(
                blob,
                candidateLimit,
                projectKey,
                ...(beforeEpisodeNumber === undefined ? [] : [BigInt(beforeEpisodeNumber)]),
              ) as Array<{
              id: string;
              sourceType: string;
              sourceId: string;
              content: string;
              distance: number;
            }>;
          const rows = [
            ...searchPartition(projectId),
            ...searchPartition('__GLOBAL__'),
          ]
            .sort((left, right) => left.distance - right.distance)
            .slice(0, candidateLimit) as Array<{
            id: string;
            sourceType: string;
            sourceId: string;
            content: string;
          }>;
          addRanked(rows, 1);
        }
      } catch (error) {
        this.logger.warn(`Vector query failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    return [...candidates.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .flatMap(({ row, score }) => {
        if (row.sourceType !== 'ARC') return [{ ...row, score }];
        // Older search chunks can contain the retired summary. Use the current plan.
        const source = this.database.orm.select({ arc: arcs, ordinal: memoryChunks.ordinal }).from(arcs)
          .innerJoin(memoryChunks, and(eq(memoryChunks.id, row.id), eq(memoryChunks.sourceId, arcs.id)))
          .where(and(eq(arcs.id, row.sourceId), eq(arcs.projectId, projectId))).get();
        const content = source ? chunkText(formatArcMemory(source.arc))[source.ordinal] : undefined;
        return content ? [{ ...row, content, score }] : [];
      });
  }

  async assemble(
    projectId: string,
    query: string,
    episodeId?: string,
    options?: { previousEpisodeScene?: boolean },
  ): Promise<AssembledMemory> {
    const project = this.database.orm
      .select()
      .from(projects)
      .where(and(eq(projects.id, projectId), isNull(projects.deletedAt)))
      .get();
    const canon = this.database.orm
      .select()
      .from(canonEntries)
      .where(
        and(
          eq(canonEntries.projectId, projectId),
          or(eq(canonEntries.status, 'ACTIVE'), eq(canonEntries.status, 'ACCEPTED')),
        ),
      )
      .all();
    const currentArc = this.database.orm
      .select()
      .from(arcs)
      .where(
        and(
          eq(arcs.projectId, projectId),
          eq(arcs.status, 'ACTIVE'),
        ),
      )
      .get();
    if (!project) throw new NotFoundException('Project not found');
    const currentEpisode = episodeId
      ? this.database.orm
          .select({ number: episodes.number, content: episodes.content })
          .from(episodes)
          .where(and(eq(episodes.id, episodeId), eq(episodes.projectId, projectId)))
          .get()
      : undefined;
    const historyFilter = `${currentEpisode ? 'AND e.number < ?' : ''}`;
    const recentSql = `SELECT e.number, e.title, s.* FROM episodes e
         JOIN episode_summaries s ON s.episode_id = e.id
         WHERE e.project_id = ? AND e.deleted_at IS NULL
           AND e.status = 'CONFIRMED' AND s.source_revision = e.revision
         ${historyFilter}
         ORDER BY e.number DESC LIMIT 5`;
    const recent = this.database.connection
      .prepare(recentSql)
      .all(...(currentEpisode ? [projectId, currentEpisode.number] : [projectId])) as Array<Record<string, unknown>>;
    const ledger = this.database.connection
      .prepare(
        `SELECT s.foreshadowing_introduced_json, s.foreshadowing_resolved_json
         FROM episodes e JOIN episode_summaries s ON s.episode_id = e.id
         WHERE e.project_id = ? AND e.deleted_at IS NULL
           AND e.status = 'CONFIRMED' AND s.source_revision = e.revision
           ${historyFilter}
         ORDER BY e.number`,
      )
      .all(...(currentEpisode ? [projectId, currentEpisode.number] : [projectId])) as Array<Record<string, unknown>>;
    const accepted = this.database.orm
      .select()
      .from(improvements)
      .where(
        and(
          eq(improvements.active, true),
          or(isNull(improvements.projectId), eq(improvements.projectId, projectId)),
        ),
      )
      .all();
    const scene = episodeId && !options?.previousEpisodeScene
      ? this.database.connection
          .prepare(
            `SELECT s.episode_id AS episodeId, s.location,
                    s.story_time AS storyTime, s.point_of_view AS pointOfView,
                    s.character_names_json AS characterNamesJson, s.goal,
                    s.source_revision AS sourceRevision, s.updated_at AS updatedAt,
                    e.content AS episode_content
             FROM scene_states s
             JOIN episodes e ON e.id = s.episode_id
             WHERE s.episode_id = ? AND e.project_id = ? AND e.deleted_at IS NULL
               AND s.source_revision = e.revision`,
          )
          .get(episodeId, projectId) as
          | (typeof sceneStates.$inferSelect & { episode_content: string })
          | undefined
      : this.database.connection
          .prepare(
            `SELECT s.episode_id AS episodeId, s.location,
                    s.story_time AS storyTime, s.point_of_view AS pointOfView,
                    s.character_names_json AS characterNamesJson, s.goal,
                    s.source_revision AS sourceRevision, s.updated_at AS updatedAt,
                    e.content AS episode_content
             FROM scene_states s
             JOIN episodes e ON e.id = s.episode_id
             WHERE e.project_id = ? AND e.deleted_at IS NULL
               AND e.status = 'CONFIRMED' AND s.source_revision = e.revision
               ${historyFilter}
             ORDER BY e.number DESC LIMIT 1`,
          )
          .get(...(currentEpisode ? [projectId, currentEpisode.number] : [projectId])) as
          | (typeof sceneStates.$inferSelect & { episode_content: string })
          | undefined;
    const retrievalQuery = query.trim() || [
      project.title,
      project.logline,
      currentArc?.goal,
      currentArc?.conflict,
      ...recent.flatMap((row) => [
        typeof row.synopsis === 'string' ? row.synopsis : '',
        ...parseJson<string[]>(row.events_json, []),
      ]),
    ]
      .filter((value): value is string => typeof value === 'string' && value.length > 0)
      .join('\n')
      .slice(0, 8_000);
    const retrieved = await this.search(
      projectId,
      retrievalQuery,
      12,
      currentEpisode?.number,
    );
    const introduced = ledger.flatMap((row) =>
      parseJson<string[]>(row.foreshadowing_introduced_json, []),
    );
    const resolved = new Set(
      ledger.flatMap((row) => parseJson<string[]>(row.foreshadowing_resolved_json, [])),
    );

    const assembled: AssembledMemory = {
      projectContext: stringifyJson(
        project
          ? {
              title: project.title,
              logline: project.logline,
              genreTags: parseJson(project.genreTagsJson, []),
              details: parseJson(project.detailsJson, project.detailsJson),
            }
          : {},
      ),
      canon: stringifyJson(
        canon.map((entry) => ({
          ref: `canon:${entry.id}`,
          category: entry.category,
          name: entry.name,
          aliases: parseJson(entry.aliasesJson, []),
          content: entry.content,
        })),
      ),
      currentArc: stringifyJson(
        currentArc
          ? {
              ref: `arc:${currentArc.id}`,
              title: currentArc.title,
              range: [currentArc.startEpisodeNumber, currentArc.endEpisodeNumber],
              goal: currentArc.goal,
              conflict: currentArc.conflict,
              reversalPlan: parseJson(currentArc.reversalPlanJson, []),
            }
          : null,
      ),
      currentScene: stringifyJson(
        scene
          ? {
              location: scene.location || null,
              time: scene.storyTime || null,
              pointOfView: scene.pointOfView || null,
              characters: parseJson(scene.characterNamesJson, []),
              goal: scene.goal || null,
              previousParagraph: extractLastParagraph(scene.episode_content),
            }
          : null,
      ),
      recentSummaries: stringifyJson(recent),
      openForeshadowing: stringifyJson(introduced.filter((item) => !resolved.has(item))),
      retrievedMemories: stringifyJson(
        retrieved.map((item) => ({
          ref: `${item.sourceType}:${item.sourceId}`,
          content: item.content,
        })),
      ),
      improvements: stringifyJson(
        accepted.map((item) => ({
          ref: `improvement:${item.id}`,
          scope: item.scope,
          rule: item.rule,
          rationale: item.rationale,
        })),
      ),
    };
    const mandatoryCharacters = [
      assembled.projectContext,
      assembled.canon,
      assembled.currentArc,
      assembled.currentScene,
      assembled.improvements,
    ].reduce((total, value) => total + value.length, 0);
    const maximum = Number.parseInt(
      process.env.AI_MANDATORY_CONTEXT_MAX_CHARS ?? '400000',
      10,
    );
    if (mandatoryCharacters > maximum) {
      throw new PayloadTooLargeException(
        `Mandatory Canon/arc/scene/improvement context is ${mandatoryCharacters} characters, exceeding ${maximum}; no required memory was silently dropped`,
      );
    }
    return assembled;
  }

  async reindexProject(projectId: string): Promise<{ indexedSources: number; indexed: number }> {
    const project = this.database.orm
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, projectId), isNull(projects.deletedAt)))
      .get();
    if (!project) {
      throw new NotFoundException('Project not found');
    }
    const old = this.database.orm
      .select({ id: memoryChunks.id })
      .from(memoryChunks)
      .where(eq(memoryChunks.projectId, projectId))
      .all();
    this.database.connection.transaction(() => {
      for (const chunk of old) {
        this.database.connection
          .prepare('DELETE FROM memory_chunks_fts WHERE chunk_id = ?')
          .run(chunk.id);
        if (this.database.vectorAvailable) {
          this.database.connection
            .prepare('DELETE FROM memory_chunks_vec WHERE chunk_id = ?')
            .run(chunk.id);
        }
      }
      this.database.orm.delete(memoryChunks).where(eq(memoryChunks.projectId, projectId)).run();
    })();

    const sources: Array<{
      projectId: string | null;
      sourceType: string;
      sourceId: string;
      text: string;
      expectedEpisode?: { number: number; revision: number };
    }> = [];
    for (const entry of this.database.orm
      .select()
      .from(canonEntries)
      .where(
        and(
          eq(canonEntries.projectId, projectId),
          or(eq(canonEntries.status, 'ACTIVE'), eq(canonEntries.status, 'ACCEPTED')),
        ),
      )
      .all()) {
      sources.push({
        projectId,
        sourceType: 'CANON',
        sourceId: entry.id,
        text: `${entry.category}: ${entry.name}\n${entry.content}`,
      });
    }
    for (const arc of this.database.orm.select().from(arcs).where(eq(arcs.projectId, projectId)).all()) {
      sources.push({
        projectId,
        sourceType: 'ARC',
        sourceId: arc.id,
        text: formatArcMemory(arc),
      });
    }
    for (const improvement of this.database.orm
      .select()
      .from(improvements)
      .where(
        and(
          or(isNull(improvements.projectId), eq(improvements.projectId, projectId)),
          eq(improvements.active, true),
        ),
      )
      .all()) {
      sources.push({
        projectId: improvement.projectId,
        sourceType: 'IMPROVEMENT',
        sourceId: improvement.id,
        text: `${improvement.title}\n${improvement.rule}\n${improvement.rationale}`,
      });
    }
    const finalized = this.database.orm
      .select()
      .from(episodes)
      .where(
        and(
          eq(episodes.projectId, projectId),
          eq(episodes.status, 'CONFIRMED'),
          isNull(episodes.deletedAt),
        ),
      )
      .all();
    for (const episode of finalized) {
      sources.push({
        projectId,
        sourceType: 'EPISODE',
        sourceId: episode.id,
        text: `${episode.number}화 ${episode.title}\n${episode.direction}\n${episode.content}`,
        expectedEpisode: { number: episode.number, revision: episode.revision },
      });
      const summary = this.database.orm
        .select()
        .from(episodeSummaries)
        .where(eq(episodeSummaries.episodeId, episode.id))
        .get();
      if (summary && summary.sourceRevision === episode.revision) {
        sources.push({
          projectId,
          sourceType: 'EPISODE_SUMMARY',
          sourceId: episode.id,
          expectedEpisode: { number: episode.number, revision: episode.revision },
          text: [
            ...parseJson<string[]>(summary.eventsJson, []),
            ...parseJson<Array<{ character: string; from: string; to: string; cause: string }>>(
              summary.emotionalChangesJson,
              [],
            ).map(
              (change) =>
                `${change.character}: ${change.from} → ${change.to} (${change.cause})`,
            ),
            ...parseJson<string[]>(summary.foreshadowingIntroducedJson, []).map((item) => `새 떡밥: ${item}`),
            ...parseJson<string[]>(summary.foreshadowingResolvedJson, []).map((item) => `회수된 떡밥: ${item}`),
          ].join('\n'),
        });
      }
    }
    for (const source of sources) {
      await this.indexSource(source);
    }
    return { indexedSources: sources.length, indexed: sources.length };
  }

  async reindexGlobalImprovements(): Promise<{ indexedSources: number; indexed: number }> {
    const chunks = this.database.orm
      .select({ id: memoryChunks.id })
      .from(memoryChunks)
      .where(
        and(
          eq(memoryChunks.sourceType, 'IMPROVEMENT'),
          isNull(memoryChunks.projectId),
        ),
      )
      .all();
    this.database.connection.transaction(() => {
      for (const chunk of chunks) {
        this.database.connection
          .prepare('DELETE FROM memory_chunks_fts WHERE chunk_id = ?')
          .run(chunk.id);
        if (this.database.vectorAvailable) {
          this.database.connection
            .prepare('DELETE FROM memory_chunks_vec WHERE chunk_id = ?')
            .run(chunk.id);
        }
      }
      this.database.orm
        .delete(memoryChunks)
        .where(
          and(
            eq(memoryChunks.sourceType, 'IMPROVEMENT'),
            isNull(memoryChunks.projectId),
          ),
        )
        .run();
    })();
    const active = this.database.orm
      .select()
      .from(improvements)
      .where(and(eq(improvements.active, true), isNull(improvements.projectId)))
      .all();
    for (const improvement of active) {
      await this.indexSource({
        projectId: null,
        sourceType: 'IMPROVEMENT',
        sourceId: improvement.id,
        text: `${improvement.title}\n${improvement.rule}\n${improvement.rationale}`,
      });
    }
    return { indexedSources: active.length, indexed: active.length };
  }
}
