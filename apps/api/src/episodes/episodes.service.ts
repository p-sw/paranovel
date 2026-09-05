import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { and, eq, gte, isNull, lt } from 'drizzle-orm';
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
  canonEntries,
  episodeIdempotency,
  episodeSummaries,
  episodes,
  projects,
  sceneStates,
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
      .where(and(eq(episodes.projectId, projectId), isNull(episodes.deletedAt)))
      .orderBy(episodes.number)
      .all()
      .map((row) => this.toView(row));
  }

  get(projectId: string, episodeId: string) {
    const row = this.requireEpisode(projectId, episodeId);
    return this.toView(row);
  }

  async create(projectId: string, body: unknown, idempotencyKey?: string) {
    this.projects.get(projectId);
    const input = (body ?? {}) as Record<string, unknown>;
    const requestHash = sha256(stringifyJson(input));
    if (idempotencyKey) {
      if (idempotencyKey.length > 200) throw new BadRequestException('Idempotency-Key is too long');
      const existing = this.database.orm
        .select()
        .from(episodeIdempotency)
        .where(
          and(
            eq(episodeIdempotency.projectId, projectId),
            eq(episodeIdempotency.idempotencyKey, idempotencyKey),
          ),
        )
        .get();
      if (existing) {
        if (existing.requestHash !== requestHash) {
          throw new ConflictException('Idempotency-Key was already used with a different request');
        }
        return this.get(projectId, existing.episodeId);
      }
    }
    const projectRow = this.database.orm
      .select()
      .from(projects)
      .where(eq(projects.id, projectId))
      .get();
    if (!projectRow) throw new NotFoundException('Project not found');
    const stamp = now();
    const episodeId = id();
    const row: typeof episodes.$inferInsert = {
      id: episodeId,
      projectId,
      number: projectRow.nextEpisodeNumber,
      title: requireString(input.title, 'title', { max: 200 }),
      direction: optionalString(input.direction, 'direction', 20_000) ?? '',
      content: optionalString(input.content, 'content', 1_000_000) ?? '',
      revision: 1,
      status:
        input.forceNeedsReview === true || input.force === true
          ? 'NEEDS_REVIEW'
          : 'DRAFT',
      createdAt: stamp,
      updatedAt: stamp,
      deletedAt: null,
    };
    this.database.connection.transaction(() => {
      this.database.orm.insert(episodes).values(row).run();
      if (idempotencyKey) {
        this.database.orm.insert(episodeIdempotency).values({
          projectId,
          idempotencyKey,
          episodeId,
          requestHash,
          createdAt: stamp,
        }).run();
      }
      this.database.orm
        .update(projects)
        .set({ nextEpisodeNumber: projectRow.nextEpisodeNumber + 1, updatedAt: stamp })
        .where(and(eq(projects.id, projectId), eq(projects.nextEpisodeNumber, projectRow.nextEpisodeNumber)))
        .run();
    })();
    return this.toView(row as typeof episodes.$inferSelect);
  }

  async update(projectId: string, episodeId: string, body: unknown) {
    const current = this.requireEpisode(projectId, episodeId);
    const input = (body ?? {}) as Record<string, unknown>;
    const expectedRevision = positiveInteger(input.expectedRevision, 'expectedRevision');
    const changes: Partial<typeof episodes.$inferInsert> = {
      revision: current.revision + 1,
      updatedAt: now(),
    };
    if ('title' in input) changes.title = requireString(input.title, 'title', { max: 200 });
    if ('direction' in input) changes.direction = optionalString(input.direction, 'direction', 20_000) ?? '';
    if ('content' in input) {
      changes.content = optionalString(input.content, 'content', 1_000_000) ?? '';
      changes.status = this.editedStatus(current.status, input.forceNeedsReview === true);
    }
    if (!('title' in input) && !('direction' in input) && !('content' in input)) {
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
    if ('content' in input) {
      this.removeEpisodeMemory(episodeId);
      this.invalidateFrom(projectId, current.number + 1);
    }
    return this.toView(updated);
  }

  remove(projectId: string, episodeId: string, body: unknown): void {
    const current = this.requireEpisode(projectId, episodeId);
    const input = (body ?? {}) as Record<string, unknown>;
    const expectedRevision = positiveInteger(input.expectedRevision, 'expectedRevision');
    if (expectedRevision !== current.revision) {
      throw new ConflictException('Episode revision is stale');
    }
    this.memory.removeSource('EPISODE', episodeId);
    this.memory.removeSource('EPISODE_SUMMARY', episodeId);
    this.database.orm.delete(episodes).where(eq(episodes.id, episodeId)).run();
    this.invalidateFrom(projectId, current.number + 1);
  }

  async propose(projectId: string, body: unknown) {
    const input = (body ?? {}) as Record<string, unknown>;
    const hint = optionalString(input.hint, 'hint', 5_000) ?? '';
    await this.refreshStalePredecessors(projectId);
    const memory = await this.memory.assemble(projectId, hint);
    const { value } = await this.ai.completeJson<{
      title: string;
      direction: string;
      conflicts: string[];
    }>({
      task: 'episode_direction',
      promptId: 'episode-direction',
      projectId,
      variables: this.promptMemory(memory, {
        user_request: hint,
      }),
      schema: { name: 'episode_direction', value: episodeDirectionSchema },
      validator: episodeDirectionValidator,
      maxTokens: 3_000,
    });
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
    await this.refreshStalePredecessors(projectId);
    emit({ type: 'stage', stage: 'MEMORY' });
    const memory = await this.memory.assemble(projectId, `${title}\n${direction}`);
    emit({ type: 'stage', stage: 'WRITING' });
    await this.streamWithContinuity(
      {
        projectId,
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
    await this.refreshStalePredecessors(projectId, episode.number);
    await this.ensureScene(projectId, episode, before, signal);
    emit({ type: 'stage', stage: 'MEMORY' });
    const memory = await this.memory.assemble(projectId, `${episode.direction}\n${extractLastParagraph(before)}`, episodeId);
    memory.currentScene = stringifyJson({
      ...parseJson<Record<string, unknown>>(memory.currentScene, {}),
      previousParagraph: extractLastParagraph(before),
    });
    emit({ type: 'stage', stage: 'WRITING' });
    await this.streamWithContinuity(
      {
        projectId,
        episodeId,
        baseRevision: episode.revision,
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

  async replaceSelection(projectId: string, episodeId: string, body: unknown) {
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
    this.invalidateFrom(projectId, current.number + 1);
    return { episode: this.toView(this.requireEpisode(projectId, episodeId)) };
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
    const memory = await this.memory.assemble(projectId, `${episode.title}\n${episode.direction}`, episodeId);
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
      for (const candidate of value.canonCandidates ?? []) {
        const duplicate = this.database.orm
          .select({ id: canonEntries.id })
          .from(canonEntries)
          .where(and(eq(canonEntries.projectId, projectId), eq(canonEntries.name, candidate.name)))
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
    })();
    await Promise.all([
      this.indexEpisode(episode),
      this.memory.indexSource({
        projectId,
        sourceType: 'EPISODE_SUMMARY',
        sourceId: episodeId,
        text: [
          ...value.events,
          ...value.emotionalChanges.map((item) => `${item.character}: ${item.from} → ${item.to} (${item.cause})`),
          ...value.newForeshadowing.map((item) => `새 떡밥: ${item}`),
          ...value.resolvedForeshadowing.map((item) => `회수된 떡밥: ${item}`),
        ].join('\n'),
      }),
    ]);
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
    return this.getScene(projectId, episodeId);
  }

  private async streamWithContinuity(
    input: {
      projectId?: string;
      episodeId?: string;
      baseRevision?: number;
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
    emit({ type: 'stage', stage: 'CHECKING' });
    let review = await this.reviewContinuity(input, draft.result.content, signal);
    let finalContent = draft.result.content;
    if (review.some((issue) => issue.severity === 'BLOCKING')) {
      emit({ type: 'stage', stage: 'REPAIRING' });
      const repaired = await this.ai.streamText(
        {
          task: 'continuity_repair',
          promptId: 'continuity-repair',
          projectId: input.projectId,
          episodeId: input.episodeId,
          variables: {
            ...input.reviewVariables,
            candidate_text: draft.result.content,
            draft_text: draft.result.content,
            continuity_issues: stringifyJson(review),
            issues: stringifyJson(review),
            review_issues: stringifyJson(review),
          },
          signal,
          maxTokens: 32_000,
        },
        // Keep the completed draft visible until the entire replacement and
        // its review succeed. Failed or cancelled repairs never erase it.
        () => undefined,
      );
      if (!repaired.result.content.trim()) throw new BadGatewayException('AI returned an empty continuity repair');
      signal?.throwIfAborted();
      finalContent = repaired.result.content;
      emit({ type: 'stage', stage: 'CHECKING' });
      review = await this.reviewContinuity(input, finalContent, signal);
    }
    signal?.throwIfAborted();
    emit({
      type: 'done',
      content: finalContent,
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

  private invalidateFrom(projectId: string, startNumber: number): void {
    const affected = this.database.orm
      .select({ id: episodes.id })
      .from(episodes)
      .where(
        and(
          eq(episodes.projectId, projectId),
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
          eq(episodes.projectId, projectId),
          gte(episodes.number, startNumber),
          isNull(episodes.deletedAt),
        ),
      )
      .run();
    for (const row of affected) {
      this.memory.removeSource('EPISODE', row.id);
      this.memory.removeSource('EPISODE_SUMMARY', row.id);
    }
  }

  private removeEpisodeMemory(episodeId: string): void {
    this.memory.removeSource('EPISODE', episodeId);
    this.memory.removeSource('EPISODE_SUMMARY', episodeId);
  }

  private editedStatus(current: string, forceNeedsReview: boolean): string {
    if (forceNeedsReview) return 'NEEDS_REVIEW';
    if (current === 'DRAFT') return 'DRAFT';
    if (current === 'NEEDS_REVIEW') return 'NEEDS_REVIEW';
    return 'MEMORY_STALE';
  }

  private async refreshStalePredecessors(projectId: string, beforeNumber?: number): Promise<void> {
    const conditions = [
      eq(episodes.projectId, projectId),
      eq(episodes.status, 'MEMORY_STALE'),
      isNull(episodes.deletedAt),
    ];
    if (beforeNumber !== undefined) conditions.push(lt(episodes.number, beforeNumber));
    const stale = this.database.orm
      .select()
      .from(episodes)
      .where(and(...conditions))
      .orderBy(episodes.number)
      .all();
    for (const episode of stale) {
      if (episode.content.trim()) {
        await this.finalize(projectId, episode.id, { expectedRevision: episode.revision });
      }
    }
  }

  private async ensureScene(
    projectId: string,
    episode: typeof episodes.$inferSelect,
    textBeforeCursor: string,
    signal?: AbortSignal,
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
    const stamp = now();
    this.database.orm
      .insert(sceneStates)
      .values({
        episodeId: episode.id,
        location: value.location ?? '',
        storyTime: value.time ?? '',
        pointOfView: value.pointOfView ?? '',
        characterNamesJson: stringifyJson(value.characters),
        goal: value.goal ?? '',
        sourceRevision: episode.revision,
        updatedAt: stamp,
      })
      .onConflictDoUpdate({
        target: sceneStates.episodeId,
        set: {
          location: value.location ?? '',
          storyTime: value.time ?? '',
          pointOfView: value.pointOfView ?? '',
          characterNamesJson: stringifyJson(value.characters),
          goal: value.goal ?? '',
          sourceRevision: episode.revision,
          updatedAt: stamp,
        },
      })
      .run();
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

  private async indexEpisode(row: typeof episodes.$inferSelect): Promise<void> {
    await this.memory.indexSource({
      projectId: row.projectId,
      sourceType: 'EPISODE',
      sourceId: row.id,
      text: `${row.number}화 ${row.title}\n방향: ${row.direction}\n${row.content}`,
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
