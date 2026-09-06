import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { and, eq, gte, isNull, lt, lte, or } from 'drizzle-orm';
import { AiRunnerService } from '../ai/ai-runner.service';
import {
  continuityReviewSchema,
  continuityReviewValidator,
  episodeDirectionSchema,
  episodeDirectionValidator,
  episodeMemorySchema,
  episodeMemoryValidator,
  sceneExtractionSchema,
  sceneExtractionValidator,
} from '../ai/ai.schemas';
import type { ContinuityIssue } from '../ai/ai.types';
import { DatabaseService } from '../database/database.service';
import {
  arcs,
  canonEntries,
  episodeIdempotency,
  episodeSummaries,
  episodes,
  improvements,
  projects,
  sceneStates,
  sideStoryGroups,
} from '../database/schema';
import { MemoryService } from '../memory/memory.service';
import { ProjectsService } from '../projects/projects.service';
import {
  extractLastParagraph,
  id,
  now,
  optionalString,
  parseJson,
  positiveInteger,
  requireString,
  sha256,
  stringifyJson,
  stringArray,
} from '../shared/utils';

export type StreamEvent =
  | { type: 'meta'; runId: string; baseRevision?: number }
  | { type: 'stage'; stage: 'MEMORY' | 'WRITING' | 'CHECKING' | 'REPAIRING' }
  | { type: 'delta'; text: string }
  | { type: 'reset' }
  | { type: 'done'; content: string; blocked: boolean; issues: ContinuityIssue[]; baseRevision?: number }
  | { type: 'warning'; message: string }
  | { type: 'error'; code: string; message: string };

interface MemoryExtraction {
  events: string[];
  emotionalChanges: Array<{ character: string; from: string; to: string; cause: string }>;
  newForeshadowing: string[];
  resolvedForeshadowing: string[];
  endScene: {
    location: string | null;
    time: string | null;
    pointOfView: string | null;
    characters: string[];
    goal: string | null;
  };
  canonCandidates: Array<{
    category: string;
    name: string;
    aliases: string[];
    content: string;
    metadata: Record<string, unknown>;
  }>;
}

interface EpisodeOrderSnapshot {
  rows: Array<typeof episodes.$inferSelect>;
  slotCount: number;
  revision: string;
}

interface VirtualNarrativeContext {
  kind: 'SIDE_STORY';
  sideStoryGroupId: string | null;
  branchFromEpisodeId: string | null;
}

@Injectable()
export class EpisodesService {
  constructor(
    private readonly database: DatabaseService,
    private readonly projects: ProjectsService,
    private readonly memory: MemoryService,
    private readonly ai: AiRunnerService,
  ) {}

  list(projectId: string) {
    this.projects.get(projectId);
    return this.database.orm
      .select()
      .from(episodes)
      .where(and(
        eq(episodes.projectId, projectId),
        eq(episodes.kind, 'MAIN'),
        isNull(episodes.deletedAt),
      ))
      .orderBy(episodes.number)
      .all()
      .map((row) => this.toView(row));
  }

  order(projectId: string) {
    return this.database.connection.transaction(() => this.orderView(this.readOrder(projectId)))();
  }

  updateOrder(projectId: string, body: unknown) {
    const input = (body ?? {}) as Record<string, unknown>;
    const expectedRevision = requireString(input.expectedRevision, 'expectedRevision', { max: 64 });
    if (!Array.isArray(input.slots) || input.slots.some((slot) => slot !== null && typeof slot !== 'string')) {
      throw new BadRequestException('slots must contain episode IDs or null placeholders');
    }
    const slots = input.slots as Array<string | null>;
    return this.database.connection.transaction(() => {
      const current = this.readOrder(projectId);
      if (expectedRevision !== current.revision) {
        throw new ConflictException('회차 목록이 변경되었습니다. 최신 목록을 불러와 다시 정렬해 주세요.');
      }
      const actualIds = slots.filter((slot): slot is string => slot !== null);
      const idSet = new Set(actualIds);
      if (
        actualIds.length !== current.rows.length || idSet.size !== actualIds.length ||
        current.rows.some((row) => !idSet.has(row.id))
      ) {
        throw new BadRequestException('Every existing episode must appear exactly once');
      }
      if (slots.length > current.slotCount) {
        throw new BadRequestException('Placeholder slots cannot be added');
      }
      const newNumbers = new Map<string, number>();
      slots.forEach((episodeId, index) => {
        if (episodeId !== null) newNumbers.set(episodeId, index + 1);
      });
      const moved = current.rows.filter((row) => newNumbers.get(row.id) !== row.number);
      const firstChanged = moved.reduce(
        (earliest, row) => Math.min(earliest, row.number!, newNumbers.get(row.id)!),
        Infinity,
      );
      if (moved.length === 0 && slots.length === current.slotCount) return this.orderView(current);

      const stamp = now();
      // Positive public numbers are unique per project. Temporarily vacate all
      // moved numbers so swaps cannot violate the immediate UNIQUE constraint.
      for (const row of moved) {
        this.database.orm.update(episodes).set({ number: -row.number! })
          .where(eq(episodes.id, row.id)).run();
      }
      for (const row of current.rows) {
        const number = newNumbers.get(row.id)!;
        if (number < firstChanged) continue;
        this.database.orm.update(episodes).set({
          number,
          revision: row.revision + 1,
          status: this.editedStatus(row.status, false),
          updatedAt: stamp,
        }).where(eq(episodes.id, row.id)).run();
        this.removeEpisodeMemory(row.id);
      }
      this.database.orm.update(projects)
        .set({ nextEpisodeNumber: slots.length + 1, updatedAt: stamp })
        .where(eq(projects.id, projectId)).run();
      if (moved.length > 0) {
        this.invalidateAnchoredSideFlows(projectId, firstChanged);
      }
      return this.orderView(this.readOrder(projectId));
    }).immediate();
  }

  get(projectId: string, episodeId: string) {
    const row = this.requireEpisode(projectId, episodeId);
    return this.toView(row);
  }

  flow(projectId: string, episodeId: string) {
    const current = this.requireEpisode(projectId, episodeId);
    if (current.kind === 'MAIN') {
      return {
        kind: 'MAIN' as const,
        label: '회차',
        group: null,
        episodes: this.list(projectId),
      };
    }
    if (!current.sideStoryGroupId) {
      return {
        kind: 'SIDE_STORY' as const,
        label: '단편 외전',
        group: null,
        episodes: [this.toView(current)],
      };
    }
    const group = this.database.orm
      .select()
      .from(sideStoryGroups)
      .where(and(
        eq(sideStoryGroups.id, current.sideStoryGroupId),
        eq(sideStoryGroups.projectId, projectId),
      ))
      .get();
    if (!group) throw new NotFoundException('Side-story group not found');
    const rows = this.database.orm
      .select()
      .from(episodes)
      .where(and(
        eq(episodes.projectId, projectId),
        eq(episodes.kind, 'SIDE_STORY'),
        eq(episodes.sideStoryGroupId, group.id),
        isNull(episodes.deletedAt),
      ))
      .orderBy(episodes.number)
      .all();
    return {
      kind: 'SIDE_STORY' as const,
      label: `외전 · ${group.title}`,
      group: {
        id: group.id,
        projectId: group.projectId,
        title: group.title,
        description: group.description,
        branchFromEpisodeId: group.branchFromEpisodeId,
        nextEpisodeNumber: group.nextEpisodeNumber,
        revision: group.revision,
        createdAt: group.createdAt,
        updatedAt: group.updatedAt,
      },
      episodes: rows.map((row) => this.toView(row)),
    };
  }

  async prepareEditorAiFlowRevision(
    projectId: string,
    episodeId: string,
    expectedRevision: number,
  ): Promise<string | undefined> {
    const episode = this.requireEpisode(projectId, episodeId);
    this.assertEpisodeRevision(projectId, episodeId, expectedRevision, 'editor preparation');
    await this.refreshStalePredecessors(projectId, episode);
    this.assertEpisodeRevision(projectId, episodeId, expectedRevision, 'editor preparation');
    return this.sideFlowRevision(projectId, this.requireEpisode(projectId, episodeId));
  }

  assertSideFlowRevisionForEpisode(
    projectId: string,
    episodeId: string,
    expectedRevision: string | undefined,
  ): void {
    const episode = this.requireEpisode(projectId, episodeId);
    const currentRevision = this.sideFlowRevision(projectId, episode);
    if (currentRevision !== expectedRevision) {
      throw new ConflictException(
        '외전 흐름이 변경되었습니다. 최신 외전과 분기 회차를 확인한 뒤 다시 시도해 주세요.',
      );
    }
  }

