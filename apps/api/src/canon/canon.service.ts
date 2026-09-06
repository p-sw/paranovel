import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import { AiRunnerService } from '../ai/ai-runner.service';
import { worldbuildingSchema, worldbuildingValidator } from '../ai/ai.schemas';
import { DatabaseService } from '../database/database.service';
import { canonEntries, episodes } from '../database/schema';
import { MemoryService } from '../memory/memory.service';
import {
  assertEnum,
  id,
  now,
  optionalString,
  parseJson,
  requireString,
  stringifyJson,
  stringArray,
} from '../shared/utils';

const CATEGORIES = ['CHARACTER', 'CHARACTER_APPEARANCE', 'LOCATION', 'ORGANIZATION', 'ABILITY', 'RULE', 'TIMELINE', 'OTHER'] as const;
const STATUSES = ['ACTIVE', 'PENDING', 'ACCEPTED', 'REJECTED'] as const;

@Injectable()
export class CanonService {
  constructor(
    private readonly database: DatabaseService,
    private readonly memory: MemoryService,
    private readonly ai: AiRunnerService,
  ) {}

  list(projectId: string, status?: string) {
    const rows = this.database.orm
      .select()
      .from(canonEntries)
      .where(
        status
          ? and(
              eq(canonEntries.projectId, projectId),
              isNull(canonEntries.sideStoryGroupId),
              eq(canonEntries.status, status),
            )
          : and(
              eq(canonEntries.projectId, projectId),
              isNull(canonEntries.sideStoryGroupId),
            ),
      )
      .all();
    return rows.map((row) => this.toView(row));
  }

  get(projectId: string, canonId: string) {
    const row = this.database.orm
      .select()
      .from(canonEntries)
      .where(and(
        eq(canonEntries.id, canonId),
        eq(canonEntries.projectId, projectId),
        isNull(canonEntries.sideStoryGroupId),
      ))
      .get();
    if (!row) throw new NotFoundException('Canon entry not found');
    return this.toView(row);
  }

  async create(projectId: string, body: unknown) {
    const value = this.persistCreate(projectId, body);
    await this.syncMemory(projectId, value.id);
    return value;
  }

  persistCreate(projectId: string, body: unknown) {
    const input = (body ?? {}) as Record<string, unknown>;
    const stamp = now();
    const entryId = id();
    const sourceEpisodeId = this.mainSourceEpisodeId(projectId, input.sourceEpisodeId);
    const row: typeof canonEntries.$inferInsert = {
      id: entryId,
      projectId,
      category: assertEnum(input.category, 'category', CATEGORIES),
      name: requireString(input.name, 'name', { max: 200 }),
      aliasesJson: stringifyJson(input.aliases === undefined ? [] : stringArray(input.aliases, 'aliases')),
      content: requireString(input.content, 'content', { max: 50_000 }),
      metadataJson: stringifyJson(
        input.metadata && typeof input.metadata === 'object' && !Array.isArray(input.metadata)
          ? input.metadata
          : {},
      ),
      status: input.status === undefined ? 'ACTIVE' : assertEnum(input.status, 'status', STATUSES),
      revision: 1,
      sourceEpisodeId,
      sideStoryGroupId: null,
      createdAt: stamp,
      updatedAt: stamp,
    };
    this.database.orm.insert(canonEntries).values(row).run();
    return this.get(projectId, entryId);
  }

  private mainSourceEpisodeId(projectId: string, value: unknown): string | null {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string') throw new BadRequestException('sourceEpisodeId must be a string or null');
    const source = this.database.orm.select({ id: episodes.id }).from(episodes).where(and(
      eq(episodes.id, value),
      eq(episodes.projectId, projectId),
      eq(episodes.kind, 'MAIN'),
      isNull(episodes.deletedAt),
    )).get();
    if (!source) {
      throw new BadRequestException('sourceEpisodeId must reference a live main episode in this project');
    }
    return source.id;
  }

  async update(projectId: string, canonId: string, body: unknown) {
    const value = this.persistUpdate(projectId, canonId, body);
    await this.syncMemory(projectId, canonId);
    return value;
  }

