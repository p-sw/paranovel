import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service';
import {
  arcs,
  canonEntries,
  episodeIdempotency,
  episodeSummaries,
  episodes,
  projects,
  sideStoryGroupIdempotency,
  sideStoryGroups,
} from '../database/schema';
import { MemoryService } from '../memory/memory.service';
import {
  id,
  now,
  optionalString,
  parseJson,
  positiveInteger,
  requireString,
  sha256,
  stableStringifyJson,
  stringifyJson,
} from '../shared/utils';

type EpisodeRow = typeof episodes.$inferSelect;
type GroupRow = typeof sideStoryGroups.$inferSelect;

export interface ReversalBeat {
  id?: string;
  episode: number;
  description: string;
}

const MILESTONE_TYPES = [
  'GOAL',
  'REVERSAL',
  'ESCALATION',
  'CLIMAX',
  'RESOLUTION',
  'OTHER',
] as const;

export interface ArcMilestone extends ReversalBeat {
  type: (typeof MILESTONE_TYPES)[number];
}

export interface ArcEpisodeDirection {
  episode: number;
  title: string;
  direction: string;
}

@Injectable()
export class SideStoriesService {
  constructor(
    private readonly database: DatabaseService,
    private readonly memory: MemoryService,
  ) {}

  list(projectId: string) {
    this.requireProject(projectId);
    const standalone = this.database.orm
      .select()
      .from(episodes)
      .where(
        and(
          eq(episodes.projectId, projectId),
          eq(episodes.kind, 'SIDE_STORY'),
          isNull(episodes.sideStoryGroupId),
          isNull(episodes.deletedAt),
        ),
      )
      .orderBy(episodes.createdAt, episodes.id)
      .all()
      .map((row) => this.episodeView(row));
    const groups = this.groupRows(projectId).map((row) => this.groupView(row, true));
    return { standalone, groups };
  }

  async create(
    projectId: string,
    body: unknown,
    idempotencyKey?: string,
  ) {
    const input = (body ?? {}) as Record<string, unknown>;
    this.assertOnlyKeys(input, [
      'title',
      'direction',
      'content',
      'incomplete',
      'forceNeedsReview',
      'groupId',
      'branchFromEpisodeId',
    ]);
    const groupId = this.requiredNullableId(input, 'groupId');
    const branchFromEpisodeId = this.requiredNullableId(input, 'branchFromEpisodeId');
    if (groupId && branchFromEpisodeId) {
      throw new BadRequestException('Grouped side stories inherit the group branch');
    }
    if (idempotencyKey && idempotencyKey.length > 200) {
      throw new BadRequestException('Idempotency-Key is too long');
    }
    const title = requireString(input.title, 'title', { max: 200 });
    const direction = optionalString(input.direction, 'direction', 20_000) ?? '';
    const content = optionalString(input.content, 'content', 1_000_000) ?? '';
    const incomplete = this.optionalBoolean(input.incomplete, 'incomplete') ?? false;
    const forceNeedsReview = this.optionalBoolean(input.forceNeedsReview, 'forceNeedsReview') ?? false;
    if (incomplete && content.trim()) {
      throw new BadRequestException('An incomplete episode cannot contain content');
    }
    const requestHash = sha256(stableStringifyJson({
      title,
      direction,
      content,
      incomplete,
      forceNeedsReview,
      groupId,
      branchFromEpisodeId,
    }));

    return this.database.connection.transaction(() => {
      this.requireProject(projectId);
      if (idempotencyKey) {
        const replay = this.database.orm
          .select()
          .from(episodeIdempotency)
          .where(
            and(
              eq(episodeIdempotency.projectId, projectId),
              eq(episodeIdempotency.scope, 'SIDE_STORY'),
              eq(episodeIdempotency.idempotencyKey, idempotencyKey),
            ),
          )
          .get();
        if (replay) {
          if (replay.requestHash !== requestHash) {
            throw new ConflictException(
              'Idempotency-Key was already used with a different request',
            );
          }
          const existing = this.requireSideStory(projectId, replay.episodeId);
          return this.episodeView(existing);
        }
      }

      const group = groupId ? this.requireGroupRow(projectId, groupId) : undefined;
      if (!group) this.validateBranch(projectId, branchFromEpisodeId);
      const stamp = now();
      const episodeId = id();
      const row: typeof episodes.$inferInsert = {
        id: episodeId,
        projectId,
        kind: 'SIDE_STORY',
        number: group?.nextEpisodeNumber ?? null,
        sideStoryGroupId: group?.id ?? null,
        branchFromEpisodeId: group ? null : branchFromEpisodeId,
        title,
        direction,
        content,
        revision: 1,
        status: forceNeedsReview
          ? 'NEEDS_REVIEW'
          : incomplete ? 'INCOMPLETE' : 'DRAFT',
        createdAt: stamp,
        updatedAt: stamp,
        deletedAt: null,
      };
      this.database.orm.insert(episodes).values(row).run();
      if (group) {
        this.database.orm
          .update(sideStoryGroups)
          .set({
            nextEpisodeNumber: group.nextEpisodeNumber + 1,
            updatedAt: stamp,
          })
          .where(eq(sideStoryGroups.id, group.id))
          .run();
      }
      if (idempotencyKey) {
        this.database.orm.insert(episodeIdempotency).values({
          projectId,
          scope: 'SIDE_STORY',
          idempotencyKey,
          episodeId,
          requestHash,
          createdAt: stamp,
        }).run();
      }
      return this.episodeView(row as EpisodeRow);
    }).immediate();
  }

