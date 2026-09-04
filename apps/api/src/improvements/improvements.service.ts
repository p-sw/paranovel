import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, eq, isNull, or } from 'drizzle-orm';
import { AiRunnerService } from '../ai/ai-runner.service';
import {
  improvementCandidatesSchema,
  improvementCandidatesValidator,
} from '../ai/ai.schemas';
import { DatabaseService } from '../database/database.service';
import { improvementBatchIdempotency, improvements } from '../database/schema';
import { MemoryService } from '../memory/memory.service';
import {
  assertEnum,
  id,
  now,
  optionalString,
  parseJson,
  requireString,
  sha256,
  stringifyJson,
  stringArray,
} from '../shared/utils';

const SOURCES = ['MANUAL', 'EDITOR', 'COMPARISON'] as const;
const SCOPES = ['GLOBAL', 'PROJECT'] as const;

export interface ImprovementCandidate {
  title: string;
  rule: string;
  rationale: string;
  category: string;
  tags: string[];
  beforeExample?: string;
  afterExample?: string;
  confidence: number;
  duplicateOfId?: string | null;
  conflictsWithIds: string[];
  source: 'EDITOR' | 'COMPARISON';
}

@Injectable()
export class ImprovementsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly ai: AiRunnerService,
    private readonly memory: MemoryService,
  ) {}

  list(projectId?: string) {
    const rows = this.database.orm
      .select()
      .from(improvements)
      .where(
        projectId
          ? and(eq(improvements.active, true), or(isNull(improvements.projectId), eq(improvements.projectId, projectId)))
          : and(eq(improvements.active, true), isNull(improvements.projectId)),
      )
      .all();
    return rows.map((row) => this.toView(row));
  }

  async create(body: unknown) {
    const input = (body ?? {}) as Record<string, unknown>;
    const scope = assertEnum(input.scope, 'scope', SCOPES);
    const projectId = typeof input.projectId === 'string' ? input.projectId : null;
    if ((scope === 'PROJECT') !== Boolean(projectId)) {
      throw new BadRequestException('PROJECT scope requires projectId and GLOBAL scope forbids it');
    }
    return this.insert({ ...input, scope, projectId, source: input.source ?? 'MANUAL' });
  }

  async candidates(body: unknown): Promise<{ candidates: ImprovementCandidate[] }> {
    const input = (body ?? {}) as Record<string, unknown>;
    const source = assertEnum(input.source, 'source', ['EDITOR', 'COMPARISON'] as const);
    const projectId = typeof input.projectId === 'string' ? input.projectId : undefined;
    if (source === 'EDITOR' && !projectId) throw new BadRequestException('EDITOR source requires projectId');
    const original = requireString(input.original, 'original', { max: 200_000 });
    const revised = requireString(input.revised, 'revised', { max: 200_000 });
    if (original === revised) throw new BadRequestException('original and revised text must differ');
    const existing = this.list(projectId);
    const { value } = await this.ai.completeJson<{ candidates: Array<Omit<ImprovementCandidate, 'source'>> }>({
      task: 'improvement_extract',
      promptId: 'improvement-extract',
      projectId,
      modelRole: 'IMPROVEMENT',
      includeCore: false,
      includeMemoryContract: false,
      variables: {
        original_text: original,
        preferred_text: revised,
        comparison_mode: source,
        default_scope: projectId ? 'PROJECT' : 'GLOBAL',
        existing_improvements: stringifyJson(existing),
      },
      schema: { name: 'improvement_candidates', value: improvementCandidatesSchema },
      validator: improvementCandidatesValidator,
      maxTokens: 6_000,
    });
    return {
      candidates: (value.candidates ?? []).map((candidate) => ({
        ...candidate,
        tags: candidate.tags ?? [],
        conflictsWithIds: candidate.conflictsWithIds ?? [],
        confidence: candidate.confidence ?? 0.5,
        source,
      })),
    };
  }

  async batch(body: unknown, idempotencyKey?: string) {
    const input = (body ?? {}) as Record<string, unknown>;
    const projectId = typeof input.projectId === 'string' ? input.projectId : null;
    if (!Array.isArray(input.candidates) || input.candidates.length === 0) {
      throw new BadRequestException('candidates must be a non-empty array');
    }
    if (input.candidates.length > 100) {
      throw new BadRequestException('A batch can contain at most 100 candidates');
    }
    const key = idempotencyKey?.trim();
    if (idempotencyKey !== undefined && (!key || key.length > 200)) {
      throw new BadRequestException('Idempotency-Key must contain between 1 and 200 characters');
    }
    const requestHash = sha256(stringifyJson({ projectId, candidates: input.candidates }));
    if (key) {
      const replay = this.database.orm
        .select()
        .from(improvementBatchIdempotency)
        .where(eq(improvementBatchIdempotency.idempotencyKey, key))
        .get();
      if (replay) {
        if (replay.requestHash !== requestHash) {
          throw new ConflictException(
            'Idempotency-Key was already used with a different improvement batch',
          );
        }
        return parseJson<{ improvements: ReturnType<ImprovementsService['toView']>[] }>(
          replay.responseJson,
          { improvements: [] },
        );
      }
    }

    const stamp = now();
    const rows = input.candidates.map((raw) => {
      if (!raw || typeof raw !== 'object') throw new BadRequestException('Invalid candidate');
      const candidate = raw as Record<string, unknown>;
      return this.prepareRow(
        {
          ...candidate,
          scope: projectId ? 'PROJECT' : 'GLOBAL',
          projectId,
          source: candidate.source ?? (projectId ? 'EDITOR' : 'COMPARISON'),
        },
        stamp,
      );
    });
    const response = {
      improvements: rows.map((row) => this.toView(row as typeof improvements.$inferSelect)),
    };
    this.database.connection.transaction(() => {
      for (const row of rows) this.database.orm.insert(improvements).values(row).run();
      if (key) {
        this.database.orm.insert(improvementBatchIdempotency).values({
          idempotencyKey: key,
          requestHash,
          responseJson: stringifyJson(response),
          createdAt: stamp,
        }).run();
      }
    })();
    await Promise.all(rows.map((row) => this.index(row as typeof improvements.$inferSelect)));
    return response;
  }

  async update(improvementId: string, body: unknown) {
    const current = this.require(improvementId);
    const input = (body ?? {}) as Record<string, unknown>;
    if (!Number.isInteger(input.expectedRevision)) {
      throw new BadRequestException('expectedRevision is required');
    }
    if (input.expectedRevision !== current.revision) {
      throw new ConflictException('Improvement revision is stale');
    }
    const changes: Partial<typeof improvements.$inferInsert> = {
      updatedAt: now(),
      revision: current.revision + 1,
    };
    if ('title' in input) changes.title = requireString(input.title, 'title', { max: 200 });
    if ('rule' in input) changes.rule = requireString(input.rule, 'rule', { max: 5_000 });
    if ('rationale' in input) changes.rationale = optionalString(input.rationale, 'rationale', 5_000) ?? '';
    if ('category' in input) changes.category = requireString(input.category, 'category', { max: 100 });
    if ('tags' in input) changes.tagsJson = stringifyJson(stringArray(input.tags, 'tags'));
    if ('beforeExample' in input) changes.beforeExample = optionalString(input.beforeExample, 'beforeExample', 20_000) ?? null;
    if ('afterExample' in input) changes.afterExample = optionalString(input.afterExample, 'afterExample', 20_000) ?? null;
    if ('active' in input) changes.active = input.active !== false;
    if ('scope' in input || 'projectId' in input) {
      const scope = 'scope' in input
        ? assertEnum(input.scope, 'scope', SCOPES)
        : (current.scope as (typeof SCOPES)[number]);
      const projectId = 'projectId' in input
        ? typeof input.projectId === 'string' && input.projectId.length > 0
          ? input.projectId
          : null
        : current.projectId;
      if ((scope === 'PROJECT') !== Boolean(projectId)) {
        throw new BadRequestException('PROJECT scope requires projectId and GLOBAL scope forbids it');
      }
      changes.scope = scope;
      changes.projectId = projectId;
    }
    const result = this.database.orm
      .update(improvements)
      .set(changes)
      .where(
        and(
          eq(improvements.id, improvementId),
          eq(improvements.revision, current.revision),
        ),
      )
      .run();
    if (result.changes !== 1) {
      throw new ConflictException('Improvement revision changed during update');
    }
    const updated = this.require(improvementId);
    if (updated.active) await this.index(updated);
    else this.memory.removeSource('IMPROVEMENT', improvementId);
    return this.toView(updated);
  }

  remove(improvementId: string): void {
    this.require(improvementId);
    this.memory.removeSource('IMPROVEMENT', improvementId);
    this.database.orm.delete(improvements).where(eq(improvements.id, improvementId)).run();
  }

  private async insert(input: Record<string, unknown>) {
    const row = this.prepareRow(input, now());
    this.database.orm.insert(improvements).values(row).run();
    await this.index(row as typeof improvements.$inferSelect);
    return this.toView(row as typeof improvements.$inferSelect);
  }

  private prepareRow(input: Record<string, unknown>, stamp: string): typeof improvements.$inferInsert {
    const scope = assertEnum(input.scope, 'scope', SCOPES);
    const projectId = typeof input.projectId === 'string' ? input.projectId : null;
    if ((scope === 'PROJECT') !== Boolean(projectId)) {
      throw new BadRequestException('PROJECT scope requires projectId and GLOBAL scope forbids it');
    }
    const confidence = Number(input.confidence ?? 0.5);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new BadRequestException('confidence must be between 0 and 1');
    if (
      input.duplicateOfId !== undefined &&
      input.duplicateOfId !== null &&
      typeof input.duplicateOfId !== 'string'
    ) {
      throw new BadRequestException('duplicateOfId must be a string or null');
    }
    const row: typeof improvements.$inferInsert = {
      id: id(),
      scope,
      projectId,
      title: requireString(input.title, 'title', { max: 200 }),
      rule: requireString(input.rule, 'rule', { max: 5_000 }),
      rationale: optionalString(input.rationale, 'rationale', 5_000) ?? '',
      category: optionalString(input.category, 'category', 100) || 'STYLE',
      tagsJson: stringifyJson(input.tags === undefined ? [] : stringArray(input.tags, 'tags')),
      beforeExample: optionalString(input.beforeExample, 'beforeExample', 20_000) ?? null,
      afterExample: optionalString(input.afterExample, 'afterExample', 20_000) ?? null,
      source: assertEnum(input.source, 'source', SOURCES),
      confidence,
      duplicateOfId: typeof input.duplicateOfId === 'string' ? input.duplicateOfId : null,
      conflictsWithIdsJson: stringifyJson(
        input.conflictsWithIds === undefined ? [] : stringArray(input.conflictsWithIds, 'conflictsWithIds'),
      ),
      active: true,
      revision: 1,
      createdAt: stamp,
      updatedAt: stamp,
    };
    return row;
  }

  private require(improvementId: string) {
    const row = this.database.orm.select().from(improvements).where(eq(improvements.id, improvementId)).get();
    if (!row) throw new NotFoundException('Improvement not found');
    return row;
  }

  private async index(row: typeof improvements.$inferSelect): Promise<void> {
    await this.memory.indexSource({
      projectId: row.projectId,
      sourceType: 'IMPROVEMENT',
      sourceId: row.id,
      text: `${row.title}\n규칙: ${row.rule}\n이유: ${row.rationale}`,
    });
  }

  private toView(row: typeof improvements.$inferSelect) {
    return {
      id: row.id,
      scope: row.scope,
      projectId: row.projectId,
      title: row.title,
      rule: row.rule,
      rationale: row.rationale,
      category: row.category,
      tags: parseJson<string[]>(row.tagsJson, []),
      beforeExample: row.beforeExample ?? undefined,
      afterExample: row.afterExample ?? undefined,
      source: row.source,
      confidence: row.confidence,
      duplicateOfId: row.duplicateOfId,
      conflictsWithIds: parseJson<string[]>(row.conflictsWithIdsJson, []),
      active: row.active,
      revision: row.revision,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