  async create(projectId: string, body: unknown, idempotencyKey?: string) {
    const input = (body ?? {}) as Record<string, unknown>;
    const requestHash = sha256(stringifyJson(input));
    if (idempotencyKey && idempotencyKey.length > 200) throw new BadRequestException('Idempotency-Key is too long');
    return this.database.connection.transaction(() => {
      const project = this.projects.get(projectId);
      if (idempotencyKey) {
        const existing = this.database.orm.select().from(episodeIdempotency)
          .where(and(
            eq(episodeIdempotency.projectId, projectId),
            eq(episodeIdempotency.scope, 'MAIN'),
            eq(episodeIdempotency.idempotencyKey, idempotencyKey),
          )).get();
        if (existing) {
          if (existing.requestHash !== requestHash) {
            throw new ConflictException('Idempotency-Key was already used with a different request');
          }
          return this.get(projectId, existing.episodeId);
        }
      }
      const stamp = now();
      const episodeId = id();
      const content = optionalString(input.content, 'content', 1_000_000) ?? '';
      const incomplete = this.incompleteFlag(input);
      if (incomplete && content.trim()) throw new BadRequestException('An incomplete episode cannot contain content');
      const row: typeof episodes.$inferInsert = {
        id: episodeId,
        projectId,
        number: project.nextEpisodeNumber,
        kind: 'MAIN',
        sideStoryGroupId: null,
        branchFromEpisodeId: null,
        title: requireString(input.title, 'title', { max: 200 }),
        direction: optionalString(input.direction, 'direction', 20_000) ?? '',
        content,
        revision: 1,
        status: input.forceNeedsReview === true || input.force === true ? 'NEEDS_REVIEW' : incomplete ? 'INCOMPLETE' : 'DRAFT',
        createdAt: stamp,
        updatedAt: stamp,
        deletedAt: null,
      };
      this.database.orm.insert(episodes).values(row).run();
      if (idempotencyKey) {
        this.database.orm.insert(episodeIdempotency).values({
          projectId,
          scope: 'MAIN',
          idempotencyKey,
          episodeId,
          requestHash,
          createdAt: stamp,
        }).run();
      }
      this.database.orm
        .update(projects)
        .set({ nextEpisodeNumber: project.nextEpisodeNumber + 1, updatedAt: stamp })
        .where(eq(projects.id, projectId))
        .run();
      return this.toView(row as typeof episodes.$inferSelect);
    }).immediate();
  }

  async update(projectId: string, episodeId: string, body: unknown) {
    return this.updateSavedDraft(projectId, episodeId, body);
  }

  // Synchronous so an editor edit and its application receipt can be committed together.
  updateSavedDraft(projectId: string, episodeId: string, body: unknown) {
    return this.database.connection.transaction(() => {
      const current = this.requireEpisode(projectId, episodeId);
      const input = (body ?? {}) as Record<string, unknown>;
      const expectedRevision = positiveInteger(input.expectedRevision, 'expectedRevision');
      const changes: Partial<typeof episodes.$inferInsert> = {
        revision: current.revision + 1,
        updatedAt: now(),
      };
      const narrativeEdit = 'title' in input || 'direction' in input || 'content' in input;
      if ('title' in input) changes.title = requireString(input.title, 'title', { max: 200 });
      if ('direction' in input) changes.direction = optionalString(input.direction, 'direction', 20_000) ?? '';
      if ('content' in input) {
        changes.content = optionalString(input.content, 'content', 1_000_000) ?? '';
      }
      if (input.forceNeedsReview !== undefined && typeof input.forceNeedsReview !== 'boolean') {
        throw new BadRequestException('forceNeedsReview must be a boolean');
      }
      const incomplete = this.incompleteFlag(input);
      const content = changes.content ?? current.content;
      if (incomplete && content.trim()) throw new BadRequestException('An incomplete episode cannot contain content');
      const statusEdit = input.forceNeedsReview === true
        || (incomplete !== undefined && (incomplete || current.status === 'INCOMPLETE'));
      if (narrativeEdit || statusEdit) {
        const remainsIncomplete = incomplete ?? (current.status === 'INCOMPLETE' && !content.trim());
        changes.status = input.forceNeedsReview === true || current.status === 'NEEDS_REVIEW'
          ? 'NEEDS_REVIEW'
          : remainsIncomplete ? 'INCOMPLETE'
            : current.status === 'INCOMPLETE' ? 'DRAFT' : this.editedStatus(current.status, false);
      }
      if (!narrativeEdit && !statusEdit) {
        throw new BadRequestException('At least one editable field is required');
      }
      const result = this.database.orm
        .update(episodes)
        .set(changes)
        .where(
          and(
            eq(episodes.id, episodeId),
            eq(episodes.projectId, projectId),
            eq(episodes.revision, expectedRevision),
            isNull(episodes.deletedAt),
          ),
        )
        .run();
      if (result.changes !== 1) throw new ConflictException('Episode revision is stale');
      const updated = this.requireEpisode(projectId, episodeId);
      // Every accepted update advances the source revision or status. Remove
      // now-stale chunks and propagate that change through the scoped flow,
      // including status-only review/incomplete transitions.
      this.removeEpisodeMemory(episodeId);
      this.invalidateFollowing(current);
      return this.toView(updated);
    }).immediate();
  }

  remove(projectId: string, episodeId: string, body: unknown): void {
    const input = (body ?? {}) as Record<string, unknown>;
    const expectedRevision = positiveInteger(input.expectedRevision, 'expectedRevision');
    this.database.connection.transaction(() => {
      const current = this.requireEpisode(projectId, episodeId);
      if (expectedRevision !== current.revision) {
        throw new ConflictException('Episode revision is stale');
      }
      this.removeEpisodeMemory(episodeId);
      if (current.kind === 'MAIN') {
        // Resolve branch dependencies while the anchor still exists. The FK's
        // SET NULL action alone would otherwise change side-story topology
        // without invalidating memory or optimistic concurrency tokens.
        this.invalidateFollowing(current);
        this.detachDirectSideBranches(current);
      } else if (current.sideStoryGroupId) {
        this.invalidateFollowing(current);
      }
      this.database.orm.delete(episodes).where(eq(episodes.id, episodeId)).run();
      if (current.kind === 'MAIN') {
        const project = this.projects.get(projectId);
        this.database.orm.update(projects).set({
          nextEpisodeNumber: current.number === project.nextEpisodeNumber - 1
            ? project.nextEpisodeNumber - 1 : project.nextEpisodeNumber,
          updatedAt: now(),
        }).where(eq(projects.id, projectId)).run();
      } else if (current.sideStoryGroupId) {
        const group = this.database.orm.select().from(sideStoryGroups)
          .where(and(
            eq(sideStoryGroups.id, current.sideStoryGroupId),
            eq(sideStoryGroups.projectId, projectId),
          )).get();
        if (group) {
          this.database.orm.update(sideStoryGroups).set({
            nextEpisodeNumber: current.number === group.nextEpisodeNumber - 1
              ? group.nextEpisodeNumber - 1 : group.nextEpisodeNumber,
            updatedAt: now(),
          }).where(eq(sideStoryGroups.id, group.id)).run();
        }
      }
    }).immediate();
  }

  async propose(projectId: string, body: unknown) {
    const input = (body ?? {}) as Record<string, unknown>;
    const hint = optionalString(input.hint, 'hint', 5_000) ?? '';
    const episode = this.requestedDraftEpisode(projectId, input);
    const narrativeContext = this.virtualNarrativeContext(projectId, input, episode);
    const orderRevision = this.mainOrderRevision(projectId, episode, narrativeContext);
    await this.refreshStalePredecessors(projectId, episode, narrativeContext);
    const flowRevision = this.sideFlowRevision(projectId, episode, narrativeContext);
    const memory = await this.assembleDraftMemory(projectId, hint, episode?.id, narrativeContext);
    if (orderRevision) this.assertOrderRevision(projectId, orderRevision);
    if (flowRevision) this.assertSideFlowRevision(projectId, flowRevision, episode, narrativeContext);
    const { value } = await this.ai.completeJson<{
      title: string;
      direction: string;
      conflicts: string[];
    }>({
      task: 'episode_direction',
      promptId: 'episode-direction',
      projectId,
      episodeId: episode?.id,
      variables: this.promptMemory(memory, {
        user_request: hint,
      }),
      schema: { name: 'episode_direction', value: episodeDirectionSchema },
      validator: episodeDirectionValidator,
      maxTokens: 3_000,
    });
    if (orderRevision) this.assertOrderRevision(projectId, orderRevision);
    if (flowRevision) this.assertSideFlowRevision(projectId, flowRevision, episode, narrativeContext);
    return value;
  }