  listGroups(projectId: string) {
    this.requireProject(projectId);
    return this.groupRows(projectId).map((row) => this.groupView(row, false));
  }

  getGroup(projectId: string, groupId: string) {
    this.requireProject(projectId);
    return this.groupView(this.requireGroupRow(projectId, groupId), false);
  }

  createGroup(projectId: string, body: unknown, idempotencyKey?: string) {
    const input = (body ?? {}) as Record<string, unknown>;
    this.assertOnlyKeys(input, [
      'title',
      'description',
      'branchFromEpisodeId',
      'canon',
      'arc',
    ]);
    if (idempotencyKey && idempotencyKey.length > 200) {
      throw new BadRequestException('Idempotency-Key is too long');
    }
    const title = requireString(input.title, 'title', { max: 200 });
    const description = optionalString(input.description, 'description', 20_000) ?? '';
    const branchFromEpisodeId = this.requiredNullableId(input, 'branchFromEpisodeId');
    const canon = requireString(input.canon, 'canon', { max: 50_000 });
    const arc = this.arcInput(input.arc);
    const requestHash = sha256(stableStringifyJson({
      title,
      description,
      branchFromEpisodeId,
      canon,
      arc,
    }));

    return this.database.connection.transaction(() => {
      this.requireProject(projectId);
      if (idempotencyKey) {
        const replay = this.database.orm.select().from(sideStoryGroupIdempotency).where(and(
          eq(sideStoryGroupIdempotency.projectId, projectId),
          eq(sideStoryGroupIdempotency.idempotencyKey, idempotencyKey),
        )).get();
        if (replay) {
          if (replay.requestHash !== requestHash) {
            throw new ConflictException(
              'Idempotency-Key was already used with a different request',
            );
          }
          return this.groupView(this.requireGroupRow(projectId, replay.groupId), false);
        }
      }
      this.validateBranch(projectId, branchFromEpisodeId);
      const stamp = now();
      const groupId = id();
      const group: typeof sideStoryGroups.$inferInsert = {
        id: groupId,
        projectId,
        title,
        description,
        branchFromEpisodeId,
        nextEpisodeNumber: 1,
        revision: 1,
        createdAt: stamp,
        updatedAt: stamp,
      };
      this.database.orm.insert(sideStoryGroups).values(group).run();
      this.database.orm.insert(canonEntries).values({
        id: id(),
        projectId,
        sideStoryGroupId: groupId,
        category: 'OTHER',
        name: `${title} 정사`,
        aliasesJson: '[]',
        content: canon,
        metadataJson: stringifyJson({ scope: 'SIDE_STORY_GROUP' }),
        status: 'ACTIVE',
        revision: 1,
        sourceEpisodeId: null,
        createdAt: stamp,
        updatedAt: stamp,
      }).run();
      this.database.orm.insert(arcs).values({
        id: id(),
        projectId,
        sideStoryGroupId: groupId,
        title: arc.title,
        startEpisodeNumber: 1,
        endEpisodeNumber: arc.endEpisodeNumber,
        goal: arc.goal,
        conflict: arc.conflict,
        twistPlan: '',
        reversalPlanJson: stringifyJson(arc.reversalPlan),
        milestonePlanJson: stringifyJson(arc.milestones),
        episodeDirectionsJson: stringifyJson(arc.episodeDirections),
        status: 'ACTIVE',
        revision: 1,
        createdAt: stamp,
        updatedAt: stamp,
      }).run();
      if (idempotencyKey) {
        this.database.orm.insert(sideStoryGroupIdempotency).values({
          projectId,
          idempotencyKey,
          groupId,
          requestHash,
          createdAt: stamp,
        }).run();
      }
      return this.groupView(group as GroupRow, false);
    }).immediate();
  }

