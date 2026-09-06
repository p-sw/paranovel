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
import { formatCanonMemory } from './canon-memory';
import {
  arcs,
  canonEntries,
  episodeSummaries,
  episodes,
  improvements,
  memoryChunks,
  projects,
  sceneStates,
  sideStoryGroups,
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
  writingDirection: string;
  canon: string;
  currentArc: string;
  currentScene: string;
  recentSummaries: string;
  openForeshadowing: string;
  retrievedMemories: string;
  improvements: string;
}

export interface NarrativeContext {
  kind: 'SIDE_STORY';
  sideStoryGroupId: string | null;
  branchFromEpisodeId: string | null;
}

export interface MemoryAssemblyOptions {
  previousEpisodeScene?: boolean;
  narrativeContext?: NarrativeContext;
}

type EpisodeRow = typeof episodes.$inferSelect;
type GroupRow = typeof sideStoryGroups.$inferSelect;

interface ResolvedNarrative {
  kind: 'MAIN' | 'SIDE_STORY';
  group: GroupRow | null;
  currentEpisode: EpisodeRow | null;
  branchEpisode: EpisodeRow | null;
  mainBoundary: number | null;
  mainBoundaryInclusive: boolean;
  sideStoryBoundary: number | null;
  flowKey: string;
}

interface FlowSearchOptions {
  narrative: ResolvedNarrative;
}

interface IndexedSourceSnapshot {
  flowKey: string;
  flowPosition: number | null;
  fingerprint: string | null;
  projectId: string | null | undefined;
  status?: string;
}

interface RankedMemoryRow {
  id: string;
  sourceType: string;
  sourceId: string;
  content: string;
  flowKey: string;
  flowPosition: number | null;
}