  async refine(projectId: string, body: unknown) {
    this.projects.get(projectId);
    const input = (body ?? {}) as Record<string, unknown>;
    // Keep the user's formatting intact while validating required, bounded text.
    const title = optionalString(input.title, 'title', 200) ?? '';
    const direction = optionalString(input.direction, 'direction', 20_000) ?? '';
    requireString(title, 'title', { max: 200 });
    requireString(direction, 'direction', { max: 20_000 });
    const instruction = requireString(optionalString(input.instruction, 'instruction', 5_000), 'instruction', { max: 5_000 });
    const episode = this.requestedDraftEpisode(projectId, input);
    const narrativeContext = this.virtualNarrativeContext(projectId, input, episode);
    const orderRevision = this.mainOrderRevision(projectId, episode, narrativeContext);
    await this.refreshStalePredecessors(projectId, episode, narrativeContext);
    const flowRevision = this.sideFlowRevision(projectId, episode, narrativeContext);
    const memory = await this.assembleDraftMemory(
      projectId,
      `${instruction}\n${title}\n${direction}`,
      episode?.id,
      narrativeContext,
    );
    if (orderRevision) this.assertOrderRevision(projectId, orderRevision);
    if (flowRevision) this.assertSideFlowRevision(projectId, flowRevision, episode, narrativeContext);
    const { value } = await this.ai.completeJson<{
      title: string;
      direction: string;
      conflicts: string[];
    }>({
      task: 'episode_direction_refine',
      promptId: 'episode-direction-refine',
      projectId,
      episodeId: episode?.id,
      variables: this.promptMemory(memory, {
        episode_title: title,
        episode_direction: direction,
        refinement_instruction: instruction,
      }),
      schema: { name: 'episode_direction', value: episodeDirectionSchema },
      validator: episodeDirectionValidator,
      maxTokens: Math.max(3_000, (title.length + direction.length) * 2 + 1_000),
    });
    if (orderRevision) this.assertOrderRevision(projectId, orderRevision);
    if (flowRevision) this.assertSideFlowRevision(projectId, flowRevision, episode, narrativeContext);
    return value;
  }

