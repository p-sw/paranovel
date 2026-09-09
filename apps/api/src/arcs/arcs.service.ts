import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, eq, isNull, max, sql } from 'drizzle-orm';
import { ArcEpisodeDirectionsService } from '../ai/arc-episode-directions.service';
import { AiRunnerService } from '../ai/ai-runner.service';
import {
  arcMilestonePlanSchema,
  arcMilestonePlanValidator,
  arcPlanValidator,
} from '../ai/ai.schemas';
import { DatabaseService } from '../database/database.service';
import { arcs, episodes, projects } from '../database/schema';
import { formatArcMemory } from '../memory/arc-memory';
import { MemoryService } from '../memory/memory.service';
import {
  assertEnum,
  id,
  now,
  optionalString,
  parseJson,
  requireString,
  stringifyJson,
} from '../shared/utils';

const STATUSES = ['PLANNED', 'ACTIVE', 'COMPLETE', 'ARCHIVED'] as const;
const CREATABLE_STATUSES = ['PLANNED', 'ACTIVE'] as const;
const MILESTONE_TYPES = [
  'GOAL',
  'REVERSAL',
  'ESCALATION',
  'CLIMAX',
  'RESOLUTION',
  'OTHER',
] as const;

type ArcMilestone = {
  id?: string;
  episode: number;
  type: (typeof MILESTONE_TYPES)[number];
  description: string;
};

type ArcEpisodeDirection = {
  episode: number;
  title: string;
  direction: string;
};

