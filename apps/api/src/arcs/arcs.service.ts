import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { AiRunnerService } from '../ai/ai-runner.service';
import { arcPlanSchema, arcPlanValidator } from '../ai/ai.schemas';
import { DatabaseService } from '../database/database.service';
import { arcs, projects } from '../database/schema';
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

@Injectable()
export class ArcsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly memory: MemoryService,
    private readonly ai: AiRunnerService,
  ) {}

  list(projectId: string) {
    return this.database.orm
      .select()
      .from(arcs)
      .where(eq(arcs.projectId, projectId))
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
    const { value } = await this.ai.completeJson({
      task: 'arc_plan',
      promptId: 'arc-plan',
      projectId,
      variables: {
        project_context: memory.projectContext,
        improvements: memory.improvements,
        canon: memory.canon,
        previous_arcs: stringifyJson(this.list(projectId)),
        current_scene: memory.currentScene,
        recent_summaries: memory.recentSummaries,
        open_foreshadowing: memory.openForeshadowing,
        retrieved_memories: memory.retrievedMemories,
        start_episode_number: project.nextEpisodeNumber,
        arc_request: request,
      },
      schema: { name: 'arc_plan', value: arcPlanSchema },
      validator: arcPlanValidator,
      maxTokens: 8_000,
    });
    return value;
  }

  async create(projectId: string, body: unknown) {
    const value = this.persistCreate(projectId, body);
    await this.syncMemory(projectId, value.id);
    return value;
  }

  persistCreate(projectId: string, body: unknown) {
    const input = (body ?? {}) as Record<string, unknown>;
    const start = this.integer(input.startEpisodeNumber ?? input.startEpisode, 'startEpisodeNumber');
    const end = this.integer(input.endEpisodeNumber ?? input.endEpisode, 'endEpisodeNumber');
    this.validateSpan(start, end);
    const status = input.status === undefined ? 'PLANNED' : assertEnum(input.status, 'status', STATUSES);
    const stamp = now();
    const arcId = id();
    const row: typeof arcs.$inferInsert = {
      id: arcId,
      projectId,
      title: requireString(input.title, 'title', { max: 200 }),
      startEpisodeNumber: start,
      endEpisodeNumber: end,
      goal: requireString(input.goal, 'goal', { max: 10_000 }),
      conflict: requireString(input.conflict, 'conflict', { max: 10_000 }),
      reversalPlanJson: stringifyJson(Array.isArray(input.reversalPlan) ? input.reversalPlan : []),
      status,
      revision: 1,
      createdAt: stamp,
      updatedAt: stamp,
    };
    this.database.connection.transaction(() => {
      if (status === 'ACTIVE') this.demoteCurrent(projectId);
      this.database.orm.insert(arcs).values(row).run();
    })();
    return this.get(projectId, arcId);
  }

  get(projectId: string, arcId: string) {
    const row = this.database.orm
      .select()
      .from(arcs)
      .where(and(eq(arcs.id, arcId), eq(arcs.projectId, projectId)))
      .get();
    if (!row) throw new NotFoundException('Arc not found');
    return this.toView(row);
  }

  async update(projectId: string, arcId: string, body: unknown) {
    const value = this.persistUpdate(projectId, arcId, body);
    await this.syncMemory(projectId, arcId);
    return value;
  }

  persistUpdate(projectId: string, arcId: string, body: unknown) {
    const current = this.database.orm
      .select()
      .from(arcs)
      .where(and(eq(arcs.id, arcId), eq(arcs.projectId, projectId)))
      .get();
    if (!current) throw new NotFoundException('Arc not found');
    const input = (body ?? {}) as Record<string, unknown>;
    if (!Number.isInteger(input.expectedRevision)) {
      throw new BadRequestException('expectedRevision is required');
    }
    if (input.expectedRevision !== current.revision) {
      throw new ConflictException('Arc revision is stale');
    }
    const start = 'startEpisodeNumber' in input
      ? this.integer(input.startEpisodeNumber, 'startEpisodeNumber')
      : current.startEpisodeNumber;
    const end = 'endEpisodeNumber' in input
      ? this.integer(input.endEpisodeNumber, 'endEpisodeNumber')
      : current.endEpisodeNumber;
    this.validateSpan(start, end);
    const changes: Partial<typeof arcs.$inferInsert> = {
      startEpisodeNumber: start,
      endEpisodeNumber: end,
      updatedAt: now(),
      revision: current.revision + 1,
    };
    if ('title' in input) changes.title = requireString(input.title, 'title', { max: 200 });
    if ('goal' in input) changes.goal = requireString(input.goal, 'goal', { max: 10_000 });
    if ('conflict' in input) changes.conflict = requireString(input.conflict, 'conflict', { max: 10_000 });
    if ('reversalPlan' in input) changes.reversalPlanJson = stringifyJson(input.reversalPlan);
    if ('status' in input) changes.status = assertEnum(input.status, 'status', STATUSES);
    this.database.connection.transaction(() => {
      if (changes.status === 'ACTIVE') this.demoteCurrent(projectId, arcId);
      const result = this.database.orm
        .update(arcs)
        .set(changes)
        .where(and(eq(arcs.id, arcId), eq(arcs.revision, current.revision)))
        .run();
      if (result.changes !== 1) throw new ConflictException('Arc revision changed during update');
    })();
    const updated = this.database.orm.select().from(arcs).where(eq(arcs.id, arcId)).get()!;
    return this.toView(updated);
  }

  remove(projectId: string, arcId: string): void {
    this.get(projectId, arcId);
    this.memory.removeSource('ARC', arcId);
    this.database.orm.delete(arcs).where(eq(arcs.id, arcId)).run();
  }

  private demoteCurrent(projectId: string, exceptId?: string): void {
    const rows = this.database.orm
      .select({ id: arcs.id, revision: arcs.revision })
      .from(arcs)
      .where(
        and(
          eq(arcs.projectId, projectId),
          eq(arcs.status, 'ACTIVE'),
        ),
      )
      .all();
    for (const row of rows) {
      if (row.id !== exceptId) {
        this.database.orm
          .update(arcs)
          .set({
            status: 'ARCHIVED',
            updatedAt: now(),
            revision: row.revision + 1,
          })
          .where(eq(arcs.id, row.id))
          .run();
      }
    }
  }

  private validateSpan(start: number, end: number): void {
    const span = end - start + 1;
    if (span < 5 || span > 20) throw new BadRequestException('Arc must span between 5 and 20 episodes');
  }

  private integer(value: unknown, field: string): number {
    const number = Number(value);
    if (!Number.isInteger(number) || number < 1) throw new BadRequestException(`${field} must be a positive integer`);
    return number;
  }

  async syncMemory(projectId: string, arcId: string): Promise<void> {
    this.get(projectId, arcId);
    const row = this.database.orm.select().from(arcs).where(eq(arcs.id, arcId)).get()!;
    await this.index(row);
  }

  private async index(row: typeof arcs.$inferSelect): Promise<void> {
    await this.memory.indexSource({
      projectId: row.projectId,
      sourceType: 'ARC',
      sourceId: row.id,
      text: formatArcMemory(row),
    });
  }

  private toView(row: typeof arcs.$inferSelect) {
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
      reversalPlan: parseJson(row.reversalPlanJson, []),
      status: row.status,
      revision: row.revision,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