  async generate(
    projectId: string,
    body: unknown,
    emit: (event: StreamEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const project = this.projects.get(projectId);
    const input = (body ?? {}) as Record<string, unknown>;
    const title = requireString(input.title, 'title', { max: 200 });
    const direction = requireString(input.direction, 'direction', { max: 20_000 });
    const targetChars = this.targetChars(input.targetChars, project.defaultTargetChars);
    const episode = this.requestedDraftEpisode(projectId, input, true);
    const narrativeContext = this.virtualNarrativeContext(projectId, input, episode);
    const orderRevision = this.mainOrderRevision(projectId, episode, narrativeContext);
    signal?.throwIfAborted();
    await this.refreshStalePredecessors(projectId, episode, narrativeContext);
    const flowRevision = this.sideFlowRevision(projectId, episode, narrativeContext);
    signal?.throwIfAborted();
    emit({ type: 'stage', stage: 'MEMORY' });
    const memory = await this.assembleDraftMemory(
      projectId,
      `${title}\n${direction}`,
      episode?.id,
      narrativeContext,
    );
    signal?.throwIfAborted();
    if (orderRevision) this.assertOrderRevision(projectId, orderRevision);
    if (flowRevision) this.assertSideFlowRevision(projectId, flowRevision, episode, narrativeContext);
    emit({ type: 'stage', stage: 'WRITING' });
    await this.streamWithContinuity(
      {
        projectId,
        episodeId: episode?.id,
        baseRevision: episode?.revision,
        ...(orderRevision ? { baseOrderRevision: orderRevision } : {}),
        ...(flowRevision ? {
          baseFlowRevision: flowRevision,
          flowEpisode: episode,
          flowContext: narrativeContext,
        } : {}),
        promptId: 'episode-draft',
        task: 'episode_draft',
        variables: this.promptMemory(memory, {
          episode_title: title,
          episode_direction: direction,
          target_length: targetChars,
          current_scene: memory.currentScene,
        }),
        reviewVariables: this.promptMemory(memory, {
          episode_title: title,
          episode_direction: direction,
          boundary_context: '새 회차 전체 초안',
        }),
      },
      emit,
      signal,
    );
  }

  async continue(
    projectId: string,
    episodeId: string,
    body: unknown,
    emit: (event: StreamEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const episode = this.requireEpisode(projectId, episodeId);
    const input = (body ?? {}) as Record<string, unknown>;
    const expectedRevision = positiveInteger(input.expectedRevision, 'expectedRevision');
    if (expectedRevision !== episode.revision) throw new ConflictException('Episode revision is stale');
    const cursorOffset = positiveInteger(input.cursorOffset, 'cursorOffset');
    if (cursorOffset > episode.content.length) throw new BadRequestException('cursorOffset is outside the episode');
    const before = episode.content.slice(0, cursorOffset);
    const after = episode.content.slice(cursorOffset);
    await this.refreshStalePredecessors(projectId, episode);
    const sceneFlowRevision = this.sideFlowRevision(projectId, episode);
    await this.ensureScene(
      projectId,
      episode,
      before,
      signal,
      sceneFlowRevision
        ? () => this.assertSideFlowRevision(projectId, sceneFlowRevision, episode)
        : undefined,
    );
    const flowRevision = this.sideFlowRevision(projectId, episode);
    emit({ type: 'stage', stage: 'MEMORY' });
    const memory = await this.memory.assemble(projectId, `${episode.direction}\n${extractLastParagraph(before)}`, episodeId);
    memory.currentScene = stringifyJson({
      ...parseJson<Record<string, unknown>>(memory.currentScene, {}),
      previousParagraph: extractLastParagraph(before),
    });
    this.assertEpisodeRevision(projectId, episodeId, expectedRevision);
    if (flowRevision) this.assertSideFlowRevision(projectId, flowRevision, episode);
    emit({ type: 'stage', stage: 'WRITING' });
    await this.streamWithContinuity(
      {
        projectId,
        episodeId,
        baseRevision: episode.revision,
        ...(flowRevision ? { baseFlowRevision: flowRevision, flowEpisode: episode } : {}),
        promptId: 'episode-continue',
        task: 'episode_continue',
        variables: this.promptMemory(memory, {
          episode_title: episode.title,
          episode_direction: episode.direction,
          text_before_cursor: before.slice(-16_000),
          text_after_cursor: after.slice(0, 8_000),
          previous_paragraph: extractLastParagraph(before),
          current_text: episode.content,
          target_length: this.targetChars(input.targetChars, 1_500),
          requested_length: this.targetChars(input.targetChars, 1_500),
        }),
        reviewVariables: this.promptMemory(memory, {
          episode_title: episode.title,
          episode_direction: episode.direction,
          text_before_cursor: before.slice(-16_000),
          text_after_cursor: after.slice(0, 8_000),
          boundary_context: stringifyJson({
            textBeforeCursor: before.slice(-4_000),
            textAfterCursor: after.slice(0, 4_000),
            insertionPoint: before.length,
          }),
        }),
      },
      emit,
      signal,
    );
  }

  async repairDraft(
    projectId: string,
    body: unknown,
    emit: (event: StreamEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    this.projects.get(projectId);
    const input = (body ?? {}) as Record<string, unknown>;
    const title = requireString(input.title, 'title', { max: 200 });
    const direction = requireString(input.direction, 'direction', { max: 20_000 });
    const { content, issue } = this.repairInput(input);
    const episode = this.requestedDraftEpisode(projectId, input, true, false);
    const narrativeContext = this.virtualNarrativeContext(projectId, input, episode);
    const orderRevision = this.mainOrderRevision(projectId, episode, narrativeContext);
    signal?.throwIfAborted();
    emit({ type: 'stage', stage: 'MEMORY' });
    await this.refreshStalePredecessors(projectId, episode, narrativeContext);
    const flowRevision = this.sideFlowRevision(projectId, episode, narrativeContext);
    signal?.throwIfAborted();
    const memory = await this.assembleDraftMemory(
      projectId,
      `${title}\n${direction}`,
      episode?.id,
      narrativeContext,
    );
    if (orderRevision) this.assertOrderRevision(projectId, orderRevision);
    if (flowRevision) this.assertSideFlowRevision(projectId, flowRevision, episode, narrativeContext);
    await this.repairSelectedIssue({
      projectId,
      episodeId: episode?.id,
      baseRevision: episode?.revision,
      ...(orderRevision ? { baseOrderRevision: orderRevision } : {}),
      ...(flowRevision ? {
        baseFlowRevision: flowRevision,
        flowEpisode: episode,
        flowContext: narrativeContext,
      } : {}),
      content,
      issue,
      reviewVariables: this.promptMemory(memory, {
        episode_title: title,
        episode_direction: direction,
        boundary_context: '새 회차 전체 초안',
      }),
    }, emit, signal);
  }

  async repairContinuation(
    projectId: string,
    episodeId: string,
    body: unknown,
    emit: (event: StreamEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const episode = this.requireEpisode(projectId, episodeId);
    const input = (body ?? {}) as Record<string, unknown>;
    const expectedRevision = positiveInteger(input.expectedRevision, 'expectedRevision');
    if (expectedRevision !== episode.revision) throw new ConflictException('Episode revision is stale');
    const cursorOffset = positiveInteger(input.cursorOffset, 'cursorOffset');
    if (cursorOffset > episode.content.length) throw new BadRequestException('cursorOffset is outside the episode');
    const { content, issue } = this.repairInput(input);
    const before = episode.content.slice(0, cursorOffset);
    const after = episode.content.slice(cursorOffset);
    signal?.throwIfAborted();
    emit({ type: 'stage', stage: 'MEMORY' });
    await this.refreshStalePredecessors(projectId, episode);
    const sceneFlowRevision = this.sideFlowRevision(projectId, episode);
    signal?.throwIfAborted();
    await this.ensureScene(
      projectId,
      episode,
      before,
      signal,
      sceneFlowRevision
        ? () => this.assertSideFlowRevision(projectId, sceneFlowRevision, episode)
        : undefined,
    );
    const flowRevision = this.sideFlowRevision(projectId, episode);
    signal?.throwIfAborted();
    const memory = await this.memory.assemble(projectId, `${episode.direction}\n${extractLastParagraph(before)}`, episodeId);
    memory.currentScene = stringifyJson({
      ...parseJson<Record<string, unknown>>(memory.currentScene, {}),
      previousParagraph: extractLastParagraph(before),
    });
    this.assertEpisodeRevision(projectId, episodeId, expectedRevision);
    if (flowRevision) this.assertSideFlowRevision(projectId, flowRevision, episode);
    await this.repairSelectedIssue({
      projectId,
      episodeId,
      baseRevision: expectedRevision,
      ...(flowRevision ? { baseFlowRevision: flowRevision, flowEpisode: episode } : {}),
      content,
      issue,
      reviewVariables: this.promptMemory(memory, {
        episode_title: episode.title,
        episode_direction: episode.direction,
        text_before_cursor: before.slice(-16_000),
        text_after_cursor: after.slice(0, 8_000),
        boundary_context: stringifyJson({
          textBeforeCursor: before.slice(-4_000),
          textAfterCursor: after.slice(0, 4_000),
          insertionPoint: cursorOffset,
        }),
      }),
    }, emit, signal);
  }

  async replaceSelection(projectId: string, episodeId: string, body: unknown) {
    return this.database.connection.transaction(() => {
      const current = this.requireEpisode(projectId, episodeId);
      const input = (body ?? {}) as Record<string, unknown>;
      const expectedRevision = positiveInteger(input.expectedRevision, 'expectedRevision');
      if (expectedRevision !== current.revision) throw new ConflictException('Episode revision is stale');
      const start = positiveInteger(input.start, 'start');
      const end = positiveInteger(input.end, 'end');
      if (start >= end || end > current.content.length) throw new BadRequestException('Invalid selection range');
      const selectedText = optionalString(input.selectedText, 'selectedText', 200_000) ?? '';
      if (!selectedText) throw new BadRequestException('selectedText is required');
      const replacement = optionalString(input.replacement, 'replacement', 200_000) ?? '';
      if (current.content.slice(start, end) !== selectedText) throw new ConflictException('Selected text no longer matches');
      const content = `${current.content.slice(0, start)}${replacement}${current.content.slice(end)}`;
      const result = this.database.orm
        .update(episodes)
        .set({
          content,
          revision: current.revision + 1,
          status: this.editedStatus(current.status, false),
          updatedAt: now(),
        })
        .where(and(eq(episodes.id, episodeId), eq(episodes.revision, expectedRevision), isNull(episodes.deletedAt)))
        .run();
      if (result.changes !== 1) throw new ConflictException('Episode revision changed during analysis');
      this.removeEpisodeMemory(episodeId);
      this.invalidateFollowing(current);
      return { episode: this.toView(this.requireEpisode(projectId, episodeId)) };
    }).immediate();
  }

  async finalize(projectId: string, episodeId: string, body: unknown) {
    const episode = this.requireEpisode(projectId, episodeId);
    const input = (body ?? {}) as Record<string, unknown>;
    const expectedRevision = positiveInteger(input.expectedRevision, 'expectedRevision');
    if (expectedRevision !== episode.revision) throw new ConflictException('Episode revision is stale');
    if (!episode.content.trim()) throw new BadRequestException('Cannot finalize an empty episode');
    const existingSummary = this.database.orm
      .select()
      .from(episodeSummaries)
      .where(eq(episodeSummaries.episodeId, episodeId))
      .get();
    const existingScene = this.database.orm
      .select()
      .from(sceneStates)
      .where(eq(sceneStates.episodeId, episodeId))
      .get();
    if (
      episode.status === 'CONFIRMED' &&
      existingSummary?.sourceRevision === episode.revision &&
      existingSummary.sourceHash === sha256(episode.content) &&
      existingScene?.sourceRevision === episode.revision
    ) {
      return this.get(projectId, episodeId);
    }
    if (episode.kind === 'SIDE_STORY') {
      await this.refreshStalePredecessors(projectId, episode);
    }
    const flowRevision = this.sideFlowRevision(projectId, episode);
    const memory = await this.memory.assemble(projectId, `${episode.title}\n${episode.direction}`, episodeId);
    this.assertEpisodeRevision(projectId, episodeId, expectedRevision);
    if (flowRevision) this.assertSideFlowRevision(projectId, flowRevision, episode);
    if (episode.status === 'NEEDS_REVIEW') {
      const reviewVariables = this.promptMemory(memory, {
        episode_title: episode.title,
        episode_direction: episode.direction,
        boundary_context: '확정 대상 전체 원고',
      });
      const initialIssues = await this.reviewContinuity(
        { projectId, episodeId, reviewVariables },
        episode.content,
      );
      if (flowRevision) this.assertSideFlowRevision(projectId, flowRevision, episode);
      const blocking = initialIssues.filter((issue) => issue.severity === 'BLOCKING');
      if (blocking.length > 0) {
        throw new UnprocessableEntityException({
          code: 'CONTINUITY_BLOCKED',
          message: '연속성 차단 문제를 해결하기 전에는 회차를 확정할 수 없습니다.',
          details: {
            issues: initialIssues,
          },
        });
      }
    }
    const { value } = await this.ai.completeJson<MemoryExtraction>({
      task: 'episode_memory_extract',
      promptId: 'episode-memory-extract',
      projectId,
      episodeId,
      variables: this.promptMemory(memory, {
        episode_title: episode.title,
        episode_direction: episode.direction,
        episode_text: episode.content,
        episode_content: episode.content,
        episode_number: episode.number,
        previous_episode_memories: memory.recentSummaries,
      }),
      schema: { name: 'episode_memory', value: episodeMemorySchema },
      validator: episodeMemoryValidator,
      maxTokens: 8_000,
    });
    if (this.requireEpisode(projectId, episodeId).revision !== expectedRevision) {
      throw new ConflictException('Episode changed while memory was being extracted');
    }
    if (flowRevision) this.assertSideFlowRevision(projectId, flowRevision, episode);
    const stamp = now();
    this.database.connection.transaction(() => {
      this.database.orm
        .insert(episodeSummaries)
        .values({
          episodeId,
          synopsis: value.events.join(' ') || episode.direction,
          eventsJson: stringifyJson(value.events),
          emotionalChangesJson: stringifyJson(value.emotionalChanges),
          foreshadowingIntroducedJson: stringifyJson(value.newForeshadowing),
          foreshadowingResolvedJson: stringifyJson(value.resolvedForeshadowing),
          sourceRevision: episode.revision,
          sourceHash: sha256(episode.content),
          updatedAt: stamp,
        })
        .onConflictDoUpdate({
          target: episodeSummaries.episodeId,
          set: {
            synopsis: value.events.join(' ') || episode.direction,
            eventsJson: stringifyJson(value.events),
            emotionalChangesJson: stringifyJson(value.emotionalChanges),
            foreshadowingIntroducedJson: stringifyJson(value.newForeshadowing),
            foreshadowingResolvedJson: stringifyJson(value.resolvedForeshadowing),
            sourceRevision: episode.revision,
            sourceHash: sha256(episode.content),
            updatedAt: stamp,
          },
        })
        .run();
      this.database.orm
        .insert(sceneStates)
        .values({
          episodeId,
          location: value.endScene.location ?? '',
          storyTime: value.endScene.time ?? '',
          pointOfView: value.endScene.pointOfView ?? '',
          characterNamesJson: stringifyJson(value.endScene.characters),
          goal: value.endScene.goal ?? '',
          sourceRevision: episode.revision,
          updatedAt: stamp,
        })
        .onConflictDoUpdate({
          target: sceneStates.episodeId,
          set: {
            location: value.endScene.location ?? '',
            storyTime: value.endScene.time ?? '',
            pointOfView: value.endScene.pointOfView ?? '',
            characterNamesJson: stringifyJson(value.endScene.characters),
            goal: value.endScene.goal ?? '',
            sourceRevision: episode.revision,
            updatedAt: stamp,
          },
        })
        .run();
      // Group canon is explicitly authored with the group. Until group-scoped
      // candidate review is exposed, never create unreachable pending records
      // (and never let a side story propose changes to main canon).
      for (const candidate of episode.kind === 'MAIN' ? value.canonCandidates ?? [] : []) {
        const duplicate = this.database.orm
          .select({ id: canonEntries.id })
          .from(canonEntries)
          .where(and(
            eq(canonEntries.projectId, projectId),
            isNull(canonEntries.sideStoryGroupId),
            eq(canonEntries.category, candidate.category),
            eq(canonEntries.name, candidate.name),
          ))
          .get();
        if (duplicate) continue;
        this.database.orm.insert(canonEntries).values({
          id: id(),
          projectId,
          category: candidate.category,
          name: candidate.name,
          aliasesJson: stringifyJson(candidate.aliases ?? []),
          content: candidate.content,
          metadataJson: stringifyJson(candidate.metadata ?? {}),
          status: 'PENDING',
          revision: 1,
          sourceEpisodeId: episodeId,
          sideStoryGroupId: null,
          createdAt: stamp,
          updatedAt: stamp,
        }).run();
      }
      const updated = this.database.orm
        .update(episodes)
        .set({ status: 'CONFIRMED', updatedAt: stamp })
        .where(and(eq(episodes.id, episodeId), eq(episodes.revision, expectedRevision)))
        .run();
      if (updated.changes !== 1) throw new ConflictException('Episode changed during finalize');
      this.invalidateSideStoryDependents(episode);
    })();
    // Finalization intentionally changes the target's status, so capture a new
    // side-flow token after that transition and guard the asynchronous indexes
    // against anchor, predecessor, group, or target invalidation.
    const finalizedFlowRevision = flowRevision
      ? this.sideFlowRevision(projectId, episode)
      : undefined;
    await Promise.all([
      this.indexEpisode(episode),
      this.memory.indexSource({
        projectId,
        sourceType: 'EPISODE_SUMMARY',
        sourceId: episodeId,
        expectedEpisode: { number: episode.number, revision: episode.revision },
        text: [
          ...value.events,
          ...value.emotionalChanges.map((item) => `${item.character}: ${item.from} → ${item.to} (${item.cause})`),
          ...value.newForeshadowing.map((item) => `새 떡밥: ${item}`),
          ...value.resolvedForeshadowing.map((item) => `회수된 떡밥: ${item}`),
        ].join('\n'),
      }),
    ]);
    this.assertEpisodeRevision(projectId, episodeId, expectedRevision);
    if (finalizedFlowRevision) {
      this.assertSideFlowRevision(projectId, finalizedFlowRevision, episode);
    }
    return this.get(projectId, episodeId);
  }

  getScene(projectId: string, episodeId: string) {
    const episode = this.requireEpisode(projectId, episodeId);
    const scene = this.database.orm.select().from(sceneStates).where(eq(sceneStates.episodeId, episodeId)).get();
    return scene
      ? this.sceneView(scene)
      : {
          episodeId,
          location: null,
          time: null,
          pointOfView: null,
          characters: [],
          goal: null,
          sourceRevision: episode.revision,
        };
  }

  updateScene(projectId: string, episodeId: string, body: unknown) {
    return this.database.connection.transaction(() => {
      const episode = this.requireEpisode(projectId, episodeId);
      const input = (body ?? {}) as Record<string, unknown>;
      const expectedRevision = positiveInteger(input.expectedRevision, 'expectedRevision');
      if (expectedRevision !== episode.revision) throw new ConflictException('Episode revision is stale');
      const current = this.getScene(projectId, episodeId);
      const stamp = now();
      this.database.orm
        .insert(sceneStates)
        .values({
          episodeId,
          location: 'location' in input ? optionalString(input.location, 'location', 500) ?? '' : current.location ?? '',
          storyTime: 'time' in input ? optionalString(input.time, 'time', 500) ?? '' : current.time ?? '',
          pointOfView: 'pointOfView' in input ? optionalString(input.pointOfView, 'pointOfView', 500) ?? '' : current.pointOfView ?? '',
          characterNamesJson: 'characters' in input ? stringifyJson(stringArray(input.characters, 'characters')) : stringifyJson(current.characters),
          goal: 'goal' in input ? optionalString(input.goal, 'goal', 2_000) ?? '' : current.goal ?? '',
          sourceRevision: episode.revision,
          updatedAt: stamp,
        })
        .onConflictDoUpdate({
          target: sceneStates.episodeId,
          set: {
            location: 'location' in input ? optionalString(input.location, 'location', 500) ?? '' : current.location ?? '',
            storyTime: 'time' in input ? optionalString(input.time, 'time', 500) ?? '' : current.time ?? '',
            pointOfView: 'pointOfView' in input ? optionalString(input.pointOfView, 'pointOfView', 500) ?? '' : current.pointOfView ?? '',
            characterNamesJson: 'characters' in input ? stringifyJson(stringArray(input.characters, 'characters')) : stringifyJson(current.characters),
            goal: 'goal' in input ? optionalString(input.goal, 'goal', 2_000) ?? '' : current.goal ?? '',
            sourceRevision: episode.revision,
            updatedAt: stamp,
          },
        })
        .run();
      this.invalidateSideStoryDependents(episode);
      return this.getScene(projectId, episodeId);
    }).immediate();
  }

  private repairInput(input: Record<string, unknown>): { content: string; issue: ContinuityIssue } {
    const content = optionalString(input.content, 'content', 1_000_000);
    if (!content?.trim()) throw new BadRequestException('content must not be empty');
    const parsed = continuityReviewValidator.safeParse({ issues: [input.issue] });
    if (!parsed.success) throw new BadRequestException('issue must be a valid continuity issue');
    const issue = parsed.data.issues[0]!;
    if (!issue.explanation.trim() && !issue.repairInstruction.trim()) {
      throw new BadRequestException('issue must include an explanation or repair instruction');
    }
    return { content, issue };
  }

  private async repairSelectedIssue(
    input: {
      projectId: string;
      episodeId?: string;
      baseRevision?: number;
      baseOrderRevision?: string;
      baseFlowRevision?: string;
      flowEpisode?: typeof episodes.$inferSelect;
      flowContext?: VirtualNarrativeContext;
      content: string;
      issue: ContinuityIssue;
      reviewVariables: Record<string, unknown>;
    },
    emit: (event: StreamEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    emit({ type: 'stage', stage: 'REPAIRING' });
    const selectedIssues = stringifyJson([input.issue]);
    const repaired = await this.ai.streamText({
      task: 'continuity_repair',
      promptId: 'continuity-repair',
      includeCore: false,
      projectId: input.projectId,
      episodeId: input.episodeId,
      variables: {
        ...input.reviewVariables,
        candidate_text: input.content,
        draft_text: input.content,
        continuity_issues: selectedIssues,
        issues: selectedIssues,
        review_issues: selectedIssues,
      },
      signal,
      maxTokens: 32_000,
    }, () => undefined, (runId) => emit({ type: 'meta', runId, baseRevision: input.baseRevision }));
    signal?.throwIfAborted();
    if (!repaired.result.content.trim()) throw new BadGatewayException('AI returned an empty continuity repair');
    this.assertGenerationCurrent(input, 'repair');
    emit({ type: 'stage', stage: 'CHECKING' });
    // Recheck the whole candidate without automatically repairing other issues.
    const issues = await this.reviewContinuity(input, repaired.result.content, signal);
    signal?.throwIfAborted();
    this.assertGenerationCurrent(input, 'repair');
    emit({
      type: 'done',
      content: repaired.result.content,
      issues,
      blocked: issues.some((issue) => issue.severity === 'BLOCKING'),
      baseRevision: input.baseRevision,
    });
  }

  private async streamWithContinuity(
    input: {
      projectId: string;
      episodeId?: string;
      baseRevision?: number;
      baseOrderRevision?: string;
      baseFlowRevision?: string;
      flowEpisode?: typeof episodes.$inferSelect;
      flowContext?: VirtualNarrativeContext;
      task: string;
      promptId: 'episode-draft' | 'episode-continue';
      variables: Record<string, unknown>;
      reviewVariables: Record<string, unknown>;
    },
    emit: (event: StreamEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const draft = await this.ai.streamText(
      {
        ...input,
        signal,
        maxTokens: 32_000,
      },
      (text) => emit({ type: 'delta', text }),
      (runId) => emit({ type: 'meta', runId, baseRevision: input.baseRevision }),
    );
    if (!draft.result.content.trim()) throw new BadGatewayException('AI returned an empty episode draft');
    signal?.throwIfAborted();
    this.assertGenerationCurrent(input);
    emit({ type: 'stage', stage: 'CHECKING' });
    // Review only reports issues. Every change requires a separate user-selected
    // repair request, including when a blocking contradiction is found.
    const review = await this.reviewContinuity(input, draft.result.content, signal);
    signal?.throwIfAborted();
    this.assertGenerationCurrent(input);
    emit({
      type: 'done',
      content: draft.result.content,
      blocked: review.some((issue) => issue.severity === 'BLOCKING'),
      issues: review,
      baseRevision: input.baseRevision,
    });
  }

  private async reviewContinuity(
    input: { projectId?: string; episodeId?: string; reviewVariables: Record<string, unknown> },
    candidate: string,
    signal?: AbortSignal,
  ): Promise<ContinuityIssue[]> {
    const { value } = await this.ai.completeJson<{ issues: ContinuityIssue[] }>({
      task: 'continuity_review',
      promptId: 'continuity-review',
      // General writing guidance includes POV, style and pacing rules that are
      // outside the factual scope of continuity review.
      includeCore: false,
      projectId: input.projectId,
      episodeId: input.episodeId,
      variables: {
        ...input.reviewVariables,
        candidate_text: candidate,
        draft_text: candidate,
        recent_episode_memories: input.reviewVariables.recent_summaries ?? '[]',
      },
      schema: { name: 'continuity_review', value: continuityReviewSchema },
      validator: continuityReviewValidator,
      signal,
      maxTokens: 6_000,
    });
    return value.issues ?? [];
  }

  private promptMemory(memory: Awaited<ReturnType<MemoryService['assemble']>>, extra: Record<string, unknown>) {
    return {
      project_context: memory.projectContext,
      writing_direction: memory.writingDirection,
      canon: memory.canon,
      current_arc: memory.currentArc,
      current_scene: memory.currentScene,
      recent_summaries: memory.recentSummaries,
      open_foreshadowing: memory.openForeshadowing,
      retrieved_memories: memory.retrievedMemories,
      improvements: memory.improvements,
      ...extra,
    };
  }

  private targetChars(value: unknown, fallback: number): number {
    if (value === undefined) return fallback;
    const number = Number(value);
    if (!Number.isInteger(number) || number < 300 || number > 100_000) {
      throw new BadRequestException('targetChars must be between 300 and 100000');
    }
    return number;
  }

  private invalidateFollowing(current: typeof episodes.$inferSelect): void {
    if (current.number === null) return;
    const flow = current.kind === 'MAIN'
      ? eq(episodes.kind, 'MAIN')
      : current.sideStoryGroupId
        ? and(
            eq(episodes.kind, 'SIDE_STORY'),
            eq(episodes.sideStoryGroupId, current.sideStoryGroupId),
          )
        : undefined;
    if (!flow) return;
    const startNumber = current.number + 1;
    const affected = this.database.orm
      .select({ id: episodes.id })
      .from(episodes)
      .where(
        and(
          eq(episodes.projectId, current.projectId),
          flow,
          gte(episodes.number, startNumber),
          isNull(episodes.deletedAt),
        ),
      )
      .all();
    this.database.orm
      .update(episodes)
      .set({ status: 'MEMORY_STALE', updatedAt: now() })
      .where(
        and(
          eq(episodes.projectId, current.projectId),
          flow,
          gte(episodes.number, startNumber),
          eq(episodes.status, 'CONFIRMED'),
          isNull(episodes.deletedAt),
        ),
      )
      .run();
    for (const row of affected) {
      this.memory.removeSource('EPISODE', row.id);
      this.memory.removeSource('EPISODE_SUMMARY', row.id);
    }
    if (current.kind === 'MAIN') {
      this.invalidateAnchoredSideFlows(current.projectId, current.number);
    }
  }

  private invalidateSideStoryDependents(current: typeof episodes.$inferSelect): void {
    if (current.number === null) return;
    if (current.kind === 'MAIN') {
      this.invalidateAnchoredSideFlows(current.projectId, current.number);
    } else if (current.sideStoryGroupId) {
      this.invalidateFollowing(current);
    }
  }

  private invalidateAnchoredSideFlows(projectId: string, changedMainNumber: number): void {
    const affected = this.database.connection.prepare(
      `SELECT DISTINCT side.id, side.status
       FROM episodes side
       LEFT JOIN side_story_groups side_group
         ON side_group.id = side.side_story_group_id
       JOIN episodes anchor
         ON anchor.id = COALESCE(side.branch_from_episode_id, side_group.branch_from_episode_id)
       WHERE side.project_id = ?
         AND side.kind = 'SIDE_STORY'
         AND side.deleted_at IS NULL
         AND anchor.project_id = side.project_id
         AND anchor.kind = 'MAIN'
         AND anchor.deleted_at IS NULL
         AND anchor.number >= ?`,
    ).all(projectId, changedMainNumber) as Array<{ id: string; status: string }>;
    const stamp = now();
    for (const row of affected) {
      if (row.status === 'CONFIRMED') {
        this.database.orm.update(episodes).set({ status: 'MEMORY_STALE', updatedAt: stamp })
          .where(eq(episodes.id, row.id)).run();
      }
      this.removeEpisodeMemory(row.id);
    }
  }

  private detachDirectSideBranches(mainEpisode: typeof episodes.$inferSelect): void {
    const stamp = now();
    const standalone = this.database.orm.select().from(episodes).where(and(
      eq(episodes.projectId, mainEpisode.projectId),
      eq(episodes.kind, 'SIDE_STORY'),
      isNull(episodes.sideStoryGroupId),
      eq(episodes.branchFromEpisodeId, mainEpisode.id),
      isNull(episodes.deletedAt),
    )).all();
    for (const row of standalone) {
      this.database.orm.update(episodes).set({
        branchFromEpisodeId: null,
        revision: row.revision + 1,
        status: this.editedStatus(row.status, false),
        updatedAt: stamp,
      }).where(eq(episodes.id, row.id)).run();
    }
    const groups = this.database.orm.select().from(sideStoryGroups).where(and(
      eq(sideStoryGroups.projectId, mainEpisode.projectId),
      eq(sideStoryGroups.branchFromEpisodeId, mainEpisode.id),
    )).all();
    for (const group of groups) {
      this.database.orm.update(sideStoryGroups).set({
        branchFromEpisodeId: null,
        revision: group.revision + 1,
        updatedAt: stamp,
      }).where(eq(sideStoryGroups.id, group.id)).run();
    }
  }

  private removeEpisodeMemory(episodeId: string): void {
    this.memory.removeSource('EPISODE', episodeId);
    this.memory.removeSource('EPISODE_SUMMARY', episodeId);
  }

  private editedStatus(current: string, forceNeedsReview: boolean): string {
    if (forceNeedsReview) return 'NEEDS_REVIEW';
    if (current === 'INCOMPLETE') return 'INCOMPLETE';
    if (current === 'DRAFT') return 'DRAFT';
    if (current === 'NEEDS_REVIEW') return 'NEEDS_REVIEW';
    return 'MEMORY_STALE';
  }

  private incompleteFlag(input: Record<string, unknown>): boolean | undefined {
    if (input.incomplete !== undefined && typeof input.incomplete !== 'boolean') {
      throw new BadRequestException('incomplete must be a boolean');
    }
    return input.incomplete as boolean | undefined;
  }

  private requestedDraftEpisode(
    projectId: string,
    input: Record<string, unknown>,
    requireRevision = false,
    requireEmpty = true,
  ) {
    if (input.episodeId === undefined) {
      if (input.expectedRevision !== undefined) throw new BadRequestException('episodeId is required with expectedRevision');
      return undefined;
    }
    const episode = this.requireEpisode(projectId, requireString(input.episodeId, 'episodeId'));
    if (requireRevision || input.expectedRevision !== undefined) {
      const expectedRevision = positiveInteger(input.expectedRevision, 'expectedRevision');
      if (episode.revision !== expectedRevision) throw new ConflictException('Episode revision is stale');
    }
    if (requireEmpty && episode.content.trim()) throw new BadRequestException('The episode already contains content');
    return episode;
  }

  private virtualNarrativeContext(
    projectId: string,
    input: Record<string, unknown>,
    episode?: typeof episodes.$inferSelect,
  ): VirtualNarrativeContext | undefined {
    const hasVirtualFields = 'kind' in input || 'sideStoryGroupId' in input || 'branchFromEpisodeId' in input;
    if (episode) {
      if (hasVirtualFields) {
        throw new BadRequestException('An existing episode determines its own narrative context');
      }
      return undefined;
    }
    if (input.kind !== 'SIDE_STORY') {
      if (hasVirtualFields) throw new BadRequestException('kind must be SIDE_STORY for side-story context');
      return undefined;
    }
    const sideStoryGroupId = this.nullableId(input.sideStoryGroupId, 'sideStoryGroupId');
    const branchFromEpisodeId = this.nullableId(input.branchFromEpisodeId, 'branchFromEpisodeId');
    if (sideStoryGroupId) {
      if (branchFromEpisodeId) {
        throw new BadRequestException('A grouped side story inherits the group branch');
      }
      const group = this.database.orm.select().from(sideStoryGroups).where(and(
        eq(sideStoryGroups.id, sideStoryGroupId),
        eq(sideStoryGroups.projectId, projectId),
      )).get();
      if (!group) throw new NotFoundException('Side-story group not found');
    } else if (branchFromEpisodeId) {
      this.requireMainBranch(projectId, branchFromEpisodeId);
    }
    return { kind: 'SIDE_STORY', sideStoryGroupId, branchFromEpisodeId };
  }

  private nullableId(value: unknown, field: string): string | null {
    if (value === undefined || value === null) return null;
    return requireString(value, field, { max: 200 });
  }

  private requireMainBranch(projectId: string, episodeId: string) {
    const branch = this.database.orm.select().from(episodes).where(and(
      eq(episodes.id, episodeId),
      eq(episodes.projectId, projectId),
      eq(episodes.kind, 'MAIN'),
      isNull(episodes.deletedAt),
    )).get();
    if (!branch) throw new BadRequestException('branchFromEpisodeId must be a live main episode in this project');
    return branch;
  }

  private mainOrderRevision(
    projectId: string,
    episode?: typeof episodes.$inferSelect,
    narrativeContext?: VirtualNarrativeContext,
  ): string | undefined {
    if (episode?.kind === 'SIDE_STORY' || narrativeContext) return undefined;
    return this.readOrder(projectId).revision;
  }

  /**
   * Hash only the timeline that a side-story operation is allowed to see.
   * This gives long-running AI work an optimistic concurrency token without
   * coupling it to later main episodes or to unrelated side-story groups.
   */
  private sideFlowRevision(
    projectId: string,
    episode?: typeof episodes.$inferSelect,
    narrativeContext?: VirtualNarrativeContext,
  ): string | undefined {
    const project = this.database.orm.select({
      id: projects.id,
      revision: projects.revision,
      deletedAt: projects.deletedAt,
    }).from(projects).where(eq(projects.id, projectId)).get();
    const target = episode
      ? this.database.orm.select().from(episodes).where(and(
          eq(episodes.id, episode.id),
          eq(episodes.projectId, projectId),
          isNull(episodes.deletedAt),
        )).get()
      : undefined;
    if (target?.kind !== 'SIDE_STORY' && !narrativeContext) return undefined;

    const groupId = target?.sideStoryGroupId ?? narrativeContext?.sideStoryGroupId ?? null;
    const group = groupId
      ? this.database.orm.select().from(sideStoryGroups).where(and(
          eq(sideStoryGroups.id, groupId),
          eq(sideStoryGroups.projectId, projectId),
        )).get()
      : undefined;
    const branchId = group?.branchFromEpisodeId
      ?? target?.branchFromEpisodeId
      ?? narrativeContext?.branchFromEpisodeId
      ?? null;
    const branch = branchId
      ? this.database.orm.select().from(episodes).where(and(
          eq(episodes.id, branchId),
          eq(episodes.projectId, projectId),
          eq(episodes.kind, 'MAIN'),
          isNull(episodes.deletedAt),
        )).get()
      : undefined;
    const mainPrefix = branch?.number === null || branch?.number === undefined
      ? []
      : this.database.orm.select().from(episodes).where(and(
          eq(episodes.projectId, projectId),
          eq(episodes.kind, 'MAIN'),
          lte(episodes.number, branch.number),
          isNull(episodes.deletedAt),
        )).orderBy(episodes.number, episodes.id).all();

    const boundary = group
      ? target?.number ?? group.nextEpisodeNumber
      : null;
    const groupPrefix = group && boundary !== null
      ? this.database.orm.select().from(episodes).where(and(
          eq(episodes.projectId, projectId),
          eq(episodes.kind, 'SIDE_STORY'),
          eq(episodes.sideStoryGroupId, group.id),
          lt(episodes.number, boundary),
          isNull(episodes.deletedAt),
        )).orderBy(episodes.number, episodes.id).all()
      : [];
    const groupCanon = group
      ? this.database.orm.select({
          id: canonEntries.id,
          revision: canonEntries.revision,
          status: canonEntries.status,
        }).from(canonEntries).where(and(
          eq(canonEntries.projectId, projectId),
          eq(canonEntries.sideStoryGroupId, group.id),
          or(eq(canonEntries.status, 'ACTIVE'), eq(canonEntries.status, 'ACCEPTED')),
        )).orderBy(canonEntries.id).all()
      : [];
    const sharedCanon = this.database.orm.select({
      id: canonEntries.id,
      revision: canonEntries.revision,
      status: canonEntries.status,
    }).from(canonEntries).where(and(
      eq(canonEntries.projectId, projectId),
      isNull(canonEntries.sideStoryGroupId),
      or(eq(canonEntries.status, 'ACTIVE'), eq(canonEntries.status, 'ACCEPTED')),
    )).orderBy(canonEntries.id).all();
    const activeImprovements = this.database.orm.select({
      id: improvements.id,
      revision: improvements.revision,
      projectId: improvements.projectId,
      active: improvements.active,
    }).from(improvements).where(and(
      eq(improvements.active, true),
      or(isNull(improvements.projectId), eq(improvements.projectId, projectId)),
    )).orderBy(improvements.id).all();
    const groupArcs = group
      ? this.database.orm.select({
          id: arcs.id,
          revision: arcs.revision,
          status: arcs.status,
        }).from(arcs).where(and(
          eq(arcs.projectId, projectId),
          eq(arcs.sideStoryGroupId, group.id),
          eq(arcs.status, 'ACTIVE'),
        )).orderBy(arcs.id).all()
      : [];

    return sha256(stringifyJson({
      kind: 'SIDE_STORY',
      project: project ?? { id: projectId, missing: true },
      target: target ? {
        ...this.flowEpisodeState(target),
        sideStoryGroupId: target.sideStoryGroupId,
        branchFromEpisodeId: target.branchFromEpisodeId,
      } : null,
      group: group ? {
        id: group.id,
        revision: group.revision,
        branchFromEpisodeId: group.branchFromEpisodeId,
        boundary,
      } : groupId ? { id: groupId, missing: true } : null,
      branch: branch
        ? { id: branch.id, number: branch.number }
        : branchId ? { id: branchId, missing: true } : null,
      mainPrefix: mainPrefix.map((row) => this.flowEpisodeState(row)),
      groupPrefix: groupPrefix.map((row) => this.flowEpisodeState(row)),
      sharedCanon,
      groupCanon,
      groupArcs,
      activeImprovements,
    }));
  }

  private flowEpisodeState(row: typeof episodes.$inferSelect) {
    const summary = this.database.orm.select({
      synopsis: episodeSummaries.synopsis,
      eventsJson: episodeSummaries.eventsJson,
      emotionalChangesJson: episodeSummaries.emotionalChangesJson,
      foreshadowingIntroducedJson: episodeSummaries.foreshadowingIntroducedJson,
      foreshadowingResolvedJson: episodeSummaries.foreshadowingResolvedJson,
      sourceRevision: episodeSummaries.sourceRevision,
      sourceHash: episodeSummaries.sourceHash,
      updatedAt: episodeSummaries.updatedAt,
    }).from(episodeSummaries).where(eq(episodeSummaries.episodeId, row.id)).get();
    const scene = this.database.orm.select({
      location: sceneStates.location,
      storyTime: sceneStates.storyTime,
      pointOfView: sceneStates.pointOfView,
      characterNamesJson: sceneStates.characterNamesJson,
      goal: sceneStates.goal,
      sourceRevision: sceneStates.sourceRevision,
      updatedAt: sceneStates.updatedAt,
    }).from(sceneStates).where(eq(sceneStates.episodeId, row.id)).get();
    return {
      id: row.id,
      number: row.number,
      revision: row.revision,
      status: row.status,
      summary: summary?.sourceRevision === row.revision ? summary : null,
      scene: scene?.sourceRevision === row.revision ? scene : null,
    };
  }

  private assertSideFlowRevision(
    projectId: string,
    expectedRevision: string,
    episode?: typeof episodes.$inferSelect,
    narrativeContext?: VirtualNarrativeContext,
  ): void {
    if (this.sideFlowRevision(projectId, episode, narrativeContext) !== expectedRevision) {
      throw new ConflictException(
        '외전 흐름이 변경되었습니다. 최신 외전과 분기 회차를 확인한 뒤 다시 시도해 주세요.',
      );
    }
  }

  private assembleDraftMemory(
    projectId: string,
    query: string,
    episodeId?: string,
    narrativeContext?: VirtualNarrativeContext,
  ) {
    if (episodeId) {
      return this.memory.assemble(projectId, query, episodeId, { previousEpisodeScene: true });
    }
    return narrativeContext
      ? this.memory.assemble(projectId, query, undefined, {
          previousEpisodeScene: true,
          narrativeContext,
        })
      : this.memory.assemble(projectId, query);
  }

  private async refreshStalePredecessors(
    projectId: string,
    episode?: typeof episodes.$inferSelect,
    narrativeContext?: VirtualNarrativeContext,
  ): Promise<void> {
    const sideStory = episode?.kind === 'SIDE_STORY' || narrativeContext !== undefined;
    if (sideStory) {
      const groupId = episode?.sideStoryGroupId ?? narrativeContext?.sideStoryGroupId ?? null;
      const group = groupId
        ? this.database.orm.select().from(sideStoryGroups).where(and(
            eq(sideStoryGroups.id, groupId),
            eq(sideStoryGroups.projectId, projectId),
          )).get()
        : undefined;
      if (groupId && !group) throw new NotFoundException('Side-story group not found');

      const branchId = group?.branchFromEpisodeId
        ?? episode?.branchFromEpisodeId
        ?? narrativeContext?.branchFromEpisodeId
        ?? null;
      if (branchId) {
        const branch = this.requireMainBranch(projectId, branchId);
        const staleMain = this.database.orm.select().from(episodes).where(and(
          eq(episodes.projectId, projectId),
          eq(episodes.kind, 'MAIN'),
          eq(episodes.status, 'MEMORY_STALE'),
          lte(episodes.number, branch.number!),
          isNull(episodes.deletedAt),
        )).orderBy(episodes.number).all();
        await this.finalizeStaleRows(projectId, staleMain);
      }

      // Refresh the branch prefix first: confirming it may invalidate already
      // confirmed group episodes that depend on that main-story state.
      if (group) {
        const boundary = episode?.number ?? group.nextEpisodeNumber;
        const staleGroup = this.database.orm.select().from(episodes).where(and(
          eq(episodes.projectId, projectId),
          eq(episodes.kind, 'SIDE_STORY'),
          eq(episodes.sideStoryGroupId, group.id),
          eq(episodes.status, 'MEMORY_STALE'),
          lt(episodes.number, boundary!),
          isNull(episodes.deletedAt),
        )).orderBy(episodes.number).all();
        await this.finalizeStaleRows(projectId, staleGroup);
      }
      return;
    }

    const mainConditions = [
      eq(episodes.projectId, projectId),
      eq(episodes.kind, 'MAIN'),
      eq(episodes.status, 'MEMORY_STALE'),
      isNull(episodes.deletedAt),
    ];
    if (episode?.number !== null && episode?.number !== undefined) {
      mainConditions.push(lt(episodes.number, episode.number));
    }
    const staleMain = this.database.orm.select().from(episodes)
      .where(and(...mainConditions)).orderBy(episodes.number).all();
    await this.finalizeStaleRows(projectId, staleMain);
  }

  private async finalizeStaleRows(
    projectId: string,
    rows: Array<typeof episodes.$inferSelect>,
  ): Promise<void> {
    for (const row of rows) {
      if (row.content.trim()) {
        await this.finalize(projectId, row.id, { expectedRevision: row.revision });
      }
    }
  }

  private async ensureScene(
    projectId: string,
    episode: typeof episodes.$inferSelect,
    textBeforeCursor: string,
    signal?: AbortSignal,
    assertContextCurrent?: () => void,
  ): Promise<void> {
    const current = this.database.orm
      .select()
      .from(sceneStates)
      .where(eq(sceneStates.episodeId, episode.id))
      .get();
    if (current?.sourceRevision === episode.revision) return;
    const memory = await this.memory.assemble(projectId, extractLastParagraph(textBeforeCursor), episode.id);
    const { value } = await this.ai.completeJson<{
      location: string | null;
      time: string | null;
      pointOfView: string | null;
      characters: string[];
      goal: string | null;
    }>({
      task: 'scene_extract',
      promptId: 'scene-extract',
      projectId,
      episodeId: episode.id,
      variables: this.promptMemory(memory, {
        episode_title: episode.title,
        episode_direction: episode.direction,
        episode_text: episode.content,
        text_before_cursor: textBeforeCursor.slice(-20_000),
        text_after_cursor: episode.content.slice(textBeforeCursor.length, textBeforeCursor.length + 8_000),
        previous_paragraph: extractLastParagraph(textBeforeCursor),
      }),
      schema: { name: 'scene_state', value: sceneExtractionSchema },
      validator: sceneExtractionValidator,
      signal,
      maxTokens: 2_000,
    });
    this.assertEpisodeRevision(projectId, episode.id, episode.revision);
    assertContextCurrent?.();
    const stamp = now();
    const values: typeof sceneStates.$inferInsert = {
      episodeId: episode.id,
      location: value.location ?? '',
      storyTime: value.time ?? '',
      pointOfView: value.pointOfView ?? '',
      characterNamesJson: stringifyJson(value.characters),
      goal: value.goal ?? '',
      sourceRevision: episode.revision,
      updatedAt: stamp,
    };
    const result = current
      ? this.database.orm.update(sceneStates).set(values).where(and(
          eq(sceneStates.episodeId, episode.id),
          eq(sceneStates.location, current.location),
          eq(sceneStates.storyTime, current.storyTime),
          eq(sceneStates.pointOfView, current.pointOfView),
          eq(sceneStates.characterNamesJson, current.characterNamesJson),
          eq(sceneStates.goal, current.goal),
          eq(sceneStates.sourceRevision, current.sourceRevision),
          eq(sceneStates.updatedAt, current.updatedAt),
        )).run()
      : this.database.orm
          .insert(sceneStates)
          .values(values)
          .onConflictDoNothing({ target: sceneStates.episodeId })
          .run();
    if (result.changes !== 1) {
      throw new ConflictException('Scene changed while it was being extracted');
    }
  }

  private requireEpisode(projectId: string, episodeId: string) {
    const row = this.database.orm
      .select()
      .from(episodes)
      .where(
        and(
          eq(episodes.id, episodeId),
          eq(episodes.projectId, projectId),
          isNull(episodes.deletedAt),
        ),
      )
      .get();
    if (!row) throw new NotFoundException('Episode not found');
    return row;
  }

  private readOrder(projectId: string): EpisodeOrderSnapshot {
    return this.database.connection.transaction(() => {
      const project = this.projects.get(projectId);
      const rows = this.database.orm.select().from(episodes)
        .where(and(
          eq(episodes.projectId, projectId),
          eq(episodes.kind, 'MAIN'),
          isNull(episodes.deletedAt),
        ))
        .orderBy(episodes.number).all();
      const slotCount = project.nextEpisodeNumber - 1;
      return {
        rows,
        slotCount,
        revision: sha256(stringifyJson({
          slotCount,
          episodes: rows.map(({ id, number, revision }) => ({ id, number, revision })),
        })),
      };
    })();
  }

  private orderView(snapshot: EpisodeOrderSnapshot) {
    const slots: Array<string | null> = Array(snapshot.slotCount).fill(null);
    for (const row of snapshot.rows) slots[row.number! - 1] = row.id;
    return {
      episodes: snapshot.rows.map((row) => this.toView(row)),
      slots,
      revision: snapshot.revision,
    };
  }

  private assertOrderRevision(projectId: string, expectedRevision: string): void {
    if (this.readOrder(projectId).revision !== expectedRevision) {
      throw new ConflictException('회차 목록이 변경되었습니다. 최신 순서를 확인한 뒤 다시 시도해 주세요.');
    }
  }

  private assertEpisodeRevision(projectId: string, episodeId: string, expectedRevision: number, operation = 'generation'): void {
    if (this.requireEpisode(projectId, episodeId).revision !== expectedRevision) {
      throw new ConflictException(`Episode revision changed during ${operation}`);
    }
  }

  private assertGenerationCurrent(input: {
    projectId: string;
    episodeId?: string;
    baseRevision?: number;
    baseOrderRevision?: string;
    baseFlowRevision?: string;
    flowEpisode?: typeof episodes.$inferSelect;
    flowContext?: VirtualNarrativeContext;
  }, operation = 'generation'): void {
    if (input.episodeId && input.baseRevision !== undefined) {
      this.assertEpisodeRevision(input.projectId, input.episodeId, input.baseRevision, operation);
    }
    if (input.baseOrderRevision !== undefined) {
      this.assertOrderRevision(input.projectId, input.baseOrderRevision);
    }
    if (input.baseFlowRevision !== undefined) {
      this.assertSideFlowRevision(
        input.projectId,
        input.baseFlowRevision,
        input.flowEpisode,
        input.flowContext,
      );
    }
  }

  private async indexEpisode(row: typeof episodes.$inferSelect): Promise<void> {
    const label = row.kind === 'MAIN'
      ? `${row.number}화`
      : row.sideStoryGroupId
        ? `외전 ${row.number}화`
        : '단편 외전';
    await this.memory.indexSource({
      projectId: row.projectId,
      sourceType: 'EPISODE',
      sourceId: row.id,
      expectedEpisode: { number: row.number, revision: row.revision },
      text: `${label} ${row.title}\n방향: ${row.direction}\n${row.content}`,
    });
  }

  private toView(row: typeof episodes.$inferSelect) {
    const summary = this.database.orm
      .select()
      .from(episodeSummaries)
      .where(eq(episodeSummaries.episodeId, row.id))
      .get();
    return {
      id: row.id,
      projectId: row.projectId,
      number: row.number,
      kind: row.kind,
      sideStoryGroupId: row.sideStoryGroupId,
      branchFromEpisodeId: row.branchFromEpisodeId,
      title: row.title,
      direction: row.direction,
      content: row.content,
      revision: row.revision,
      status: row.status,
      summary: summary
        ? {
            synopsis: summary.synopsis,
            events: parseJson(summary.eventsJson, []),
            emotionalChanges: parseJson(summary.emotionalChangesJson, []),
            newForeshadowing: parseJson(summary.foreshadowingIntroducedJson, []),
            resolvedForeshadowing: parseJson(summary.foreshadowingResolvedJson, []),
            foreshadowingIntroduced: parseJson(summary.foreshadowingIntroducedJson, []),
            foreshadowingResolved: parseJson(summary.foreshadowingResolvedJson, []),
            sourceRevision: summary.sourceRevision,
            sourceVersion: summary.sourceRevision,
            stale: summary.sourceRevision !== row.revision,
            updatedAt: summary.updatedAt,
          }
        : null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private sceneView(row: typeof sceneStates.$inferSelect) {
    return {
      episodeId: row.episodeId,
      location: row.location || null,
      time: row.storyTime || null,
      pointOfView: row.pointOfView || null,
      characters: parseJson<string[]>(row.characterNamesJson, []),
      goal: row.goal || null,
      sourceRevision: row.sourceRevision,
    };
  }
}