@Injectable()
export class ArcsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly memory: MemoryService,
    private readonly ai: AiRunnerService,
    private readonly arcDirections: ArcEpisodeDirectionsService,
  ) {}

  list(projectId: string) {
    return this.database.orm
      .select()
      .from(arcs)
      .where(and(eq(arcs.projectId, projectId), isNull(arcs.sideStoryGroupId)))
      .orderBy(asc(arcs.startEpisodeNumber), asc(arcs.createdAt))
      .all()
      .map((row) => this.toView(row));
  }

  current(projectId: string) {
    const row = this.database.orm
      .select()
      .from(arcs)
      .where(
        and(
          eq(arcs.projectId, projectId),
          isNull(arcs.sideStoryGroupId),
          eq(arcs.status, 'ACTIVE'),
        ),
      )
      .get();
    return row ? this.toView(row) : null;
  }

  async plan(projectId: string, body: unknown) {
    const project = this.database.orm
      .select()
      .from(projects)
      .where(eq(projects.id, projectId))
      .get();
    if (!project || project.deletedAt) throw new NotFoundException('Project not found');
    const input = (body ?? {}) as Record<string, unknown>;
    const request = optionalString(input.request, 'request', 10_000) ?? '';
    const memory = await this.memory.assemble(projectId, request);
    const allArcs = this.list(projectId);
    const currentArc = allArcs.find((arc) => arc.status === 'ACTIVE') ?? null;
    const futureArcs = allArcs.filter((arc) => arc.status === 'PLANNED');
    const nextUnwrittenEpisode = Math.max(
      project.nextEpisodeNumber,
      currentArc ? currentArc.endEpisodeNumber + 1 : 1,
    );
    const firstFuture = futureArcs[0] ?? null;
    if (firstFuture && firstFuture.startEpisodeNumber < nextUnwrittenEpisode) {
      throw new BadRequestException('A planned arc sits before or overlaps the next writable episode');
    }
    const replacement = firstFuture?.startEpisodeNumber === nextUnwrittenEpisode ? firstFuture : null;
    const startEpisode = replacement?.startEpisodeNumber ?? nextUnwrittenEpisode;
    const endEpisode = replacement?.endEpisodeNumber
      ?? (firstFuture ? firstFuture.startEpisodeNumber - 1 : project.targetEpisode);
    if (!replacement && endEpisode !== null && endEpisode - startEpisode + 1 < 5) {
      throw new BadRequestException('There is no room for another 5-episode arc before the target ending');
    }
    const planValidator = arcMilestonePlanValidator.superRefine((value, context) => {
      if (value.startEpisodeNumber !== startEpisode) {
        context.addIssue({
          code: 'custom', message: `Arc plan must start at episode ${startEpisode}`, path: ['startEpisodeNumber'],
        });
      }
      if (replacement && value.endEpisodeNumber !== replacement.endEpisodeNumber) {
        context.addIssue({
          code: 'custom', message: `Revised arc must end at episode ${replacement.endEpisodeNumber}`, path: ['endEpisodeNumber'],
        });
      } else if (!replacement && endEpisode !== null) {
        if (value.endEpisodeNumber > endEpisode) {
          context.addIssue({
            code: 'custom', message: `Arc plan cannot pass target episode ${endEpisode}`, path: ['endEpisodeNumber'],
          });
        } else {
          const remaining = endEpisode - value.endEpisodeNumber;
          if (remaining > 0 && remaining < 5) {
            context.addIssue({
              code: 'custom',
              message: 'Arc plan must finish at the target or leave room for another 5-episode arc',
              path: ['endEpisodeNumber'],
            });
          }
        }
      }
    });
    const { value: milestonePlan } = await this.ai.completeJson({
      task: 'arc_plan',
      promptId: 'arc-plan',
      projectId,
      variables: {
        project_context: memory.projectContext,
        writing_direction: memory.writingDirection,
        improvements: memory.improvements,
        canon: memory.canon,
        previous_arcs: stringifyJson(allArcs.filter((arc) => arc.status === 'COMPLETE')),
        current_arc: stringifyJson(currentArc),
        future_arcs: stringifyJson(futureArcs),
        current_scene: memory.currentScene,
        recent_summaries: memory.recentSummaries,
        open_foreshadowing: memory.openForeshadowing,
        retrieved_memories: memory.retrievedMemories,
        start_episode_number: startEpisode,
        end_episode_number: endEpisode,
        arc_to_revise: stringifyJson(replacement),
        arc_request: request,
      },
      schema: { name: 'arc_milestone_plan', value: arcMilestonePlanSchema },
      validator: planValidator,
      maxTokens: 8_000,
    });
    const episodeDirections = await this.arcDirections.generate({
      projectId,
      projectContext: memory.projectContext,
      writingDirection: memory.writingDirection,
      canon: memory.canon,
      surroundingArcs: {
        previous: allArcs.filter((arc) => arc.status === 'COMPLETE'),
        current: currentArc,
        future: futureArcs,
      },
      arc: milestonePlan,
      generationRequest: request,
    });
    const value = arcPlanValidator.parse({ ...milestonePlan, episodeDirections });
    return {
      ...value,
      ...(replacement ? { replaceArcId: replacement.id, replaceArcRevision: replacement.revision } : {}),
    };
  }

  async create(projectId: string, body: unknown) {
    const previousActive = this.current(projectId);
    const value = this.persistCreate(projectId, body);
    await this.syncChangedArcs(projectId, value.id, previousActive?.id);
    return value;
  }

  persistCreate(projectId: string, body: unknown) {
    const input = (body ?? {}) as Record<string, unknown>;
    const start = this.integer(input.startEpisodeNumber ?? input.startEpisode, 'startEpisodeNumber');
    const end = this.integer(input.endEpisodeNumber ?? input.endEpisode, 'endEpisodeNumber');
    this.validateSpan(start, end);
    const title = requireString(input.title, 'title', { max: 200 });
    const goal = requireString(input.goal, 'goal', { max: 10_000 });
    const conflict = requireString(input.conflict, 'conflict', { max: 10_000 });
    const status = input.status === undefined
      ? 'PLANNED'
      : assertEnum(input.status, 'status', CREATABLE_STATUSES);
    const milestones = this.inputMilestones(input, start, end, goal);
    const episodeDirections = 'episodeDirections' in input
      ? this.episodeDirections(input.episodeDirections, start, end)
      : this.synthesizedEpisodeDirections(start, end, title, goal, milestones);
    const stamp = now();
    const arcId = id();
    const row: typeof arcs.$inferInsert = {
      id: arcId,
      projectId,
      sideStoryGroupId: null,
      title,
      startEpisodeNumber: start,
      endEpisodeNumber: end,
      goal,
      conflict,
      reversalPlanJson: stringifyJson(input.reversalPlan ?? []),
      milestonePlanJson: stringifyJson(milestones),
      episodeDirectionsJson: stringifyJson(episodeDirections),
      status,
      revision: 1,
      createdAt: stamp,
      updatedAt: stamp,
    };
    this.database.connection.transaction(() => {
      const active = status === 'ACTIVE'
        ? this.list(projectId).find((arc) => arc.status === 'ACTIVE')
        : undefined;
      if (active && this.replacementStatus(projectId, active) === 'ARCHIVED' && input.confirmProtected !== true) {
        throw new ConflictException('The current arc is not finished. Confirm replacing it explicitly');
      }
      if (status === 'ACTIVE') this.assertActiveCreationPosition(projectId, start, active);
      this.assertTimelinePlacement(projectId, null, start, end, status);
      if (status === 'ACTIVE') this.completeCurrent(projectId);
      this.database.orm.insert(arcs).values(row).run();
    }).immediate();
    return this.get(projectId, arcId);
  }

  get(projectId: string, arcId: string) {
    const row = this.database.orm
      .select()
      .from(arcs)
      .where(and(
        eq(arcs.id, arcId),
        eq(arcs.projectId, projectId),
        isNull(arcs.sideStoryGroupId),
      ))
      .get();
    if (!row) throw new NotFoundException('Arc not found');
    return this.toView(row);
  }

  async update(projectId: string, arcId: string, body: unknown) {
    const previousActive = this.current(projectId);
    const value = this.persistUpdate(projectId, arcId, body);
    await this.syncChangedArcs(projectId, arcId, previousActive?.id);
    return value;
  }

  persistUpdate(projectId: string, arcId: string, body: unknown) {
    const current = this.database.orm
      .select()
      .from(arcs)
      .where(and(
        eq(arcs.id, arcId),
        eq(arcs.projectId, projectId),
        isNull(arcs.sideStoryGroupId),
      ))
      .get();
    if (!current) throw new NotFoundException('Arc not found');
    const input = (body ?? {}) as Record<string, unknown>;
    if (!Number.isInteger(input.expectedRevision)) {
      throw new BadRequestException('expectedRevision is required');
    }
    if (input.expectedRevision !== current.revision) {
      throw new ConflictException('Arc revision is stale');
    }
    const currentStatus = assertEnum(current.status, 'stored arc status', STATUSES);
    if (['COMPLETE', 'ARCHIVED'].includes(currentStatus)) {
      throw new ConflictException('Previous and archived arcs are read-only');
    }
    const requestedStatus = input.status === undefined
      ? currentStatus
      : assertEnum(input.status, 'status', STATUSES);
    if (currentStatus === 'PLANNED' && !['PLANNED', 'ACTIVE'].includes(requestedStatus)) {
      throw new BadRequestException('A planned arc can only remain planned or become active');
    }
    if (currentStatus === 'ACTIVE' && requestedStatus !== 'ACTIVE') {
      throw new BadRequestException('Advance by activating a planned arc instead of changing the current arc status');
    }
    const protectedFields = [
      'title', 'startEpisodeNumber', 'startEpisode', 'endEpisodeNumber', 'endEpisode',
      'goal', 'conflict', 'milestones', 'episodeDirections', 'reversalPlan',
    ];
    const editsProtectedPlan = currentStatus !== 'PLANNED'
      && protectedFields.some((field) => field in input);
    if (editsProtectedPlan && input.confirmProtected !== true) {
      throw new ConflictException('Current and previous arcs are protected. Confirm the protected edit explicitly');
    }
    const changesStart = 'startEpisodeNumber' in input || 'startEpisode' in input;
    const changesEnd = 'endEpisodeNumber' in input || 'endEpisode' in input;
    const start = changesStart
      ? this.integer(input.startEpisodeNumber ?? input.startEpisode, 'startEpisodeNumber')
      : current.startEpisodeNumber;
    const end = changesEnd
      ? this.integer(input.endEpisodeNumber ?? input.endEpisode, 'endEpisodeNumber')
      : current.endEpisodeNumber;
    this.validateSpan(start, end);
    const title = 'title' in input
      ? requireString(input.title, 'title', { max: 200 })
      : current.title;
    const goal = 'goal' in input
      ? requireString(input.goal, 'goal', { max: 10_000 })
      : current.goal;
    const conflict = 'conflict' in input
      ? requireString(input.conflict, 'conflict', { max: 10_000 })
      : current.conflict;
    const explicitlyChangesMilestones = 'milestones' in input || 'reversalPlan' in input;
    const storedMilestones = this.storedMilestones(
      current,
      current.startEpisodeNumber,
      current.endEpisodeNumber,
      goal,
    );
    const milestones = explicitlyChangesMilestones
      ? this.inputMilestones(input, start, end, goal)
      : changesStart || changesEnd
        ? this.milestones(storedMilestones, start, end)
        : storedMilestones;
    const regeneratesDirections = changesStart || changesEnd
      || explicitlyChangesMilestones;
    const episodeDirections = 'episodeDirections' in input
      ? this.episodeDirections(input.episodeDirections, start, end)
      : regeneratesDirections
        ? this.synthesizedEpisodeDirections(start, end, title, goal, milestones)
        : this.storedEpisodeDirections(current, start, end, title, goal, milestones);
    const changes: Partial<typeof arcs.$inferInsert> = {
      startEpisodeNumber: start,
      endEpisodeNumber: end,
      milestonePlanJson: stringifyJson(milestones),
      episodeDirectionsJson: stringifyJson(episodeDirections),
      updatedAt: now(),
      revision: current.revision + 1,
    };
    if ('title' in input) changes.title = title;
    if ('goal' in input) changes.goal = goal;
    if ('conflict' in input) changes.conflict = conflict;
    if ('status' in input) changes.status = requestedStatus;
    this.database.connection.transaction(() => {
      if (changesStatusToActive(input, currentStatus)) {
        this.assertEarliestPlanned(projectId, arcId);
        const active = this.list(projectId).find((arc) => arc.status === 'ACTIVE' && arc.id !== arcId);
        if (active && this.replacementStatus(projectId, active) === 'ARCHIVED' && input.confirmProtected !== true) {
          throw new ConflictException('The current arc is not finished. Confirm replacing it explicitly');
        }
      }
      if (changesStart || changesEnd || requestedStatus !== currentStatus) {
        this.assertTimelinePlacement(projectId, arcId, start, end, requestedStatus);
      }
      if (changes.status === 'ACTIVE') this.completeCurrent(projectId, arcId);
      const result = this.database.orm
        .update(arcs)
        .set(changes)
        .where(and(
          eq(arcs.id, arcId),
          eq(arcs.projectId, projectId),
          isNull(arcs.sideStoryGroupId),
          eq(arcs.revision, current.revision),
        ))
        .run();
      if (result.changes !== 1) throw new ConflictException('Arc revision changed during update');
    }).immediate();
    const updated = this.database.orm.select().from(arcs).where(and(
      eq(arcs.id, arcId),
      eq(arcs.projectId, projectId),
      isNull(arcs.sideStoryGroupId),
    )).get()!;
    return this.toView(updated);
  }

  remove(projectId: string, arcId: string, body: unknown): void {
    const input = (body ?? {}) as Record<string, unknown>;
    if (!Number.isInteger(input.expectedRevision)) {
      throw new BadRequestException('expectedRevision is required');
    }
    const result = this.database.orm.delete(arcs).where(and(
      eq(arcs.id, arcId),
      eq(arcs.projectId, projectId),
      isNull(arcs.sideStoryGroupId),
      eq(arcs.status, 'PLANNED'),
      eq(arcs.revision, Number(input.expectedRevision)),
    )).run();
    if (result.changes !== 1) {
      const existing = this.database.orm.select({ id: arcs.id, status: arcs.status, revision: arcs.revision }).from(arcs)
        .where(and(
          eq(arcs.id, arcId),
          eq(arcs.projectId, projectId),
          isNull(arcs.sideStoryGroupId),
        )).get();
      if (!existing) throw new NotFoundException('Arc not found');
      if (existing.status !== 'PLANNED') throw new ConflictException('Only future planned arcs can be deleted');
      throw new ConflictException('Arc revision is stale');
    }
    this.memory.removeSource('ARC', arcId);
  }

  private completeCurrent(projectId: string, exceptId?: string): void {
    const rows = this.database.orm
      .select({ id: arcs.id, revision: arcs.revision })
      .from(arcs)
      .where(
        and(
          eq(arcs.projectId, projectId),
          isNull(arcs.sideStoryGroupId),
          eq(arcs.status, 'ACTIVE'),
        ),
      )
      .all();
    for (const row of rows) {
      if (row.id !== exceptId) {
        const current = this.get(projectId, row.id);
        const result = this.database.orm
          .update(arcs)
          .set({
            status: this.replacementStatus(projectId, current),
            updatedAt: now(),
            revision: row.revision + 1,
          })
          .where(and(
            eq(arcs.id, row.id),
            eq(arcs.projectId, projectId),
            isNull(arcs.sideStoryGroupId),
            eq(arcs.revision, row.revision),
          ))
          .run();
        if (result.changes !== 1) throw new ConflictException('Current arc revision changed during activation');
      }
    }
  }

  private assertEarliestPlanned(projectId: string, arcId: string): void {
    const earliest = this.database.orm
      .select({ id: arcs.id, startEpisodeNumber: arcs.startEpisodeNumber })
      .from(arcs)
      .where(and(
        eq(arcs.projectId, projectId),
        isNull(arcs.sideStoryGroupId),
        eq(arcs.status, 'PLANNED'),
      ))
      .orderBy(asc(arcs.startEpisodeNumber), asc(arcs.createdAt))
      .get();
    if (!earliest || earliest.id !== arcId) {
      throw new BadRequestException('Only the earliest future arc can become the current arc');
    }
    const timeline = this.database.orm
      .select({ status: arcs.status, endEpisodeNumber: arcs.endEpisodeNumber })
      .from(arcs)
      .where(and(eq(arcs.projectId, projectId), isNull(arcs.sideStoryGroupId)))
      .all();
    const current = timeline.find((arc) => arc.status === 'ACTIVE');
    const completedEnd = timeline
      .filter((arc) => arc.status === 'COMPLETE')
      .reduce((latest, arc) => Math.max(latest, arc.endEpisodeNumber), 0);
    const project = this.database.orm
      .select({ nextEpisodeNumber: projects.nextEpisodeNumber })
      .from(projects)
      .where(eq(projects.id, projectId))
      .get();
    const expectedStart = current
      ? current.endEpisodeNumber + 1
      : Math.max(completedEnd + 1, project?.nextEpisodeNumber ?? 1);
    if (earliest.startEpisodeNumber !== expectedStart) {
      throw new BadRequestException(`The next current arc must start at episode ${expectedStart}`);
    }
  }

  private assertActiveCreationPosition(
    projectId: string,
    startEpisode: number,
    current?: { startEpisode: number; endEpisode: number },
  ): void {
    const timeline = this.list(projectId);
    const earlierPlanned = timeline.find((arc) =>
      arc.status === 'PLANNED' && arc.startEpisode < startEpisode,
    );
    if (earlierPlanned) {
      throw new BadRequestException('An active arc cannot skip an earlier future plan');
    }
    if (current) {
      const replacesCurrent = startEpisode <= current.endEpisode;
      const expectedStart = replacesCurrent ? current.startEpisode : current.endEpisode + 1;
      if (startEpisode !== expectedStart) {
        throw new BadRequestException(`A new current arc must start at episode ${expectedStart}`);
      }
      return;
    }
    const completedEnd = timeline
      .filter((arc) => arc.status === 'COMPLETE')
      .reduce((latest, arc) => Math.max(latest, arc.endEpisode), 0);
    const project = this.database.orm
      .select({ nextEpisodeNumber: projects.nextEpisodeNumber })
      .from(projects)
      .where(eq(projects.id, projectId))
      .get();
    const expectedStart = Math.max(completedEnd + 1, project?.nextEpisodeNumber ?? 1);
    if (startEpisode !== expectedStart) {
      throw new BadRequestException(`A new current arc must start at episode ${expectedStart}`);
    }
  }

  replacementStatus(projectId: string, arc: { endEpisode: number }): 'COMPLETE' | 'ARCHIVED' {
    const latest = this.database.orm
      .select({ number: max(episodes.number) })
      .from(episodes)
      .where(and(
        eq(episodes.projectId, projectId),
        eq(episodes.kind, 'MAIN'),
        isNull(episodes.deletedAt),
        sql`length(trim(${episodes.content})) > 0`,
      ))
      .get()?.number ?? 0;
    return latest >= arc.endEpisode ? 'COMPLETE' : 'ARCHIVED';
  }

  private validateSpan(start: number, end: number): void {
    const span = end - start + 1;
    if (span < 5 || span > 20) throw new BadRequestException('Arc must span between 5 and 20 episodes');
  }

  private assertTimelinePlacement(
    projectId: string,
    arcId: string | null,
    start: number,
    end: number,
    status: (typeof STATUSES)[number],
  ): void {
    const project = this.database.orm
      .select({ targetEpisode: projects.targetEpisode, deletedAt: projects.deletedAt })
      .from(projects)
      .where(eq(projects.id, projectId))
      .get();
    if (!project || project.deletedAt) throw new NotFoundException('Project not found');
    if (project.targetEpisode !== null && end > project.targetEpisode) {
      throw new BadRequestException(`Arc cannot pass target episode ${project.targetEpisode}`);
    }

    const occupied = this.database.orm
      .select({
        id: arcs.id,
        startEpisodeNumber: arcs.startEpisodeNumber,
        endEpisodeNumber: arcs.endEpisodeNumber,
        status: arcs.status,
      })
      .from(arcs)
      .where(and(eq(arcs.projectId, projectId), isNull(arcs.sideStoryGroupId)))
      .all()
      .filter((arc) => arc.id !== arcId && arc.status !== 'ARCHIVED')
      .filter((arc) => {
        if (status !== 'ACTIVE' || arc.status !== 'ACTIVE') return true;
        return this.replacementStatus(projectId, { endEpisode: arc.endEpisodeNumber }) === 'COMPLETE';
      });

    if (occupied.some((arc) => start <= arc.endEpisodeNumber && end >= arc.startEpisodeNumber)) {
      throw new BadRequestException('Current, previous, and future arc ranges cannot overlap');
    }

    if (project.targetEpisode === null) return;
    const timeline = [
      ...occupied.map((arc) => ({ start: arc.startEpisodeNumber, end: arc.endEpisodeNumber })),
      { start, end },
    ].sort((left, right) => left.start - right.start || left.end - right.end);
    let nextEpisode = 1;
    for (const arc of timeline) {
      if (arc.start > nextEpisode) {
        const gap = arc.start - nextEpisode;
        if (gap < 5) {
          throw new BadRequestException('Arc changes cannot leave a gap shorter than five episodes');
        }
      }
      nextEpisode = Math.max(nextEpisode, arc.end + 1);
    }
    if (nextEpisode <= project.targetEpisode) {
      const tail = project.targetEpisode - nextEpisode + 1;
      if (tail < 5) {
        throw new BadRequestException('Arc changes must finish at the target or leave at least five episodes');
      }
    }
  }

  private integer(value: unknown, field: string): number {
    const number = Number(value);
    if (!Number.isInteger(number) || number < 1) throw new BadRequestException(`${field} must be a positive integer`);
    return number;
  }

  private inputMilestones(
    input: Record<string, unknown>,
    start: number,
    end: number,
    goal: string,
  ): ArcMilestone[] {
    if ('milestones' in input) return this.milestones(input.milestones, start, end);
    if ('reversalPlan' in input) {
      if (!Array.isArray(input.reversalPlan)) {
        throw new BadRequestException('reversalPlan must be an array');
      }
      if (input.reversalPlan.length > 0) {
        return this.milestones(input.reversalPlan.map((value) => (
          value && typeof value === 'object' && !Array.isArray(value)
            ? { ...(value as Record<string, unknown>), type: 'REVERSAL' }
            : value
        )), start, end);
      }
    }
    return [{ episode: end, type: 'GOAL', description: goal }];
  }

  private milestones(value: unknown, start: number, end: number): ArcMilestone[] {
    if (!Array.isArray(value)) throw new BadRequestException('milestones must be an array');
    if (value.length === 0) throw new BadRequestException('milestones must contain at least one item');
    return value.map((raw, index) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new BadRequestException(`milestones[${index}] must be an object`);
      }
      const item = raw as Record<string, unknown>;
      const episode = this.integer(item.episode, `milestones[${index}].episode`);
      if (episode < start || episode > end) {
        throw new BadRequestException('Milestone episodes must be inside their arc');
      }
      const type = assertEnum(item.type, `milestones[${index}].type`, MILESTONE_TYPES);
      const description = requireString(item.description, `milestones[${index}].description`, { max: 10_000 });
      const beatId = typeof item.id === 'string' && item.id.trim() ? item.id.trim() : undefined;
      return { ...(beatId ? { id: beatId } : {}), episode, type, description };
    }).sort((left, right) => left.episode - right.episode);
  }

  private episodeDirections(value: unknown, start: number, end: number): ArcEpisodeDirection[] {
    if (!Array.isArray(value)) throw new BadRequestException('episodeDirections must be an array');
    const span = end - start + 1;
    if (value.length !== span) {
      throw new BadRequestException('episodeDirections must cover every episode in the arc exactly once');
    }
    return value.map((raw, index) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new BadRequestException(`episodeDirections[${index}] must be an object`);
      }
      const item = raw as Record<string, unknown>;
      const episode = this.integer(item.episode, `episodeDirections[${index}].episode`);
      const expectedEpisode = start + index;
      if (episode !== expectedEpisode) {
        throw new BadRequestException(
          `episodeDirections[${index}].episode must be ${expectedEpisode}`,
        );
      }
      return {
        episode,
        title: requireString(item.title, `episodeDirections[${index}].title`, { max: 200 }),
        direction: requireString(item.direction, `episodeDirections[${index}].direction`, { max: 20_000 }),
      };
    });
  }

  private storedMilestones(
    row: Pick<typeof arcs.$inferSelect, 'milestonePlanJson' | 'reversalPlanJson'>,
    start: number,
    end: number,
    goal: string,
  ): ArcMilestone[] {
    const normalize = (value: unknown, legacyReversal: boolean): ArcMilestone[] => (
      Array.isArray(value) ? value.flatMap((raw) => {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
        const item = raw as Record<string, unknown>;
        if (!Number.isInteger(item.episode) || Number(item.episode) < start || Number(item.episode) > end) return [];
        if (typeof item.description !== 'string' || !item.description.trim()) return [];
        const type = legacyReversal
          ? 'REVERSAL'
          : MILESTONE_TYPES.includes(item.type as (typeof MILESTONE_TYPES)[number])
            ? item.type as ArcMilestone['type']
            : null;
        if (!type) return [];
        const milestoneId = typeof item.id === 'string' && item.id.trim() ? item.id : undefined;
        return [{
          ...(milestoneId ? { id: milestoneId } : {}),
          episode: Number(item.episode),
          type,
          // Do not trim migrated descriptions: legacy reversal text is preserved verbatim.
          description: item.description,
        }];
      }) : []
    );
    const stored = normalize(parseJson<unknown>(row.milestonePlanJson, []), false);
    const milestones = stored.length > 0
      ? stored
      : normalize(parseJson<unknown>(row.reversalPlanJson, []), true);
    return (milestones.length > 0
      ? milestones
      : [{ episode: end, type: 'GOAL' as const, description: goal }]
    ).sort((left, right) => left.episode - right.episode);
  }

  private storedEpisodeDirections(
    row: Pick<typeof arcs.$inferSelect, 'episodeDirectionsJson'>,
    start: number,
    end: number,
    title: string,
    goal: string,
    milestones: ArcMilestone[],
  ): ArcEpisodeDirection[] {
    const value = parseJson<unknown>(row.episodeDirectionsJson, []);
    if (Array.isArray(value) && value.length === end - start + 1) {
      const directions = value.flatMap((raw, index): ArcEpisodeDirection[] => {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
        const item = raw as Record<string, unknown>;
        if (item.episode !== start + index || typeof item.title !== 'string' || !item.title.trim()
          || typeof item.direction !== 'string' || !item.direction.trim()) return [];
        return [{
          episode: start + index,
          title: item.title,
          direction: item.direction,
        }];
      });
      if (directions.length === value.length) return directions;
    }
    return this.synthesizedEpisodeDirections(start, end, title, goal, milestones);
  }

  private synthesizedEpisodeDirections(
    start: number,
    end: number,
    title: string,
    goal: string,
    milestones: ArcMilestone[],
  ): ArcEpisodeDirection[] {
    return Array.from({ length: end - start + 1 }, (_, index) => {
      const episode = start + index;
      const milestone = milestones.find((item) => item.episode === episode);
      return {
        episode,
        title: `${title} ${episode}화`,
        direction: milestone?.description ?? goal,
      };
    });
  }

  private async syncChangedArcs(projectId: string, changedId: string, previousActiveId?: string): Promise<void> {
    const ids = new Set([changedId]);
    if (
      previousActiveId
      && previousActiveId !== changedId
      && this.current(projectId)?.id !== previousActiveId
    ) ids.add(previousActiveId);
    await Promise.all([...ids].map((arcId) => this.syncMemory(projectId, arcId)));
  }

  async syncMemory(projectId: string, arcId: string): Promise<void> {
    const value = this.get(projectId, arcId);
    if (!['ACTIVE', 'COMPLETE'].includes(value.status)) {
      this.memory.removeSource('ARC', arcId);
      return;
    }
    const row = this.database.orm.select().from(arcs).where(and(
      eq(arcs.id, arcId),
      eq(arcs.projectId, projectId),
      isNull(arcs.sideStoryGroupId),
    )).get()!;
    await this.index(row);
  }

  private async index(row: typeof arcs.$inferSelect): Promise<void> {
    await this.memory.indexSource({
      projectId: row.projectId,
      sideStoryGroupId: row.sideStoryGroupId,
      sourceType: 'ARC',
      sourceId: row.id,
      text: formatArcMemory(row),
    });
  }

  private toView(row: typeof arcs.$inferSelect) {
    const milestones = this.storedMilestones(
      row,
      row.startEpisodeNumber,
      row.endEpisodeNumber,
      row.goal,
    );
    const episodeDirections = this.storedEpisodeDirections(
      row,
      row.startEpisodeNumber,
      row.endEpisodeNumber,
      row.title,
      row.goal,
      milestones,
    );
    return {
      id: row.id,
      projectId: row.projectId,
      title: row.title,
      startEpisodeNumber: row.startEpisodeNumber,
      endEpisodeNumber: row.endEpisodeNumber,
      startEpisode: row.startEpisodeNumber,
      endEpisode: row.endEpisodeNumber,
      goal: row.goal,
      conflict: row.conflict,
      milestones,
      episodeDirections,
      status: row.status,
      revision: row.revision,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}

function changesStatusToActive(input: Record<string, unknown>, currentStatus: string): boolean {
  return input.status === 'ACTIVE' && currentStatus !== 'ACTIVE';
}
