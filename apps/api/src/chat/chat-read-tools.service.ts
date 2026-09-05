import { Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import type { ToolDefinition } from '../ai/ai.types';
import { TavilySearchService, tavilySearchTool } from '../ai/tavily-search.service';
import { ArcsService } from '../arcs/arcs.service';
import { CanonService } from '../canon/canon.service';
import { DatabaseService } from '../database/database.service';
import { episodes, episodeSummaries } from '../database/schema';
import { ImprovementsService } from '../improvements/improvements.service';
import { MemoryService } from '../memory/memory.service';
import { ProjectsService } from '../projects/projects.service';
import type { ChatKind } from './chat.schemas';

const kind = z.enum(['PROJECT', 'CANON', 'ARC', 'IMPROVEMENT', 'EPISODE']);
const listArgs = z.strictObject({ kind, offset: z.number().int().min(0), limit: z.number().int().min(1).max(50) });
const readArgs = z.strictObject({ kind, id: z.string().min(1).nullable(), episodeNumber: z.number().int().positive().nullable(), offset: z.number().int().min(0) });
const searchArgs = z.strictObject({ query: z.string().trim().min(1).max(2_000), limit: z.number().int().min(1).max(12) });
function tool(name: string, description: string, validator: z.ZodType): ToolDefinition {
  const { $schema: _, ...parameters } = z.toJSONSchema(validator);
  return { type: 'function', function: { name, description, parameters, strict: true } };
}
const readTools = [
  tool('list_project_records', 'List records in the current project by kind. Returns IDs, titles, status, revision and episode numbers, never all episode bodies. GLOBAL improvements are read-only.', listArgs),
  tool('read_project_record', 'Read one actual record. For an EPISODE, provide either its ID or episodeNumber and use offset/nextOffset to read long text. Other kinds use ID; PROJECT uses the current project. Draft/stale episodes are not confirmed facts.', readArgs),
  tool('search_project_memory', 'Search current-project memories and approved global improvements. Read the actual episode when a precise episode or fact matters.', searchArgs),
];

export type RecordSnapshot = Record<string, unknown> & { id: string; revision: number };
export type SnapshotMap = Map<string, RecordSnapshot>;

@Injectable()
export class ChatReadToolsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly projects: ProjectsService,
    private readonly canon: CanonService,
    private readonly arcs: ArcsService,
    private readonly improvements: ImprovementsService,
    private readonly memory: MemoryService,
    private readonly tavily: TavilySearchService,
  ) {}

  definitions(): ToolDefinition[] {
    return this.tavily.isConfigured() ? [...readTools, tavilySearchTool] : [...readTools];
  }

  getRecord(projectId: string, entityKind: ChatKind, recordId: string): RecordSnapshot {
    this.projects.get(projectId);
    if (entityKind === 'PROJECT') {
      if (recordId !== projectId) throw new NotFoundException('Project record not found');
      return this.projects.get(projectId) as unknown as RecordSnapshot;
    }
    if (entityKind === 'CANON') return this.canon.get(projectId, recordId) as RecordSnapshot;
    if (entityKind === 'ARC') return this.arcs.get(projectId, recordId) as RecordSnapshot;
    const record = this.improvements.get(recordId);
    if (record.projectId !== null && record.projectId !== projectId) throw new NotFoundException('Improvement not found');
    return record as RecordSnapshot;
  }

  snapshot(projectId: string): { snapshots: SnapshotMap; catalog: Record<string, unknown>[] } {
    const snapshots: SnapshotMap = new Map();
    const catalog: Record<string, unknown>[] = [];
    const groups = [
      ['PROJECT', [this.projects.get(projectId)]],
      ['CANON', this.canon.list(projectId)],
      ['ARC', this.arcs.list(projectId)],
      ['IMPROVEMENT', this.improvements.list(projectId)],
    ] as const;
    for (const [entityKind, records] of groups) {
      for (const value of records) {
        const record = value as unknown as RecordSnapshot;
        snapshots.set(`${entityKind}:${record.id}`, record);
        catalog.push({ kind: entityKind, id: record.id, name: record.name ?? record.title, revision: record.revision,
          status: record.status, active: record.active, scope: record.scope, projectId: record.projectId });
      }
    }
    return { snapshots, catalog };
  }

  async call(projectId: string, name: string, argumentsJson: string, snapshots: SnapshotMap, signal?: AbortSignal): Promise<unknown> {
    this.projects.get(projectId);
    signal?.throwIfAborted();
    try {
      const raw: unknown = JSON.parse(argumentsJson);
      if (name === 'list_project_records') {
        const args = listArgs.parse(raw);
        if (args.kind === 'PROJECT') return { records: [this.projects.get(projectId)], nextOffset: null };
        const specifications = {
          EPISODE: { table: 'episodes', fields: 'id, number, title, status, revision', scope: 'project_id = ? AND deleted_at IS NULL', order: 'number' },
          CANON: { table: 'canon_entries', fields: 'id, name, category, status, revision', scope: 'project_id = ?', order: 'created_at, id' },
          ARC: { table: 'arcs', fields: 'id, title, status, revision, start_episode_number AS startEpisodeNumber, end_episode_number AS endEpisodeNumber', scope: 'project_id = ?', order: 'start_episode_number, id' },
          IMPROVEMENT: { table: 'improvements', fields: 'id, title, active, revision, scope, project_id AS projectId', scope: '(project_id = ? OR project_id IS NULL)', order: 'created_at, id' },
        } as const;
        const spec = specifications[args.kind];
        const rows = this.database.connection.prepare(`SELECT ${spec.fields} FROM ${spec.table} WHERE ${spec.scope} ORDER BY ${spec.order} LIMIT ? OFFSET ?`)
          .all(projectId, args.limit + 1, args.offset);
        return { records: rows.slice(0, args.limit), nextOffset: rows.length > args.limit ? args.offset + args.limit : null };
      }
      if (name === 'read_project_record') {
        const args = readArgs.parse(raw);
        if (args.kind === 'EPISODE') {
          if (!args.id && !args.episodeNumber) return { error: 'ID_OR_EPISODE_NUMBER_REQUIRED' };
          const episode = this.database.orm.select().from(episodes).where(and(
            eq(episodes.projectId, projectId), isNull(episodes.deletedAt),
            args.id ? eq(episodes.id, args.id) : eq(episodes.number, args.episodeNumber!),
          )).get();
          if (!episode) return { error: 'NOT_FOUND' };
          const summary = this.database.orm.select().from(episodeSummaries).where(eq(episodeSummaries.episodeId, episode.id)).get();
          const end = Math.min(episode.content.length, args.offset + 12_000);
          return { id: episode.id, number: episode.number, title: episode.title, direction: episode.direction,
            status: episode.status, revision: episode.revision, summary: summary?.sourceRevision === episode.revision ? summary : null,
            content: episode.content.slice(args.offset, end), offset: args.offset, nextOffset: end < episode.content.length ? end : null,
            totalCharacters: episode.content.length };
        }
        const record = this.getRecord(projectId, args.kind, args.id ?? (args.kind === 'PROJECT' ? projectId : ''));
        snapshots.set(`${args.kind}:${record.id}`, record);
        const serialized = JSON.stringify(record);
        if (serialized.length <= 12_000) return { record };
        const end = Math.min(serialized.length, args.offset + 12_000);
        return { id: record.id, revision: record.revision, serializedExcerpt: serialized.slice(args.offset, end),
          offset: args.offset, nextOffset: end < serialized.length ? end : null, totalCharacters: serialized.length };
      }
      if (name === 'search_project_memory') {
        const args = searchArgs.parse(raw);
        return { results: await this.memory.search(projectId, args.query, args.limit) };
      }
      if (name === tavilySearchTool.function.name && this.tavily.isConfigured()) return this.tavily.search(argumentsJson, signal);
      return { error: 'UNKNOWN_TOOL' };
    } catch (error) {
      if (signal?.aborted) throw error;
      return { error: error instanceof NotFoundException ? 'NOT_FOUND' : 'INVALID_ARGUMENTS' };
    }
  }
}