  persistUpdate(projectId: string, canonId: string, body: unknown) {
    const current = this.database.orm
      .select()
      .from(canonEntries)
      .where(and(
        eq(canonEntries.id, canonId),
        eq(canonEntries.projectId, projectId),
        isNull(canonEntries.sideStoryGroupId),
      ))
      .get();
    if (!current) throw new NotFoundException('Canon entry not found');
    const input = (body ?? {}) as Record<string, unknown>;
    if (!Number.isInteger(input.expectedRevision)) {
      throw new BadRequestException('expectedRevision is required');
    }
    if (input.expectedRevision !== current.revision) {
      throw new ConflictException('Canon entry revision is stale');
    }
    const changes: Partial<typeof canonEntries.$inferInsert> = {
      revision: current.revision + 1,
      updatedAt: now(),
    };
    if ('category' in input) changes.category = assertEnum(input.category, 'category', CATEGORIES);
    if ('name' in input) changes.name = requireString(input.name, 'name', { max: 200 });
    if ('aliases' in input) changes.aliasesJson = stringifyJson(stringArray(input.aliases, 'aliases'));
    if ('content' in input) changes.content = requireString(input.content, 'content', { max: 50_000 });
    if ('metadata' in input) changes.metadataJson = stringifyJson(input.metadata ?? {});
    if ('status' in input) changes.status = assertEnum(input.status, 'status', STATUSES);
    const result = this.database.orm
      .update(canonEntries)
      .set(changes)
      .where(and(eq(canonEntries.id, canonId), eq(canonEntries.revision, current.revision)))
      .run();
    if (result.changes !== 1) throw new ConflictException('Canon entry revision changed during update');
    const updated = this.database.orm.select().from(canonEntries).where(eq(canonEntries.id, canonId)).get()!;
    return this.toView(updated);
  }

  remove(projectId: string, canonId: string): void {
    this.get(projectId, canonId);
    this.memory.removeSource('CANON', canonId);
    this.database.orm.delete(canonEntries).where(eq(canonEntries.id, canonId)).run();
  }

  async generate(projectId: string, body: unknown) {
    const input = (body ?? {}) as Record<string, unknown>;
    const request = optionalString(input.request, 'request', 5_000) ?? '';
    const memory = await this.memory.assemble(projectId, request);
    const { value } = await this.ai.completeJson<{
      suggestions: Array<Record<string, unknown>>;
      conflicts: string[];
    }>({
      task: 'worldbuilding_generate',
      promptId: 'worldbuilding-generate',
      projectId,
      variables: {
        project_context: memory.projectContext,
        improvements: memory.improvements,
        canon: memory.canon,
        current_arc: memory.currentArc,
        current_scene: memory.currentScene,
        recent_summaries: memory.recentSummaries,
        open_foreshadowing: memory.openForeshadowing,
        retrieved_memories: memory.retrievedMemories,
        generation_request: request,
      },
      schema: { name: 'worldbuilding_suggestions', value: worldbuildingSchema },
      validator: worldbuildingValidator,
      maxTokens: 8_000,
    });
    return value;
  }

  async syncMemory(projectId: string, canonId: string): Promise<void> {
    this.get(projectId, canonId);
    const row = this.database.orm.select().from(canonEntries).where(eq(canonEntries.id, canonId)).get()!;
    if (row.status === 'ACTIVE' || row.status === 'ACCEPTED') await this.index(row);
    else this.memory.removeSource('CANON', canonId);
  }

  private async index(row: typeof canonEntries.$inferSelect): Promise<void> {
    await this.memory.indexSource({
      projectId: row.projectId,
      sourceType: 'CANON',
      sourceId: row.id,
      text: `${row.category}: ${row.name}\n별칭: ${parseJson<string[]>(row.aliasesJson, []).join(', ')}\n${row.content}`,
    });
  }

  private toView(row: typeof canonEntries.$inferSelect) {
    return {
      id: row.id,
      projectId: row.projectId,
      category: row.category,
      name: row.name,
      aliases: parseJson<string[]>(row.aliasesJson, []),
      content: row.content,
      metadata: parseJson<Record<string, unknown>>(row.metadataJson, {}),
      status: row.status,
      revision: row.revision,
      sourceEpisodeId: row.sourceEpisodeId,
      sideStoryGroupId: row.sideStoryGroupId,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