  updateGroup(projectId: string, groupId: string, body: unknown) {
    const input = (body ?? {}) as Record<string, unknown>;
    this.assertOnlyKeys(input, ['expectedRevision', 'title', 'description']);
    const expectedRevision = positiveInteger(input.expectedRevision, 'expectedRevision');
    if (expectedRevision < 1) {
      throw new BadRequestException('expectedRevision must be a positive integer');
    }
    const hasTitle = Object.prototype.hasOwnProperty.call(input, 'title');
    const hasDescription = Object.prototype.hasOwnProperty.call(input, 'description');
    if (!hasTitle && !hasDescription) {
      throw new BadRequestException('At least one editable field is required');
    }
    return this.database.connection.transaction(() => {
      const current = this.requireGroupRow(projectId, groupId);
      if (current.revision !== expectedRevision) {
        throw new ConflictException('Side story group revision is stale');
      }
      const stamp = now();
      const changes: Partial<typeof sideStoryGroups.$inferInsert> = {
        revision: current.revision + 1,
        updatedAt: stamp,
      };
      const title = hasTitle ? requireString(input.title, 'title', { max: 200 }) : undefined;
      if (title !== undefined) changes.title = title;
      if (hasDescription) {
        changes.description = optionalString(input.description, 'description', 20_000) ?? '';
      }
      const result = this.database.orm
        .update(sideStoryGroups)
        .set(changes)
        .where(
          and(
            eq(sideStoryGroups.id, groupId),
            eq(sideStoryGroups.projectId, projectId),
            eq(sideStoryGroups.revision, expectedRevision),
          ),
        )
        .run();
      if (result.changes !== 1) {
        throw new ConflictException('Side story group revision changed during update');
      }
      if (title !== undefined) {
        const baseCanon = this.database.orm.select().from(canonEntries).where(and(
          eq(canonEntries.projectId, projectId),
          eq(canonEntries.sideStoryGroupId, groupId),
        )).all().find((entry) => (
          parseJson<Record<string, unknown>>(entry.metadataJson, {}).scope === 'SIDE_STORY_GROUP'
          && entry.name === `${current.title} 정사`
        ));
        if (baseCanon) {
          this.database.orm.update(canonEntries).set({
            name: `${title} 정사`,
            revision: baseCanon.revision + 1,
            updatedAt: stamp,
          }).where(eq(canonEntries.id, baseCanon.id)).run();
          // Group canon is always supplied as mandatory context. Drop any
          // optional retrieval copy carrying the former derived label.
          this.memory.removeSource('CANON', baseCanon.id);
        }
      }
      return this.groupView(this.requireGroupRow(projectId, groupId), false);
    }).immediate();
  }

