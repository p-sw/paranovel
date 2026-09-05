import { BadGatewayException, BadRequestException, ConflictException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { AiRunnerService } from '../ai/ai-runner.service';
import type { ChatMessage as ModelMessage } from '../ai/ai.types';
import { ArcsService } from '../arcs/arcs.service';
import { CanonService } from '../canon/canon.service';
import { DatabaseService } from '../database/database.service';
import { chatMessages, chatProposals } from '../database/schema';
import { ImprovementsService } from '../improvements/improvements.service';
import { MemoryService } from '../memory/memory.service';
import { ProjectsService } from '../projects/projects.service';
import { id, now, parseJson, stringifyJson } from '../shared/utils';
import { ChatReadToolsService, type RecordSnapshot, type SnapshotMap } from './chat-read-tools.service';
import { chatOutputSchema, chatOutputValidator, creationDefaults, editableFields, editableValidators, type ChatKind, type ChatOperation, type ChatOutput } from './chat.schemas';

type ProposalRow = typeof chatProposals.$inferSelect;
type IndexTarget = { kind: Exclude<ChatKind, 'PROJECT'>; id: string };
type Effect = { label: string; before: RecordSnapshot; after: Record<string, unknown> };
const messageInput = z.strictObject({ content: z.string().trim().min(1).max(20_000), clientMessageId: z.string().trim().min(1).max(200) });
const GENERATION_ERROR = 'AI 답변을 만들지 못했습니다. 같은 메시지를 다시 시도해 주세요.';

@Injectable()
export class ChatService implements OnModuleInit {
  private readonly logger = new Logger(ChatService.name);
  private readonly indexing = new Map<string, Promise<void>>();

  constructor(
    private readonly database: DatabaseService,
    private readonly ai: AiRunnerService,
    private readonly projects: ProjectsService,
    private readonly canon: CanonService,
    private readonly arcs: ArcsService,
    private readonly improvements: ImprovementsService,
    private readonly memory: MemoryService,
    private readonly reads: ChatReadToolsService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.database.orm.update(chatMessages).set({ status: 'FAILED', error: '서버가 재시작되어 답변이 중단되었습니다. 다시 시도해 주세요.' })
      .where(and(eq(chatMessages.role, 'assistant'), eq(chatMessages.status, 'PENDING'))).run();
    const pending = this.database.orm.select().from(chatProposals).where(eq(chatProposals.status, 'APPLIED')).all();
    for (const proposal of pending) {
      if (parseJson<IndexTarget[]>(proposal.indexTargetsJson, []).length) await this.recoverIndex(proposal.id);
    }
  }

  history(projectId: string) {
    this.projects.get(projectId);
    const proposals = this.database.orm.select().from(chatProposals).where(eq(chatProposals.projectId, projectId)).all();
    const messages = this.database.orm.select().from(chatMessages).where(eq(chatMessages.projectId, projectId)).orderBy(sql`rowid`).all();
    return { messages: messages.map((message) => ({
      id: message.id, projectId: message.projectId, clientMessageId: message.clientMessageId,
      role: message.role as 'user' | 'assistant', content: message.content,
      status: message.status as 'PENDING' | 'COMPLETE' | 'FAILED', createdAt: message.createdAt,
      proposals: proposals.filter((proposal) => proposal.messageId === message.id).map((proposal) => this.proposalView(proposal)),
      ...(message.error ? { error: message.error } : {}),
    })) };
  }

  async send(projectId: string, body: unknown, signal?: AbortSignal) {
    const parsed = messageInput.safeParse(body);
    if (!parsed.success) throw new BadRequestException('content와 clientMessageId를 올바르게 입력해 주세요.');
    const input = parsed.data;
    const turn = this.database.connection.transaction(() => {
      this.projects.get(projectId);
      const rows = this.database.orm.select().from(chatMessages).where(and(eq(chatMessages.projectId, projectId), eq(chatMessages.clientMessageId, input.clientMessageId))).all();
      const user = rows.find((row) => row.role === 'user');
      const assistant = rows.find((row) => row.role === 'assistant');
      if (user && user.content !== input.content) throw new ConflictException('같은 메시지 ID에 다른 내용을 사용할 수 없습니다.');
      if (assistant?.status === 'COMPLETE') return { id: assistant.id, replay: true };
      const pending = this.database.orm.select({ id: chatMessages.id }).from(chatMessages)
        .where(and(eq(chatMessages.projectId, projectId), eq(chatMessages.status, 'PENDING'))).get();
      if (pending) throw new ConflictException('이 작품의 AI가 답변 중입니다. 완료된 뒤 다시 시도해 주세요.');
      if (assistant) {
        this.database.orm.update(chatMessages).set({ status: 'PENDING', content: '', error: null, runId: null }).where(eq(chatMessages.id, assistant.id)).run();
        return { id: assistant.id, replay: false };
      }
      const stamp = now();
      const assistantId = id();
      this.database.orm.insert(chatMessages).values([
        { id: id(), projectId, clientMessageId: input.clientMessageId, role: 'user', content: input.content, status: 'COMPLETE', createdAt: stamp },
        { id: assistantId, projectId, clientMessageId: input.clientMessageId, role: 'assistant', content: '', status: 'PENDING', createdAt: stamp },
      ]).run();
      return { id: assistantId, replay: false };
    }).immediate();
    if (turn.replay) return this.history(projectId);

    try {
      const memory = await this.memory.assemble(projectId, input.content);
      const { snapshots, catalog } = this.reads.snapshot(projectId);
      const history = this.modelHistory(projectId, input.clientMessageId);
      const result = await this.ai.completeChat({
        task: 'project_chat', promptId: 'project-chat', projectId, modelRole: 'CHAT',
        history, signal, maxTokens: 12_000,
        variables: {
          project_context: memory.projectContext, canon: memory.canon, current_arc: memory.currentArc,
          current_scene: memory.currentScene, recent_summaries: memory.recentSummaries,
          open_foreshadowing: memory.openForeshadowing, retrieved_memories: memory.retrievedMemories,
          improvements: memory.improvements, record_catalog: catalog,
        },
        schema: { name: 'project_chat_reply', value: chatOutputSchema }, validator: chatOutputValidator,
        readTools: this.reads.definitions(),
        readTool: (name, args) => this.reads.call(projectId, name, args, snapshots, signal),
      }, (runId) => {
        this.database.orm.update(chatMessages).set({ runId }).where(eq(chatMessages.id, turn.id)).run();
      });
      signal?.throwIfAborted();
      // No entity is changed while preparing proposals. Persist the complete turn atomically.
      this.database.connection.transaction(() => {
        this.projects.get(projectId);
        const occupied = new Set<string>();
        for (const proposal of result.value.proposals) {
          if (proposal.targetId) {
            const key = `${proposal.kind}:${proposal.targetId}`;
            if (occupied.has(key)) throw new BadGatewayException('AI가 같은 항목에 중복 변경을 제안했습니다. 다시 시도해 주세요.');
            occupied.add(key);
          }
          this.database.orm.insert(chatProposals).values(this.prepareProposal(projectId, turn.id, proposal, snapshots)).run();
        }
        this.database.orm.update(chatMessages).set({ content: result.value.reply, status: 'COMPLETE', error: null, runId: result.runId })
          .where(eq(chatMessages.id, turn.id)).run();
      }).immediate();
      return this.history(projectId);
    } catch (error) {
      this.database.orm.update(chatMessages).set({ status: 'FAILED', error: GENERATION_ERROR })
        .where(eq(chatMessages.id, turn.id)).run();
      if (error instanceof NotFoundException || error instanceof ConflictException) throw error;
      throw new BadGatewayException(GENERATION_ERROR);
    }
  }

  async apply(projectId: string, proposalId: string) {
    this.database.connection.transaction(() => {
      this.projects.get(projectId);
      const proposal = this.requireProposal(projectId, proposalId);
      if (proposal.status === 'APPLIED') return;
      const kind = proposal.kind as ChatKind;
      const operation = proposal.operation as ChatOperation;
      const before = parseJson<RecordSnapshot | null>(proposal.beforeJson, null);
      const after = parseJson<Record<string, unknown> | null>(proposal.afterJson, null);
      if (operation !== 'CREATE') {
        if (!before || !proposal.targetId) throw new BadRequestException('변경 대상이 없습니다.');
        const current = this.reads.getRecord(projectId, kind, proposal.targetId);
        this.assertWritable(projectId, kind, current);
        if (current.revision !== before.revision) throw new ConflictException('검토 중 항목이 변경되었습니다. 최신 내용으로 다시 제안해 주세요.');
      }
      if (proposal.activeArcsJson !== null) {
        const expected = parseJson<Array<{ id: string; revision: number }>>(proposal.activeArcsJson, []);
        if (stringifyJson(this.activeArcs(projectId)) !== stringifyJson(expected)) throw new ConflictException('검토 중 활성 아크가 변경되었습니다. 다시 제안해 주세요.');
      }
      let result: Record<string, unknown>;
      const targets: IndexTarget[] = [];
      if (operation === 'DELETE') {
        if (kind === 'PROJECT') throw new BadRequestException('프로젝트 삭제는 채팅에서 지원하지 않습니다.');
        if (kind === 'CANON') this.canon.remove(projectId, proposal.targetId!);
        else if (kind === 'ARC') this.arcs.remove(projectId, proposal.targetId!);
        else this.improvements.remove(proposal.targetId!);
        result = { id: proposal.targetId, deleted: true };
      } else {
        const fields = editableValidators[kind].parse(editableFields(kind, after ?? {}));
        this.validateArc(kind, fields);
        const input = { ...fields, expectedRevision: before?.revision };
        if (kind === 'PROJECT') {
          if (operation !== 'UPDATE') throw new BadRequestException('프로젝트는 수정만 지원합니다.');
          result = this.projects.update(projectId, input) as unknown as Record<string, unknown>;
        } else if (kind === 'CANON') {
          result = operation === 'CREATE' ? this.canon.persistCreate(projectId, input) : this.canon.persistUpdate(projectId, proposal.targetId!, input);
        } else if (kind === 'ARC') {
          result = operation === 'CREATE' ? this.arcs.persistCreate(projectId, input) : this.arcs.persistUpdate(projectId, proposal.targetId!, input);
        } else {
          result = operation === 'CREATE'
            ? this.improvements.persistCreate({ ...input, scope: 'PROJECT', projectId, source: 'MANUAL' })
            : this.improvements.persistUpdate(proposal.targetId!, input);
        }
        if (kind !== 'PROJECT') targets.push({ kind, id: String(result.id) });
        const effects = parseJson<Effect[]>(proposal.effectsJson, []);
        for (const effect of effects) targets.push({ kind: 'ARC', id: effect.before.id });
      }
      this.database.orm.update(chatProposals).set({
        status: 'APPLIED', targetId: typeof result.id === 'string' ? result.id : proposal.targetId,
        resultJson: stringifyJson(result), indexTargetsJson: stringifyJson(targets), appliedAt: now(),
      }).where(eq(chatProposals.id, proposalId)).run();
    }).immediate();
    await this.recoverIndex(proposalId);
    return { proposal: this.proposalView(this.requireProposal(projectId, proposalId)) };
  }

  private prepareProposal(projectId: string, messageId: string, input: ChatOutput['proposals'][number], snapshots: SnapshotMap): typeof chatProposals.$inferInsert {
    const { kind, operation } = input;
    if (kind === 'PROJECT' && operation !== 'UPDATE') throw new BadGatewayException('프로젝트는 수정만 제안할 수 있습니다.');
    if ((operation === 'CREATE') !== (input.targetId === null)) throw new BadGatewayException('AI 변경 대상이 올바르지 않습니다.');
    let raw: unknown;
    try { raw = JSON.parse(input.changesJson); } catch { throw new BadGatewayException('AI 변경 필드가 올바르지 않습니다.'); }
    const changes = editableValidators[kind].partial().parse(raw) as Record<string, unknown>;
    if (operation === 'DELETE' && Object.keys(changes).length) throw new BadGatewayException('삭제 제안에는 변경 필드를 넣을 수 없습니다.');
    if (operation === 'UPDATE' && !Object.keys(changes).length) throw new BadGatewayException('수정할 필드가 없습니다.');
    const before = input.targetId ? snapshots.get(`${kind}:${input.targetId}`) ?? null : null;
    if (operation !== 'CREATE') {
      if (!before || !input.targetId) throw new BadGatewayException('AI가 조회하지 않은 항목의 변경을 제안했습니다.');
      this.assertWritable(projectId, kind, before);
      const current = this.reads.getRecord(projectId, kind, input.targetId);
      if (current.revision !== before.revision) throw new ConflictException('답변 생성 중 항목이 변경되었습니다. 다시 시도해 주세요.');
    }
    let after: Record<string, unknown> | null = null;
    if (operation !== 'DELETE') {
      const fields = editableValidators[kind].parse({
        ...creationDefaults[kind], ...(before ? editableFields(kind, before) : {}), ...changes,
      }) as Record<string, unknown>;
      this.validateArc(kind, fields);
      if (kind === 'IMPROVEMENT' && operation === 'CREATE' && fields.active !== true) throw new BadGatewayException('새 개선점은 활성 상태로 제안해 주세요.');
      after = { ...(before ?? {}), ...fields, ...(before ? { revision: before.revision + 1 } : {}) };
      if (kind === 'IMPROVEMENT') Object.assign(after, { scope: 'PROJECT', projectId });
    }
    const effects: Effect[] = [];
    let activeArcs: Array<{ id: string; revision: number }> | null = null;
    if (kind === 'ARC' && after?.status === 'ACTIVE') {
      activeArcs = this.activeArcs(projectId);
      const snapshotActive = [...snapshots.entries()].filter(([key, value]) => key.startsWith('ARC:') && value.status === 'ACTIVE')
        .map(([, value]) => ({ id: value.id, revision: value.revision })).sort((a, b) => a.id.localeCompare(b.id));
      if (stringifyJson(snapshotActive) !== stringifyJson(activeArcs)) throw new ConflictException('답변 생성 중 활성 아크가 변경되었습니다.');
      for (const arc of this.arcs.list(projectId).filter((arc) => arc.status === 'ACTIVE' && arc.id !== input.targetId)) {
        effects.push({ label: `기존 활성 아크 “${arc.title}” 보관`, before: arc as RecordSnapshot, after: { ...arc, status: 'ARCHIVED', revision: arc.revision + 1 } });
      }
    }
    return { id: id(), projectId, messageId, kind, operation, title: input.title, targetId: input.targetId,
      beforeJson: stringifyJson(before), afterJson: stringifyJson(after), effectsJson: stringifyJson(effects),
      activeArcsJson: activeArcs ? stringifyJson(activeArcs) : null,
      status: 'PENDING', indexTargetsJson: '[]', createdAt: now() };
  }

  private assertWritable(projectId: string, kind: ChatKind, record: RecordSnapshot): void {
    if ((kind === 'PROJECT' && record.id !== projectId)
      || (kind !== 'PROJECT' && record.projectId !== projectId)
      || (kind === 'IMPROVEMENT' && record.scope !== 'PROJECT')) {
      throw new BadRequestException('현재 작품의 항목만 변경할 수 있습니다. 전역 개선점은 읽기 전용입니다.');
    }
  }

  private validateArc(kind: ChatKind, fields: Record<string, unknown>): void {
    if (kind !== 'ARC') return;
    const span = Number(fields.endEpisodeNumber) - Number(fields.startEpisodeNumber) + 1;
    if (span < 5 || span > 20) throw new BadRequestException('아크는 5~20화 범위여야 합니다.');
  }

  private activeArcs(projectId: string) {
    return this.arcs.list(projectId).filter((arc) => arc.status === 'ACTIVE')
      .map((arc) => ({ id: arc.id, revision: arc.revision })).sort((a, b) => a.id.localeCompare(b.id));
  }

  private modelHistory(projectId: string, currentClientId: string): ModelMessage[] {
    const stored = this.history(projectId).messages;
    // A retried turn stays at its original position and must not see later turns.
    const currentIndex = stored.findIndex((message) => message.role === 'user' && message.clientMessageId === currentClientId);
    const all = currentIndex >= 0 ? stored.slice(0, currentIndex + 1) : stored;
    const eligible = all.filter((message) => message.status === 'COMPLETE' && (message.role === 'assistant'
      || message.clientMessageId === currentClientId
      || all.some((other) => other.clientMessageId === message.clientMessageId && other.role === 'assistant' && other.status === 'COMPLETE')));
    const current = eligible.find((message) => message.role === 'user' && message.clientMessageId === currentClientId);
    const candidates = [...eligible.filter((message) => message !== current), ...(current ? [current] : [])].slice(-20);
    const selected: ModelMessage[] = [];
    let characters = 0;
    for (const message of [...candidates].reverse()) {
      const proposalSummary = message.proposals.map((proposal) => ({ id: proposal.id, kind: proposal.kind, operation: proposal.operation,
        title: proposal.title, status: proposal.status, targetId: proposal.targetId,
        changes: proposal.after ? editableFields(proposal.kind, proposal.after) : null }));
      const content = `${message.content}${proposalSummary.length ? `\n[이 메시지의 변경 제안과 현재 적용 상태]\n${stringifyJson(proposalSummary)}` : ''}`;
      if (characters + content.length > 40_000) break;
      selected.unshift({ role: message.role, content });
      characters += content.length;
    }
    return selected;
  }

  private requireProposal(projectId: string, proposalId: string): ProposalRow {
    const proposal = this.database.orm.select().from(chatProposals)
      .where(and(eq(chatProposals.id, proposalId), eq(chatProposals.projectId, projectId))).get();
    if (!proposal) throw new NotFoundException('변경 제안을 찾을 수 없습니다.');
    return proposal;
  }

  private proposalView(row: ProposalRow) {
    return { id: row.id, projectId: row.projectId, messageId: row.messageId,
      kind: row.kind as ChatKind, operation: row.operation as ChatOperation, title: row.title, targetId: row.targetId,
      before: parseJson<Record<string, unknown> | null>(row.beforeJson, null),
      after: parseJson<Record<string, unknown> | null>(row.afterJson, null),
      effects: parseJson<Effect[]>(row.effectsJson, []), status: row.status as 'PENDING' | 'APPLIED',
      createdAt: row.createdAt, appliedAt: row.appliedAt, result: parseJson<Record<string, unknown> | null>(row.resultJson, null) };
  }

  private recoverIndex(proposalId: string): Promise<void> {
    const existing = this.indexing.get(proposalId);
    if (existing) return existing;
    const pending = this.performIndexRecovery(proposalId).finally(() => this.indexing.delete(proposalId));
    this.indexing.set(proposalId, pending);
    return pending;
  }

  private async performIndexRecovery(proposalId: string): Promise<void> {
    const row = this.database.orm.select().from(chatProposals).where(eq(chatProposals.id, proposalId)).get();
    if (!row) return;
    const remaining = parseJson<IndexTarget[]>(row.indexTargetsJson, []);
    for (const target of [...remaining]) {
      try {
        // Read the latest source on every retry, never re-index the old proposal snapshot.
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const before = this.reads.getRecord(row.projectId, target.kind, target.id);
          if (target.kind === 'CANON') await this.canon.syncMemory(row.projectId, target.id);
          else if (target.kind === 'ARC') await this.arcs.syncMemory(row.projectId, target.id);
          else await this.improvements.syncMemory(target.id);
          const after = this.reads.getRecord(row.projectId, target.kind, target.id);
          if (before.revision === after.revision) break;
          if (attempt === 2) throw new Error('Source kept changing during indexing');
        }
      } catch (error) {
        if (!(error instanceof NotFoundException)) {
          this.logger.warn(`Chat proposal ${proposalId}: memory indexing will be retried`);
          continue;
        }
        this.memory.removeSource(target.kind, target.id);
      }
      const index = remaining.findIndex((item) => item.kind === target.kind && item.id === target.id);
      if (index >= 0) remaining.splice(index, 1);
      this.database.orm.update(chatProposals).set({ indexTargetsJson: stringifyJson(remaining) }).where(eq(chatProposals.id, proposalId)).run();
    }
  }
}