interface SceneMemoryRow {
  episodeId: string;
  location: string;
  storyTime: string;
  pointOfView: string;
  characterNamesJson: string;
  goal: string;
  sourceRevision: number;
  updatedAt: string;
  episode_content: string;
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
    sideStoryGroupId?: string | null;
    sourceType: string;
    sourceId: string;
    text: string;
    expectedEpisode?: { number: number | null; revision: number };
  }): Promise<void> {
    const pieces = chunkText(input.text);
    const source = this.indexedSourceSnapshot(input.sourceType, input.sourceId);
    if (source.fingerprint !== null && input.projectId !== source.projectId) {
      return;
    }
    if (input.sourceType === 'ARC' && !['ACTIVE', 'COMPLETE'].includes(source.status ?? '')) {
      return;
    }
    if (input.sideStoryGroupId !== undefined && source.fingerprint !== null) {
      const expectedFlow = input.sideStoryGroupId ? `GROUP:${input.sideStoryGroupId}`
        : input.sourceType === 'ARC' ? 'MAIN' : 'SHARED';
      if (source.flowKey !== expectedFlow) return;
    }
    if (['EPISODE', 'EPISODE_SUMMARY'].includes(input.sourceType)) {
      const episode = this.liveEpisode(input.sourceId);
      if (!episode || episode.projectId !== input.projectId ||
        (input.expectedEpisode && (episode.number !== input.expectedEpisode.number ||
          episode.revision !== input.expectedEpisode.revision))) return;
    }
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
      // Embeddings may finish after a reorder, edit, scope move, or deletion.
      // Never restore stale chunks or delete a newer index written meanwhile.
      if (!this.indexedSourceStillCurrent(input.sourceType, input.sourceId, source)) return;
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
            flowKey: source.flowKey,
            flowPosition: source.flowPosition,
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
                 chunk_id, project_key, flow_key, flow_position, embedding
               ) VALUES (?, ?, ?, ?, ?)`,
            )
            .run(
              chunkId,
              input.projectId ?? '__GLOBAL__',
              source.flowKey,
              BigInt(source.flowPosition ?? 0),
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
    flowOptions?: FlowSearchOptions,
  ): Promise<MemorySearchResult[]> {
    const clean = query.trim();
    if (!clean) return [];
    const narrative = flowOptions?.narrative ?? this.mainNarrative(beforeEpisodeNumber ?? null);
    const candidates = new Map<
      string,
      { row: Omit<MemorySearchResult, 'score'>; score: number }
    >();
    const candidateLimit = Math.min(500, Math.max(100, limit * 20));
    const addRanked = (
      rows: Array<{ id: string; sourceType: string; sourceId: string; content: string }>,
      weight: number,
    ): void => {
      rows.forEach((row, index) => {
        const current = candidates.get(row.id);
        const score = weight / (60 + index + 1);
        candidates.set(row.id, {
          row: {
            id: row.id,
            sourceType: row.sourceType,
            sourceId: row.sourceId,
            content: row.content,
          },
          score: (current?.score ?? 0) + score,
        });
      });
    };

    const tokens = [...new Set(clean.split(/\s+/).map((item) => item.replace(/["'():*+-]/g, '')).filter((item) => item.length >= 2))];
    if (tokens.length > 0) {
      const match = tokens.slice(0, 16).map((token) => `"${token.replace(/"/g, '""')}"`).join(' OR ');
      const flow = this.memoryFlowPredicate(narrative, 'm');
      try {
        const rows = this.database.connection
          .prepare(
            `SELECT m.id, m.source_type AS sourceType, m.source_id AS sourceId,
                    m.content, m.flow_key AS flowKey, m.flow_position AS flowPosition
             FROM memory_chunks_fts f
             JOIN memory_chunks m ON m.id = f.chunk_id
             WHERE memory_chunks_fts MATCH ? AND (m.project_id = ? OR m.project_id IS NULL)
               AND (${flow.sql})
               AND (m.source_type != 'ARC' OR EXISTS (
                 SELECT 1 FROM arcs searchable_arc
                 WHERE searchable_arc.id = m.source_id
                   AND searchable_arc.project_id = ?
                   AND searchable_arc.status IN ('ACTIVE', 'COMPLETE')
               ))
             ORDER BY bm25(memory_chunks_fts)
             LIMIT ?`,
          )
          .all(
            match,
            projectId,
            ...flow.params,
            projectId,
            candidateLimit,
          ) as RankedMemoryRow[];
        addRanked(rows.filter((row) => this.memoryRowAllowed(row, narrative)), 1);
      } catch (error) {
        this.logger.warn(`FTS query failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (this.database.vectorAvailable) {
      try {
        const [vector] = await this.openRouter.embeddings([clean]);
        if (vector?.length === this.database.embeddingDimensions) {
          const blob = Buffer.from(new Float32Array(vector).buffer);
          const searchPartition = (partition: {
            projectKey: string;
            flowKey: string;
            boundary?: number;
            inclusive?: boolean;
          }) =>
            this.database.connection
              .prepare(
                `SELECT m.id, m.source_type AS sourceType,
                        m.source_id AS sourceId, m.content,
                        m.flow_key AS flowKey, m.flow_position AS flowPosition,
                        v.distance
                 FROM memory_chunks_vec v
                 JOIN memory_chunks m ON m.id = v.chunk_id
                 WHERE v.embedding MATCH ? AND k = ?
                   AND v.project_key = ?
                   AND v.flow_key = ?
                   ${partition.boundary === undefined
                     ? ''
                     : `AND v.flow_position ${partition.inclusive ? '<=' : '<'} ?`}
                   AND (m.source_type != 'ARC' OR EXISTS (
                     SELECT 1 FROM arcs searchable_arc
                     WHERE searchable_arc.id = m.source_id
                       AND searchable_arc.project_id = ?
                       AND searchable_arc.status IN ('ACTIVE', 'COMPLETE')
                   ))
                 ORDER BY v.distance`,
              )
              .all(
                blob,
                candidateLimit,
                partition.projectKey,
                partition.flowKey,
                ...(partition.boundary === undefined ? [] : [BigInt(partition.boundary)]),
                projectId,
              ) as Array<RankedMemoryRow & { distance: number }>;
          const rows = this.vectorFlowPartitions(projectId, narrative)
            .flatMap(searchPartition)
            .filter((row) => this.memoryRowAllowed(row, narrative))
            .sort((left, right) => left.distance - right.distance)
            .slice(0, candidateLimit);
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
        if (source && !['ACTIVE', 'COMPLETE'].includes(source.arc.status)) return [];
        const content = source ? chunkText(formatArcMemory(source.arc))[source.ordinal] : undefined;
        return content ? [{ ...row, content, score }] : [];
      });
  }

  async assemble(
    projectId: string,
    query: string,
    episodeId?: string,
    options?: MemoryAssemblyOptions,
  ): Promise<AssembledMemory> {
    const project = this.database.orm
      .select()
      .from(projects)
      .where(and(eq(projects.id, projectId), isNull(projects.deletedAt)))
      .get();
    if (!project) throw new NotFoundException('Project not found');
    const narrative = this.resolveNarrative(projectId, episodeId, options?.narrativeContext);
    const canonScope = narrative.group
      ? or(isNull(canonEntries.sideStoryGroupId), eq(canonEntries.sideStoryGroupId, narrative.group.id))
      : isNull(canonEntries.sideStoryGroupId);
    const canon = this.database.orm
      .select()
      .from(canonEntries)
      .where(
        and(
          eq(canonEntries.projectId, projectId),
          or(eq(canonEntries.status, 'ACTIVE'), eq(canonEntries.status, 'ACCEPTED')),
          canonScope,
        ),
      )
      .all();
    const currentArc = narrative.kind === 'SIDE_STORY' && !narrative.group
      ? undefined
      : this.database.orm
          .select()
          .from(arcs)
          .where(
            and(
              eq(arcs.projectId, projectId),
              eq(arcs.status, 'ACTIVE'),
              narrative.group
                ? eq(arcs.sideStoryGroupId, narrative.group.id)
                : isNull(arcs.sideStoryGroupId),
            ),
          )
          .get();
    const { recent, ledger } = this.narrativeHistory(projectId, narrative);
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
    const scene = this.narrativeScene(projectId, narrative, options?.previousEpisodeScene === true);
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
    const retrieved = narrative.kind === 'MAIN'
      ? await this.search(projectId, retrievalQuery, 12, narrative.mainBoundary ?? undefined)
      : await this.search(projectId, retrievalQuery, 12, undefined, { narrative });
    const introduced = ledger.flatMap((row) =>
      parseJson<string[]>(row.foreshadowing_introduced_json, []),
    );
    const resolved = new Set(
      ledger.flatMap((row) => parseJson<string[]>(row.foreshadowing_resolved_json, [])),
    );

    const storedWritingDirection = parseJson<unknown>(
      project.writingDirectionJson,
      project.writingDirectionJson,
    );
    const assembled: AssembledMemory = {
      projectContext: stringifyJson(
        project
          ? {
              title: project.title,
              logline: project.logline,
              genreTags: parseJson(project.genreTagsJson, []),
              targetEpisode: project.targetEpisode,
              targetEpisodeSource: project.targetEpisodeSource,
            }
          : {},
      ),
      writingDirection:
        typeof storedWritingDirection === 'string' ? storedWritingDirection : '',
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
      assembled.writingDirection,
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
        `Mandatory project/writing-direction/Canon/arc/scene/improvement context is ${mandatoryCharacters} characters, exceeding ${maximum}; no required memory was silently dropped`,
      );
    }
    return assembled;
  }

  private mainNarrative(beforeNumber: number | null = null): ResolvedNarrative {
    return {
      kind: 'MAIN', group: null, currentEpisode: null, branchEpisode: null,
      mainBoundary: beforeNumber, mainBoundaryInclusive: false,
      sideStoryBoundary: null, flowKey: 'MAIN',
    };
  }

  private resolveNarrative(
    projectId: string,
    episodeId?: string,
    requested?: NarrativeContext,
  ): ResolvedNarrative {
    const current = episodeId ? this.liveEpisode(episodeId, projectId) : null;
    if (episodeId && !current) throw new NotFoundException('Episode not found');
    if (current?.kind === 'MAIN') {
      if (current.number === null) throw new NotFoundException('Main episode has no number');
      return { ...this.mainNarrative(current.number), currentEpisode: current };
    }
    if (!current && !requested) return this.mainNarrative();

    const groupId = current?.sideStoryGroupId ?? requested?.sideStoryGroupId ?? null;
    const group = groupId
      ? this.database.orm.select().from(sideStoryGroups).where(and(
          eq(sideStoryGroups.id, groupId), eq(sideStoryGroups.projectId, projectId),
        )).get() ?? null
      : null;
    if (groupId && !group) throw new NotFoundException('Side-story group not found');
    if (current && current.kind !== 'SIDE_STORY') throw new NotFoundException('Episode not found');
    const branchId = group?.branchFromEpisodeId ?? current?.branchFromEpisodeId ?? requested?.branchFromEpisodeId ?? null;
    if (group && requested?.branchFromEpisodeId && requested.branchFromEpisodeId !== group.branchFromEpisodeId) {
      throw new NotFoundException('Side-story branch does not belong to the group');
    }
    const branch = branchId ? this.liveEpisode(branchId, projectId) : null;
    if (branchId && (!branch || branch.kind !== 'MAIN' || branch.number === null)) {
      throw new NotFoundException('Branch episode not found');
    }
    const sideBoundary = group
      ? current?.number ?? group.nextEpisodeNumber
      : null;
    if (group && (sideBoundary === null || sideBoundary < 1)) {
      throw new NotFoundException('Side-story episode has no group number');
    }
    return {
      kind: 'SIDE_STORY', group, currentEpisode: current, branchEpisode: branch,
      mainBoundary: branch?.number ?? null, mainBoundaryInclusive: true,
      sideStoryBoundary: sideBoundary,
      flowKey: group ? `GROUP:${group.id}` : current ? `STANDALONE:${current.id}` : 'STANDALONE:VIRTUAL',
    };
  }

  private liveEpisode(episodeId: string, projectId?: string): EpisodeRow | null {
    const row = this.database.orm.select().from(episodes).where(and(
      eq(episodes.id, episodeId),
      ...(projectId ? [eq(episodes.projectId, projectId)] : []),
      isNull(episodes.deletedAt),
    )).get();
    return row ?? null;
  }

  private narrativeHistory(projectId: string, narrative: ResolvedNarrative) {
    const summaries = (
      kind: 'MAIN' | 'SIDE_STORY',
      groupId: string | null,
      boundary: number | null,
      inclusive: boolean,
      order: 'ASC' | 'DESC',
      limit?: number,
    ) => {
      const groupClause = kind === 'MAIN'
        ? ''
        : 'AND e.side_story_group_id = ?';
      const boundaryClause = boundary === null ? '' : `AND e.number ${inclusive ? '<=' : '<'} ?`;
      return this.database.connection.prepare(
        `SELECT e.id AS episode_id, e.number, e.title, s.*
         FROM episodes e JOIN episode_summaries s ON s.episode_id = e.id
         WHERE e.project_id = ? AND e.kind = ? ${groupClause}
           AND e.deleted_at IS NULL AND e.status = 'CONFIRMED'
           AND s.source_revision = e.revision ${boundaryClause}
         ORDER BY e.number ${order}${limit ? ` LIMIT ${limit}` : ''}`,
      ).all(
        projectId,
        kind,
        ...(kind === 'SIDE_STORY' ? [groupId] : []),
        ...(boundary === null ? [] : [boundary]),
      ) as Array<Record<string, unknown>>;
    };

    if (narrative.kind === 'MAIN') {
      return {
        recent: summaries('MAIN', null, narrative.mainBoundary, false, 'DESC', 5),
        ledger: summaries('MAIN', null, narrative.mainBoundary, false, 'ASC'),
      };
    }
    const baselineRecent = narrative.branchEpisode
      ? summaries('MAIN', null, narrative.mainBoundary, true, 'DESC', 5)
      : [];
    if (narrative.branchEpisode && !baselineRecent.some((row) => row.episode_id === narrative.branchEpisode!.id)) {
      baselineRecent.unshift(this.rawEpisodeMemory(narrative.branchEpisode));
    }
    const baselineLedger = narrative.branchEpisode
      ? summaries('MAIN', null, narrative.mainBoundary, true, 'ASC')
      : [];
    if (!narrative.group) return { recent: baselineRecent.slice(0, 5), ledger: baselineLedger };
    const groupRecent = summaries(
      'SIDE_STORY', narrative.group.id, narrative.sideStoryBoundary, false, 'DESC', 5,
    );
    const groupLedger = summaries(
      'SIDE_STORY', narrative.group.id, narrative.sideStoryBoundary, false, 'ASC',
    );
    return {
      recent: [...groupRecent, ...baselineRecent].slice(0, 5),
      ledger: [...baselineLedger, ...groupLedger],
    };
  }

  private rawEpisodeMemory(episode: EpisodeRow): Record<string, unknown> {
    return {
      episode_id: episode.id,
      number: episode.number,
      title: episode.title,
      synopsis: episode.content.slice(-8_000),
      events_json: '[]', emotional_changes_json: '[]',
      foreshadowing_introduced_json: '[]', foreshadowing_resolved_json: '[]',
      source_revision: episode.revision,
      raw: true,
    };
  }

  private narrativeScene(
    projectId: string,
    narrative: ResolvedNarrative,
    previousEpisodeScene: boolean,
  ): SceneMemoryRow | null {
    if (narrative.currentEpisode && !previousEpisodeScene) {
      return this.sceneForEpisode(projectId, narrative.currentEpisode);
    }
    // Standalone side stories have no predecessor timeline of their own. When
    // starting a draft, their only eligible predecessor scene is the selected
    // main-story branch point. Once editing the story, its own scene still
    // describes the current manuscript for continue/editor operations above.
    if (narrative.kind === 'SIDE_STORY' && !narrative.group) {
      return narrative.branchEpisode
        ? this.sceneForEpisode(projectId, narrative.branchEpisode)
        : null;
    }
    if (narrative.kind === 'MAIN') {
      const boundary = narrative.mainBoundary;
      return this.latestScene(projectId, 'MAIN', null, boundary, false);
    }
    if (narrative.group) {
      const previous = this.latestScene(
        projectId, 'SIDE_STORY', narrative.group.id, narrative.sideStoryBoundary, false,
      );
      if (previous) return previous;
    }
    return narrative.branchEpisode ? this.sceneForEpisode(projectId, narrative.branchEpisode) : null;
  }

  private sceneForEpisode(projectId: string, episode: EpisodeRow): SceneMemoryRow {
    const scene = this.database.connection.prepare(
      `SELECT s.episode_id AS episodeId, s.location,
              s.story_time AS storyTime, s.point_of_view AS pointOfView,
              s.character_names_json AS characterNamesJson, s.goal,
              s.source_revision AS sourceRevision, s.updated_at AS updatedAt,
              e.content AS episode_content
       FROM scene_states s JOIN episodes e ON e.id = s.episode_id
       WHERE s.episode_id = ? AND e.project_id = ? AND e.deleted_at IS NULL
         AND s.source_revision = e.revision`,
    ).get(episode.id, projectId) as SceneMemoryRow | undefined;
    return scene ?? {
      episodeId: episode.id, location: '', storyTime: '', pointOfView: '',
      characterNamesJson: '[]', goal: '', sourceRevision: episode.revision,
      updatedAt: episode.updatedAt, episode_content: episode.content,
    };
  }

  private latestScene(
    projectId: string,
    kind: 'MAIN' | 'SIDE_STORY',
    groupId: string | null,
    boundary: number | null,
    inclusive: boolean,
  ): SceneMemoryRow | null {
    const groupClause = kind === 'SIDE_STORY' ? 'AND e.side_story_group_id = ?' : '';
    const boundaryClause = boundary === null ? '' : `AND e.number ${inclusive ? '<=' : '<'} ?`;
    const row = this.database.connection.prepare(
      `SELECT s.episode_id AS episodeId, s.location,
              s.story_time AS storyTime, s.point_of_view AS pointOfView,
              s.character_names_json AS characterNamesJson, s.goal,
              s.source_revision AS sourceRevision, s.updated_at AS updatedAt,
              e.content AS episode_content
       FROM scene_states s JOIN episodes e ON e.id = s.episode_id
       WHERE e.project_id = ? AND e.kind = ? ${groupClause}
         AND e.deleted_at IS NULL AND e.status = 'CONFIRMED'
         AND s.source_revision = e.revision ${boundaryClause}
       ORDER BY e.number DESC LIMIT 1`,
    ).get(
      projectId, kind,
      ...(kind === 'SIDE_STORY' ? [groupId] : []),
      ...(boundary === null ? [] : [boundary]),
    ) as SceneMemoryRow | undefined;
    return row ?? null;
  }

  private memoryFlowPredicate(narrative: ResolvedNarrative, alias: string) {
    const shared = `${alias}.flow_key = 'SHARED'`;
    if (narrative.kind === 'MAIN') {
      const boundary = narrative.mainBoundary;
      return boundary === null
        ? { sql: `${shared} OR ${alias}.flow_key = 'MAIN'`, params: [] as unknown[] }
        : {
            sql: `${shared} OR (${alias}.flow_key = 'MAIN' AND (${alias}.flow_position IS NULL OR ${alias}.flow_position < ?))`,
            params: [boundary] as unknown[],
          };
    }
    const clauses = [shared];
    const params: unknown[] = [];
    if (narrative.mainBoundary !== null) {
      clauses.push(`(${alias}.flow_key = 'MAIN' AND ${alias}.source_type IN ('EPISODE','EPISODE_SUMMARY') AND ${alias}.flow_position <= ?)`);
      params.push(narrative.mainBoundary);
    }
    if (narrative.group) {
      clauses.push(`(${alias}.flow_key = ? AND (${alias}.flow_position IS NULL OR ${alias}.flow_position < ?))`);
      params.push(narrative.flowKey, narrative.sideStoryBoundary);
    }
    return { sql: clauses.join(' OR '), params };
  }

  private memoryRowAllowed(row: RankedMemoryRow, narrative: ResolvedNarrative): boolean {
    if (row.flowKey === 'SHARED') return true;
    if (narrative.kind === 'MAIN') {
      return row.flowKey === 'MAIN' && (row.flowPosition === null ||
        narrative.mainBoundary === null || row.flowPosition < narrative.mainBoundary);
    }
    if (row.flowKey === 'MAIN') {
      return ['EPISODE', 'EPISODE_SUMMARY'].includes(row.sourceType) &&
        narrative.mainBoundary !== null && row.flowPosition !== null &&
        row.flowPosition <= narrative.mainBoundary;
    }
    return Boolean(narrative.group && row.flowKey === narrative.flowKey &&
      (row.flowPosition === null || (narrative.sideStoryBoundary !== null && row.flowPosition < narrative.sideStoryBoundary)));
  }

  private vectorFlowPartitions(projectId: string, narrative: ResolvedNarrative) {
    const values: Array<{
      projectKey: string;
      flowKey: string;
      boundary?: number;
      inclusive?: boolean;
    }> = [
      { projectKey: projectId, flowKey: 'SHARED' },
      { projectKey: '__GLOBAL__', flowKey: 'SHARED' },
    ];
    if (narrative.kind === 'MAIN' || narrative.mainBoundary !== null) {
      values.push({
        projectKey: projectId,
        flowKey: 'MAIN',
        ...(narrative.mainBoundary === null
          ? {}
          : { boundary: narrative.mainBoundary, inclusive: narrative.kind === 'SIDE_STORY' }),
      });
    }
    if (narrative.group) {
      values.push({
        projectKey: projectId,
        flowKey: narrative.flowKey,
        boundary: narrative.sideStoryBoundary!,
        inclusive: false,
      });
    }
    return values;
  }

  private indexedSourceSnapshot(sourceType: string, sourceId: string): IndexedSourceSnapshot {
    if (['EPISODE', 'EPISODE_SUMMARY'].includes(sourceType)) {
      const row = this.liveEpisode(sourceId);
      if (!row) return { flowKey: 'SHARED', flowPosition: null, fingerprint: '__MISSING__', projectId: undefined };
      return {
        flowKey: row.kind === 'MAIN' ? 'MAIN'
          : row.sideStoryGroupId ? `GROUP:${row.sideStoryGroupId}` : `STANDALONE:${row.id}`,
        flowPosition: row.number,
        projectId: row.projectId,
        fingerprint: stringifyJson({ projectId: row.projectId, kind: row.kind, number: row.number,
          groupId: row.sideStoryGroupId, revision: row.revision, status: row.status,
          deletedAt: row.deletedAt }),
      };
    }
    if (sourceType === 'CANON') {
      const row = this.database.orm.select().from(canonEntries).where(eq(canonEntries.id, sourceId)).get();
      if (!row) return { flowKey: 'SHARED', flowPosition: null, fingerprint: '__MISSING__', projectId: undefined };
      return { flowKey: row.sideStoryGroupId ? `GROUP:${row.sideStoryGroupId}` : 'SHARED', flowPosition: null,
        projectId: row.projectId, fingerprint: stringifyJson({ projectId: row.projectId,
          groupId: row.sideStoryGroupId, revision: row.revision, status: row.status }) };
    }
    if (sourceType === 'ARC') {
      const row = this.database.orm.select().from(arcs).where(eq(arcs.id, sourceId)).get();
      if (!row) return { flowKey: 'MAIN', flowPosition: null, fingerprint: '__MISSING__', projectId: undefined };
      return { flowKey: row.sideStoryGroupId ? `GROUP:${row.sideStoryGroupId}` : 'MAIN', flowPosition: null,
        projectId: row.projectId, status: row.status, fingerprint: stringifyJson({ projectId: row.projectId,
          groupId: row.sideStoryGroupId, revision: row.revision, status: row.status }) };
    }
    if (sourceType === 'IMPROVEMENT') {
      const row = this.database.orm.select().from(improvements).where(eq(improvements.id, sourceId)).get();
      if (!row) return { flowKey: 'SHARED', flowPosition: null, fingerprint: '__MISSING__', projectId: undefined };
      return { flowKey: 'SHARED', flowPosition: null, projectId: row.projectId,
        fingerprint: stringifyJson({ projectId: row.projectId, revision: row.revision, active: row.active }) };
    }
    return { flowKey: 'SHARED', flowPosition: null, fingerprint: null, projectId: undefined };
  }

  private indexedSourceStillCurrent(
    sourceType: string,
    sourceId: string,
    expected: IndexedSourceSnapshot,
  ): boolean {
    if (expected.fingerprint === null) return true;
    const current = this.indexedSourceSnapshot(sourceType, sourceId);
    return current.fingerprint === expected.fingerprint && current.flowKey === expected.flowKey &&
      current.flowPosition === expected.flowPosition && current.projectId === expected.projectId;
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
      expectedEpisode?: { number: number | null; revision: number };
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
        text: formatCanonMemory(entry),
      });
    }
    for (const arc of this.database.orm.select().from(arcs).where(eq(arcs.projectId, projectId)).all()) {
      if (!['ACTIVE', 'COMPLETE'].includes(arc.status)) continue;
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
      const label = episode.kind === 'MAIN'
        ? `${episode.number}화`
        : episode.sideStoryGroupId ? `외전 ${episode.number}화` : '단편 외전';
      sources.push({
        projectId,
        sourceType: 'EPISODE',
        sourceId: episode.id,
        text: `${label} ${episode.title}\n${episode.direction}\n${episode.content}`,
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