  private requireProject(projectId: string): void {
    const project = this.database.orm
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, projectId), isNull(projects.deletedAt)))
      .get();
    if (!project) throw new NotFoundException('Project not found');
  }

  private validateBranch(projectId: string, episodeId: string | null): void {
    if (!episodeId) return;
    const branch = this.database.orm
      .select({ id: episodes.id })
      .from(episodes)
      .where(
        and(
          eq(episodes.id, episodeId),
          eq(episodes.projectId, projectId),
          eq(episodes.kind, 'MAIN'),
          isNull(episodes.deletedAt),
        ),
      )
      .get();
    if (!branch) {
      throw new BadRequestException(
        'branchFromEpisodeId must be a live main episode in this project',
      );
    }
  }

  private requireSideStory(projectId: string, episodeId: string): EpisodeRow {
    const row = this.database.orm
      .select()
      .from(episodes)
      .where(
        and(
          eq(episodes.id, episodeId),
          eq(episodes.projectId, projectId),
          eq(episodes.kind, 'SIDE_STORY'),
          isNull(episodes.deletedAt),
        ),
      )
      .get();
    if (!row) throw new NotFoundException('Side story not found');
    return row;
  }

  private groupRows(projectId: string): GroupRow[] {
    return this.database.orm
      .select()
      .from(sideStoryGroups)
      .where(eq(sideStoryGroups.projectId, projectId))
      .orderBy(sideStoryGroups.createdAt, sideStoryGroups.id)
      .all();
  }

  private requireGroupRow(projectId: string, groupId: string): GroupRow {
    const row = this.database.orm
      .select()
      .from(sideStoryGroups)
      .where(
        and(
          eq(sideStoryGroups.id, groupId),
          eq(sideStoryGroups.projectId, projectId),
        ),
      )
      .get();
    if (!row) throw new NotFoundException('Side story group not found');
    return row;
  }

  private groupView(row: GroupRow, includeEpisodes: boolean) {
    const canon = this.database.orm
      .select()
      .from(canonEntries)
      .where(
        and(
          eq(canonEntries.projectId, row.projectId),
          eq(canonEntries.sideStoryGroupId, row.id),
        ),
      )
      .orderBy(canonEntries.createdAt, canonEntries.id)
      .all()
      .map((entry) => ({
        id: entry.id,
        projectId: entry.projectId,
        sideStoryGroupId: entry.sideStoryGroupId,
        category: entry.category,
        name: entry.name,
        aliases: parseJson<string[]>(entry.aliasesJson, []),
        content: entry.content,
        metadata: parseJson<Record<string, unknown>>(entry.metadataJson, {}),
        status: entry.status,
        revision: entry.revision,
        sourceEpisodeId: entry.sourceEpisodeId,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
      }));
    const arcRows = this.database.orm
      .select()
      .from(arcs)
      .where(
        and(
          eq(arcs.projectId, row.projectId),
          eq(arcs.sideStoryGroupId, row.id),
        ),
      )
      .orderBy(arcs.startEpisodeNumber, arcs.createdAt)
      .all();
    const selectedArc = arcRows.find((arc) => arc.status === 'ACTIVE') ?? arcRows[0];
    if (!selectedArc) throw new NotFoundException('Side story group arc not found');
    const milestones = this.storedMilestones(selectedArc);
    const episodeDirections = this.storedEpisodeDirections(selectedArc, milestones);
    const arc = {
      id: selectedArc.id,
      projectId: selectedArc.projectId,
      sideStoryGroupId: selectedArc.sideStoryGroupId,
      title: selectedArc.title,
      startEpisodeNumber: selectedArc.startEpisodeNumber,
      endEpisodeNumber: selectedArc.endEpisodeNumber,
      startEpisode: selectedArc.startEpisodeNumber,
      endEpisode: selectedArc.endEpisodeNumber,
      goal: selectedArc.goal,
      conflict: selectedArc.conflict,
      milestones,
      episodeDirections,
      status: selectedArc.status,
      revision: selectedArc.revision,
      createdAt: selectedArc.createdAt,
      updatedAt: selectedArc.updatedAt,
    };
    const view = {
      id: row.id,
      projectId: row.projectId,
      title: row.title,
      description: row.description,
      branchFromEpisodeId: row.branchFromEpisodeId,
      nextEpisodeNumber: row.nextEpisodeNumber,
      revision: row.revision,
      canon,
      arc,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
    if (!includeEpisodes) return view;
    const groupedEpisodes = this.database.orm
      .select()
      .from(episodes)
      .where(
        and(
          eq(episodes.projectId, row.projectId),
          eq(episodes.kind, 'SIDE_STORY'),
          eq(episodes.sideStoryGroupId, row.id),
          isNull(episodes.deletedAt),
        ),
      )
      .orderBy(episodes.number)
      .all()
      .map((episode) => this.episodeView(episode));
    return { ...view, episodes: groupedEpisodes };
  }

  private episodeView(row: EpisodeRow) {
    const summary = this.database.orm
      .select()
      .from(episodeSummaries)
      .where(eq(episodeSummaries.episodeId, row.id))
      .get();
    return {
      id: row.id,
      projectId: row.projectId,
      kind: row.kind,
      number: row.number,
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

  private requiredNullableId(
    input: Record<string, unknown>,
    field: 'groupId' | 'branchFromEpisodeId',
  ): string | null {
    if (!Object.prototype.hasOwnProperty.call(input, field)) {
      throw new BadRequestException(`${field} is required and must be a string or null`);
    }
    const value = input[field];
    if (value === null) return null;
    return requireString(value, field, { max: 200 });
  }

  private optionalBoolean(value: unknown, field: string): boolean | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'boolean') {
      throw new BadRequestException(`${field} must be a boolean`);
    }
    return value;
  }

  private assertOnlyKeys(
    input: Record<string, unknown>,
    allowed: readonly string[],
    field = 'request',
  ): void {
    const unknown = Object.keys(input).filter((key) => !allowed.includes(key));
    if (unknown.length > 0) {
      throw new BadRequestException(`${field} contains unsupported fields: ${unknown.join(', ')}`);
    }
  }

  private arcInput(value: unknown): {
    title: string;
    goal: string;
    conflict: string;
    endEpisodeNumber: number;
    reversalPlan: ReversalBeat[];
    milestones: ArcMilestone[];
    episodeDirections: ArcEpisodeDirection[];
  } {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new BadRequestException('arc must be an object');
    }
    const input = value as Record<string, unknown>;
    this.assertOnlyKeys(
      input,
      [
        'title',
        'goal',
        'conflict',
        'endEpisodeNumber',
        'reversalPlan',
        'milestones',
        'episodeDirections',
      ],
      'arc',
    );
    const endEpisodeNumber = input.endEpisodeNumber === undefined
      ? 5
      : positiveInteger(input.endEpisodeNumber, 'arc.endEpisodeNumber');
    if (endEpisodeNumber < 1 || endEpisodeNumber > 20) {
      throw new BadRequestException('arc.endEpisodeNumber must be between 1 and 20');
    }
    const title = requireString(input.title, 'arc.title', { max: 200 });
    const goal = requireString(input.goal, 'arc.goal', { max: 10_000 });
    const conflict = requireString(input.conflict, 'arc.conflict', { max: 10_000 });
    if (input.reversalPlan !== undefined && !Array.isArray(input.reversalPlan)) {
      throw new BadRequestException('arc.reversalPlan must be an array');
    }
    const reversalPlan = (input.reversalPlan ?? []).map((candidate, index) => {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
        throw new BadRequestException(`arc.reversalPlan[${index}] must be an object`);
      }
      const beat = candidate as Record<string, unknown>;
      this.assertOnlyKeys(
        beat,
        ['id', 'episode', 'description'],
        `arc.reversalPlan[${index}]`,
      );
      const episode = positiveInteger(beat.episode, `arc.reversalPlan[${index}].episode`);
      if (episode < 1 || episode > endEpisodeNumber) {
        throw new BadRequestException(
          `arc.reversalPlan[${index}].episode must be within the group arc`,
        );
      }
      const normalized: ReversalBeat = {
        episode,
        description: requireString(
          beat.description,
          `arc.reversalPlan[${index}].description`,
          { max: 10_000 },
        ),
      };
      if (beat.id !== undefined) {
        normalized.id = requireString(beat.id, `arc.reversalPlan[${index}].id`, { max: 200 });
      }
      return normalized;
    });
    if (input.milestones !== undefined && !Array.isArray(input.milestones)) {
      throw new BadRequestException('arc.milestones must be an array');
    }
    const milestones = input.milestones === undefined
      ? reversalPlan.length > 0
        ? reversalPlan.map((beat) => ({ ...beat, type: 'REVERSAL' as const }))
        : [{ episode: endEpisodeNumber, type: 'GOAL' as const, description: goal }]
      : input.milestones.map((candidate, index) => {
          if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
            throw new BadRequestException(`arc.milestones[${index}] must be an object`);
          }
          const milestone = candidate as Record<string, unknown>;
          this.assertOnlyKeys(
            milestone,
            ['id', 'episode', 'type', 'description'],
            `arc.milestones[${index}]`,
          );
          const episode = positiveInteger(milestone.episode, `arc.milestones[${index}].episode`);
          if (episode < 1 || episode > endEpisodeNumber) {
            throw new BadRequestException(
              `arc.milestones[${index}].episode must be within the group arc`,
            );
          }
          if (typeof milestone.type !== 'string'
            || !MILESTONE_TYPES.includes(milestone.type as ArcMilestone['type'])) {
            throw new BadRequestException(
              `arc.milestones[${index}].type must be a supported milestone type`,
            );
          }
          const normalized: ArcMilestone = {
            episode,
            type: milestone.type as ArcMilestone['type'],
            description: requireString(
              milestone.description,
              `arc.milestones[${index}].description`,
              { max: 10_000 },
            ),
          };
          if (milestone.id !== undefined) {
            normalized.id = requireString(
              milestone.id,
              `arc.milestones[${index}].id`,
              { max: 200 },
            );
          }
          return normalized;
        });
    if (milestones.length === 0) {
      throw new BadRequestException('arc.milestones must contain at least one item');
    }
    milestones.sort((left, right) => left.episode - right.episode);
    const episodeDirections = input.episodeDirections === undefined
      ? this.synthesizedEpisodeDirections(1, endEpisodeNumber, title, goal, milestones)
      : this.parseEpisodeDirections(input.episodeDirections, 1, endEpisodeNumber);
    return {
      title,
      goal,
      conflict,
      endEpisodeNumber,
      reversalPlan,
      milestones,
      episodeDirections,
    };
  }

  private parseEpisodeDirections(
    value: unknown,
    start: number,
    end: number,
  ): ArcEpisodeDirection[] {
    if (!Array.isArray(value) || value.length !== end - start + 1) {
      throw new BadRequestException(
        'arc.episodeDirections must cover every episode in the group arc exactly once',
      );
    }
    return value.map((candidate, index) => {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
        throw new BadRequestException(`arc.episodeDirections[${index}] must be an object`);
      }
      const direction = candidate as Record<string, unknown>;
      this.assertOnlyKeys(
        direction,
        ['episode', 'title', 'direction'],
        `arc.episodeDirections[${index}]`,
      );
      const episode = positiveInteger(
        direction.episode,
        `arc.episodeDirections[${index}].episode`,
      );
      if (episode !== start + index) {
        throw new BadRequestException(
          `arc.episodeDirections[${index}].episode must be ${start + index}`,
        );
      }
      return {
        episode,
        title: requireString(
          direction.title,
          `arc.episodeDirections[${index}].title`,
          { max: 200 },
        ),
        direction: requireString(
          direction.direction,
          `arc.episodeDirections[${index}].direction`,
          { max: 20_000 },
        ),
      };
    });
  }

  private storedMilestones(row: typeof arcs.$inferSelect): ArcMilestone[] {
    const values = parseJson<unknown>(row.milestonePlanJson, []);
    const milestones = Array.isArray(values) ? values.flatMap((candidate): ArcMilestone[] => {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return [];
      const value = candidate as Record<string, unknown>;
      if (!Number.isInteger(value.episode)
        || Number(value.episode) < row.startEpisodeNumber
        || Number(value.episode) > row.endEpisodeNumber
        || typeof value.type !== 'string'
        || !MILESTONE_TYPES.includes(value.type as ArcMilestone['type'])
        || typeof value.description !== 'string'
        || !value.description.trim()) return [];
      return [{
        ...(typeof value.id === 'string' && value.id.trim() ? { id: value.id } : {}),
        episode: Number(value.episode),
        type: value.type as ArcMilestone['type'],
        description: value.description,
      }];
    }) : [];
    if (milestones.length > 0) return milestones.sort((left, right) => left.episode - right.episode);
    const reversals = parseJson<unknown>(row.reversalPlanJson, []);
    const legacy = Array.isArray(reversals) ? reversals.flatMap((candidate): ArcMilestone[] => {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return [];
      const value = candidate as Record<string, unknown>;
      if (!Number.isInteger(value.episode)
        || Number(value.episode) < row.startEpisodeNumber
        || Number(value.episode) > row.endEpisodeNumber
        || typeof value.description !== 'string'
        || !value.description.trim()) return [];
      return [{
        ...(typeof value.id === 'string' && value.id.trim() ? { id: value.id } : {}),
        episode: Number(value.episode),
        type: 'REVERSAL',
        description: value.description,
      }];
    }) : [];
    return legacy.length > 0
      ? legacy.sort((left, right) => left.episode - right.episode)
      : [{ episode: row.endEpisodeNumber, type: 'GOAL', description: row.goal }];
  }

  private storedEpisodeDirections(
    row: typeof arcs.$inferSelect,
    milestones: ArcMilestone[],
  ): ArcEpisodeDirection[] {
    const values = parseJson<unknown>(row.episodeDirectionsJson, []);
    if (Array.isArray(values) && values.length === row.endEpisodeNumber - row.startEpisodeNumber + 1) {
      const parsed = values.flatMap((candidate, index): ArcEpisodeDirection[] => {
        if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return [];
        const value = candidate as Record<string, unknown>;
        if (value.episode !== row.startEpisodeNumber + index
          || typeof value.title !== 'string' || !value.title.trim()
          || typeof value.direction !== 'string' || !value.direction.trim()) return [];
        return [{
          episode: row.startEpisodeNumber + index,
          title: value.title,
          direction: value.direction,
        }];
      });
      if (parsed.length === values.length) return parsed;
    }
    return this.synthesizedEpisodeDirections(
      row.startEpisodeNumber,
      row.endEpisodeNumber,
      row.title,
      row.goal,
      milestones,
    );
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
      return {
        episode,
        title: `${title} ${episode}화`,
        direction: milestones.find((milestone) => milestone.episode === episode)?.description ?? goal,
      };
    });
  }
}
