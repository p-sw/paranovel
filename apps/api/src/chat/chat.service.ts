import { BadGatewayException, BadRequestException, ConflictException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { and, desc, eq, getTableColumns, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { ChatHistory, ConversationStreamEvent } from '@paranovel/contracts';
import { ArcEpisodeDirectionsService, type ArcDirectionPlanInput } from '../ai/arc-episode-directions.service';
import { AiRunnerService } from '../ai/ai-runner.service';
import type { ChatMessage as ModelMessage } from '../ai/ai.types';
import { ArcsService } from '../arcs/arcs.service';
import { CanonService } from '../canon/canon.service';
import { DatabaseService } from '../database/database.service';
import { chatMessages, chatProposals, chatThreads } from '../database/schema';
import { ImprovementsService } from '../improvements/improvements.service';
import { MemoryService } from '../memory/memory.service';
import { ProjectsService } from '../projects/projects.service';
import { sanitizeLogText, serializeError } from '../shared/error-log';
import { id, now, parseJson, stringifyJson } from '../shared/utils';
import { ChatEpisodeToolsService } from './chat-episode-tools.service';
import { ChatReadToolsService, type RecordSnapshot, type SnapshotMap } from './chat-read-tools.service';
import { chatOutputSchema, chatOutputValidator, creationDefaults, editableFields, editableValidators, type ChatKind, type ChatOperation, type ChatOutput } from './chat.schemas';
import { IMAGE_TAG_TOOL_NAME, isImageTagToolResult, type ImageTagToolResult } from './image-tag-tool.service';

type ProposalRow = typeof chatProposals.$inferSelect;
type IndexTarget = { kind: Exclude<ChatKind, 'PROJECT'>; id: string };
type Effect = { label: string; before: RecordSnapshot; after: Record<string, unknown> };
type ChatLogStage = 'turn_persist' | 'memory' | 'snapshot' | 'history' | 'ai' | 'run_link_persist'
  | 'arc_directions' | 'abort_check' | 'proposal_transaction' | 'proposal_validate' | 'proposal_persist' | 'message_persist' | 'complete';
type ChatLogContext = {
  stage: ChatLogStage;
  projectId: string;
  threadId: string | null;
  clientMessageId: string;
  assistantMessageId: string | null;
  runId: string | null;
  model: string;
  proposal?: { index: number; kind: ChatKind; operation: ChatOperation; targetId: string | null };
};
const messageInput = z.strictObject({ content: z.string().trim().min(1).max(20_000), clientMessageId: z.string().trim().min(1).max(200) });
const threadInput = z.strictObject({ clientThreadId: z.string().trim().min(1).max(200).optional() });
const GENERATION_ERROR = 'AI 답변을 만들지 못했습니다. 같은 메시지를 다시 시도해 주세요.';
const MAX_IMAGE_TAG_TOOL_ATTEMPTS = 2;
const ARC_PLAN_FIELDS = new Set([
  'title',
  'startEpisodeNumber',
  'endEpisodeNumber',
  'goal',
  'conflict',
  'milestones',
  'episodeDirections',
]);

@Injectable()
export class ChatService implements OnModuleInit {
  private readonly logger = new Logger(ChatService.name);
  private readonly indexing = new Map<string, Promise<void>>();

  constructor(
    private readonly database: DatabaseService,
    private readonly ai: AiRunnerService,
    private readonly arcDirections: ArcEpisodeDirectionsService,
    private readonly projects: ProjectsService,
    private readonly canon: CanonService,
    private readonly arcs: ArcsService,
    private readonly improvements: ImprovementsService,
    private readonly memory: MemoryService,
    private readonly reads: ChatReadToolsService,
    private readonly episodeTools: ChatEpisodeToolsService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.database.orm.update(chatMessages).set({ status: 'FAILED', error: '서버가 재시작되어 답변이 중단되었습니다. 다시 시도해 주세요.' })
      .where(and(eq(chatMessages.role, 'assistant'), eq(chatMessages.status, 'PENDING'))).run();
    const pending = this.database.orm.select().from(chatProposals).where(eq(chatProposals.status, 'APPLIED')).all();
    for (const proposal of pending) {
      if (parseJson<IndexTarget[]>(proposal.indexTargetsJson, []).length) await this.recoverIndex(proposal.id);
    }
  }

  threads(projectId: string) {
    this.projects.get(projectId);
    return this.database.orm.select({
      ...getTableColumns(chatThreads),
      // Keep the outer table qualified inside these correlated subqueries.
      preview: sql<string>`COALESCE((SELECT substr(content, 1, 180) FROM chat_messages
        WHERE thread_id = chat_threads.id AND content != '' ORDER BY rowid DESC LIMIT 1), '')`,
      messageCount: sql<number>`(SELECT count(*) FROM chat_messages WHERE thread_id = chat_threads.id)`,
      status: sql<'PENDING' | 'COMPLETE' | 'FAILED' | null>`CASE
        WHEN EXISTS (SELECT 1 FROM chat_messages WHERE thread_id = chat_threads.id AND status = 'PENDING') THEN 'PENDING'
        ELSE (SELECT status FROM chat_messages WHERE thread_id = chat_threads.id ORDER BY rowid DESC LIMIT 1) END`,
    }).from(chatThreads).where(eq(chatThreads.projectId, projectId))
      .orderBy(desc(chatThreads.updatedAt), sql`rowid DESC`).all();
  }

  createThread(projectId: string, body: unknown = {}) {
    const parsed = threadInput.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException('채팅방 ID를 올바르게 입력해 주세요.');
    return this.database.connection.transaction(() => {
      this.projects.get(projectId);
      const threadId = parsed.data.clientThreadId ?? id();
      const existing = this.database.orm.select().from(chatThreads).where(eq(chatThreads.id, threadId)).get();
      if (existing) {
        if (existing.projectId !== projectId) throw new ConflictException('이미 사용 중인 채팅방 ID입니다.');
        return existing;
      }
      const stamp = now();
      const thread = { id: threadId, projectId, title: '새 채팅', createdAt: stamp, updatedAt: stamp };
      this.database.orm.insert(chatThreads).values(thread).run();
      return thread;
    }).immediate();
  }

  history(projectId: string, threadId?: string) {
    this.projects.get(projectId);
    const thread = threadId ? this.requireThread(projectId, threadId) : this.latestThread(projectId);
    if (!thread) return { thread: null, messages: [] };
    const proposals = this.database.orm.select({ proposal: chatProposals }).from(chatProposals)
      .innerJoin(chatMessages, eq(chatMessages.id, chatProposals.messageId))
      .where(and(eq(chatProposals.projectId, projectId), eq(chatMessages.threadId, thread.id))).all().map((row) => row.proposal);
    const messages = this.database.orm.select().from(chatMessages)
      .where(and(eq(chatMessages.projectId, projectId), eq(chatMessages.threadId, thread.id))).orderBy(sql`rowid`).all();
    return { thread, messages: messages.map((message) => ({
      id: message.id, projectId: message.projectId, clientMessageId: message.clientMessageId,
      role: message.role as 'user' | 'assistant', content: message.content,
      status: message.status as 'PENDING' | 'COMPLETE' | 'FAILED', createdAt: message.createdAt,
      proposals: proposals.filter((proposal) => proposal.messageId === message.id).map((proposal) => this.proposalView(proposal)),
      episodeTasks: this.episodeTools.history(projectId, message.id),
      ...(message.error ? { error: message.error } : {}),
    })) };
  }

  async send(projectId: string, body: unknown, signal?: AbortSignal, threadId?: string,
    onEvent?: (event: ConversationStreamEvent<ChatHistory>) => void) {
    const parsed = messageInput.safeParse(body);
    if (!parsed.success) throw new BadRequestException('content와 clientMessageId를 올바르게 입력해 주세요.');
    const input = parsed.data;
    const startedAt = Date.now();
    const context: ChatLogContext = {
      stage: 'turn_persist', projectId: sanitizeLogText(projectId), threadId: threadId ? sanitizeLogText(threadId) : null,
      clientMessageId: sanitizeLogText(input.clientMessageId),
      assistantMessageId: null, runId: null, model: sanitizeLogText(this.ai.chatModel()),
    };
    const logContext = () => ({ ...context, elapsedMs: Date.now() - startedAt });
    // Only a newly started/retried turn may be marked failed by this request.
    let activeAssistantId: string | undefined;
    let activeThreadId: string | undefined;
    this.logger.log({ event: 'chat_send_started', ...logContext() });
    try {
      const turn = this.database.connection.transaction(() => {
        this.projects.get(projectId);
        const rows = this.database.orm.select().from(chatMessages).where(and(eq(chatMessages.projectId, projectId), eq(chatMessages.clientMessageId, input.clientMessageId))).all();
        const user = rows.find((row) => row.role === 'user');
        const assistant = rows.find((row) => row.role === 'assistant');
        const thread = threadId ? this.requireThread(projectId, threadId)
          : user?.threadId ? this.requireThread(projectId, user.threadId) : this.latestThread(projectId) ?? this.createThread(projectId);
        context.threadId = sanitizeLogText(thread.id);
        if (user && user.threadId !== thread.id) throw new ConflictException('다른 채팅방에서 사용한 메시지 ID입니다.');
        if (user && user.content !== input.content) throw new ConflictException('같은 메시지 ID에 다른 내용을 사용할 수 없습니다.');
        if (assistant?.status === 'COMPLETE') return { id: assistant.id, threadId: thread.id, replay: true, runId: assistant.runId };
        const pending = this.database.orm.select({ id: chatMessages.id }).from(chatMessages)
          .where(and(eq(chatMessages.threadId, thread.id), eq(chatMessages.status, 'PENDING'))).get();
        if (pending) throw new ConflictException('이 채팅방의 AI가 답변 중입니다. 완료된 뒤 다시 시도해 주세요.');
        const stamp = now();
        const hasMessages = this.database.orm.select({ id: chatMessages.id }).from(chatMessages).where(eq(chatMessages.threadId, thread.id)).get();
        this.database.orm.update(chatThreads).set({ updatedAt: stamp,
          ...(!hasMessages ? { title: Array.from(input.content.replace(/\s+/g, ' ')).slice(0, 80).join('') } : {}),
        }).where(eq(chatThreads.id, thread.id)).run();
        if (assistant) {
          this.database.orm.update(chatMessages).set({ status: 'PENDING', content: '', error: null, runId: null }).where(eq(chatMessages.id, assistant.id)).run();
          return { id: assistant.id, threadId: thread.id, replay: false };
        }
        const assistantId = id();
        this.database.orm.insert(chatMessages).values([
          { id: id(), projectId, threadId: thread.id, clientMessageId: input.clientMessageId, role: 'user', content: input.content, status: 'COMPLETE', createdAt: stamp },
          { id: assistantId, projectId, threadId: thread.id, clientMessageId: input.clientMessageId, role: 'assistant', content: '', status: 'PENDING', createdAt: stamp },
        ]).run();
        return { id: assistantId, threadId: thread.id, replay: false };
      }).immediate();
      context.assistantMessageId = sanitizeLogText(turn.id);
      if (turn.replay) {
        context.runId = turn.runId ? sanitizeLogText(turn.runId) : null;
        context.stage = 'history';
        const history = this.history(projectId, turn.threadId);
        context.stage = 'complete';
        this.logger.log({ event: 'chat_send_completed', ...logContext(), replayed: true });
        onEvent?.({ type: 'start', messageId: turn.id });
        return history;
      }
      activeAssistantId = turn.id;
      activeThreadId = turn.threadId;
      onEvent?.({ type: 'start', messageId: turn.id });
      signal?.throwIfAborted();
      context.stage = 'memory';
      const memory = await this.memory.assemble(projectId, input.content);
      context.stage = 'snapshot';
      const { snapshots, catalog } = this.reads.snapshot(projectId);
      context.stage = 'history';
      const history = this.modelHistory(projectId, turn.threadId, input.clientMessageId);
      const recovery = this.episodeTools.recoveryContext(projectId, turn.id);
      if (recovery.length) history.splice(Math.max(0, history.length - 1), 0, {
        role: 'system', content: `동일 사용자 요청을 다시 처리하고 있습니다. 아래 회차 작업은 이미 실행되었습니다. 완료 작업을 새로 만들지 말고 결과를 설명하세요. 실패 작업만 원래 인자로 재시도할 수 있습니다.\n${stringifyJson(recovery)}`,
      });
      context.stage = 'ai';
      let imageTagAttempts = 0;
      let imageTagResult: ImageTagToolResult | undefined;
      const readTools = [...this.reads.definitions(), ...this.episodeTools.definitions()];
      const result = await this.ai.completeChat({
        task: 'project_chat', promptId: 'project-chat', projectId, modelRole: 'CHAT',
        history, signal, maxTokens: 12_000, toolMaxTokens: 8_000,
        variables: {
          project_context: memory.projectContext, writing_direction: memory.writingDirection,
          canon: memory.canon, current_arc: memory.currentArc,
          current_scene: memory.currentScene, recent_summaries: memory.recentSummaries,
          open_foreshadowing: memory.openForeshadowing, retrieved_memories: memory.retrievedMemories,
          improvements: memory.improvements, record_catalog: catalog,
        },
        schema: { name: 'project_chat_reply', value: chatOutputSchema }, validator: chatOutputValidator,
        readTools, onEvent,
        parallelToolNames: readTools.filter((tool) => tool.function.name !== IMAGE_TAG_TOOL_NAME && !this.episodeTools.has(tool.function.name)).map((tool) => tool.function.name),
        resolveAfterTools: () => imageTagResult
          ? { reply: imageTagResult.tagString, proposals: [] }
          : undefined,
        readTool: async (name, args) => {
          if (this.episodeTools.has(name)) {
            const task = await this.episodeTools.call(projectId, turn.id, name, args, signal, onEvent);
            // The child owns manuscript text. Give the parent IDs and outcome,
            // keeping full text in the persistent card and episode read tool.
            if ('id' in task) return { id: task.id, kind: task.kind, status: task.status, episodeId: task.episodeId,
              title: task.title, direction: task.direction, blocked: task.blocked, issues: task.issues,
              ...(task.kind === 'DIRECTION' ? { conflicts: task.content } : {}),
              editStatus: task.editorMessage?.edit?.status ?? null,
              message: task.kind === 'EDIT' ? '수정안이 준비되었습니다. 사용자가 비교 후 적용해야 원고가 변경됩니다.'
                : task.kind === 'WRITE' ? '회차 초안을 저장했습니다. 확정은 별도입니다.' : '회차 구상을 준비했습니다. 아직 본문은 생성하지 않았습니다.' };
            return task;
          }
          if (name === IMAGE_TAG_TOOL_NAME) {
            if (imageTagResult) return imageTagResult;
            if (imageTagAttempts >= MAX_IMAGE_TAG_TOOL_ATTEMPTS) {
              return { error: 'IMAGE_TAG_TOOL_ATTEMPT_LIMIT', message: '이미지 태그 생성 도구의 인자 교정 횟수를 초과했습니다.' };
            }
            imageTagAttempts += 1;
          }
          const toolResult = await this.reads.call(projectId, name, args, snapshots, signal);
          if (name === IMAGE_TAG_TOOL_NAME && isImageTagToolResult(toolResult)) imageTagResult = toolResult;
          return toolResult;
        },
      }, (runId) => {
        context.runId = sanitizeLogText(runId);
        context.stage = 'run_link_persist';
        this.database.orm.update(chatMessages).set({ runId }).where(eq(chatMessages.id, turn.id)).run();
        context.stage = 'ai';
      });
      context.runId = sanitizeLogText(result.runId);
      context.stage = 'abort_check';
      signal?.throwIfAborted();
      const baseOutput: ChatOutput = imageTagResult
        ? { reply: imageTagResult.tagString, proposals: [] }
        : result.value;
      context.stage = 'arc_directions';
      const output = await this.completeArcProposalDirections(
        projectId,
        baseOutput,
        snapshots,
        memory,
        input.content,
        signal,
      );
      context.stage = 'abort_check';
      signal?.throwIfAborted();
      // Episode subagents persist their own results. Commit configuration proposals and the parent reply together.
      context.stage = 'proposal_transaction';
      this.database.connection.transaction(() => {
        this.projects.get(projectId);
        const occupied = new Set<string>();
        for (const [index, proposal] of output.proposals.entries()) {
          context.stage = 'proposal_validate';
          context.proposal = { index, kind: proposal.kind, operation: proposal.operation,
            targetId: proposal.targetId === null ? null : sanitizeLogText(proposal.targetId) };
          if (proposal.targetId) {
            const key = `${proposal.kind}:${proposal.targetId}`;
            if (occupied.has(key)) throw new BadGatewayException('AI가 같은 항목에 중복 변경을 제안했습니다. 다시 시도해 주세요.');
            occupied.add(key);
          }
          const prepared = this.prepareProposal(projectId, turn.id, proposal, snapshots);
          context.stage = 'proposal_persist';
          this.database.orm.insert(chatProposals).values(prepared).run();
        }
        delete context.proposal;
        context.stage = 'message_persist';
        this.database.orm.update(chatMessages).set({ content: output.reply, status: 'COMPLETE', error: null, runId: result.runId })
          .where(eq(chatMessages.id, turn.id)).run();
        this.database.orm.update(chatThreads).set({ updatedAt: now() }).where(eq(chatThreads.id, turn.threadId)).run();
      }).immediate();
      context.stage = 'history';
      const completed = this.history(projectId, turn.threadId);
      context.stage = 'complete';
      this.logger.log({ event: 'chat_send_completed', ...logContext(), replayed: false, proposalCount: output.proposals.length });
      return completed;
    } catch (error) {
      // Record the original failure before touching a potentially failing database.
      this.logger.error({ event: 'chat_send_failed', ...logContext(), error: serializeError(error) });
      if (!activeAssistantId) throw error;
      try {
        this.database.orm.update(chatMessages).set({ status: 'FAILED', error: GENERATION_ERROR })
          .where(eq(chatMessages.id, activeAssistantId)).run();
        if (activeThreadId) this.database.orm.update(chatThreads).set({ updatedAt: now() }).where(eq(chatThreads.id, activeThreadId)).run();
      } catch (persistenceError) {
        this.logger.error({ event: 'chat_failure_status_write_failed', ...logContext(),
          failedStage: context.stage, stage: 'failure_persist', error: serializeError(persistenceError) });
      }
      if (error instanceof NotFoundException || error instanceof ConflictException) throw error;
      throw new BadGatewayException(GENERATION_ERROR, { cause: error });
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
        this.assertArcOperation(kind, operation, current);
        if (current.revision !== before.revision) throw new ConflictException('검토 중 항목이 변경되었습니다. 최신 내용으로 다시 제안해 주세요.');
      }
      if (proposal.activeArcsJson !== null) {
        const expected = parseJson<Array<{ id: string; revision: number; replacementStatus: 'COMPLETE' | 'ARCHIVED' }>>(
          proposal.activeArcsJson,
          [],
        );
        if (stringifyJson(this.activeArcs(projectId)) !== stringifyJson(expected)) throw new ConflictException('검토 중 활성 아크가 변경되었습니다. 다시 제안해 주세요.');
      }
      let result: Record<string, unknown>;
      const targets: IndexTarget[] = [];
      if (operation === 'DELETE') {
        if (kind === 'PROJECT') throw new BadRequestException('프로젝트 삭제는 채팅에서 지원하지 않습니다.');
        if (kind === 'CANON') this.canon.remove(projectId, proposal.targetId!);
        else if (kind === 'ARC') this.arcs.remove(projectId, proposal.targetId!, { expectedRevision: before!.revision });
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
          result = operation === 'CREATE'
            ? this.arcs.persistCreate(projectId, { ...input, confirmProtected: true })
            : this.arcs.persistUpdate(projectId, proposal.targetId!, { ...input, confirmProtected: true });
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

  private async completeArcProposalDirections(
    projectId: string,
    output: ChatOutput,
    snapshots: SnapshotMap,
    memory: Awaited<ReturnType<MemoryService['assemble']>>,
    request: string,
    signal?: AbortSignal,
  ): Promise<ChatOutput> {
    const withoutDirections = editableValidators.ARC.omit({ episodeDirections: true });
    const planFields = (value: Record<string, unknown>) => {
      const { episodeDirections: _directions, ...fields } = editableFields('ARC', value);
      return fields;
    };
    const staged: Array<{
      proposalIndex: number;
      targetId: string | null;
      rawChanges: Record<string, unknown>;
      arc: ArcDirectionPlanInput;
    }> = [];
    for (const [proposalIndex, proposal] of output.proposals.entries()) {
      if (proposal.kind !== 'ARC' || proposal.operation === 'DELETE') continue;
      let raw: unknown;
      try {
        raw = JSON.parse(proposal.changesJson);
      } catch (error) {
        throw new BadGatewayException('AI 변경 필드가 올바르지 않습니다.', { cause: error });
      }
      const rawChanges = z.record(z.string(), z.unknown()).parse(raw);
      const { episodeDirections: _modelDirections, ...milestoneChanges } = rawChanges;
      const changes = withoutDirections.partial().parse(milestoneChanges) as Record<string, unknown>;
      const changesPlan = proposal.operation === 'CREATE'
        || Object.keys(changes).some((field) => ARC_PLAN_FIELDS.has(field));
      if (!changesPlan) continue;
      const before = proposal.targetId ? snapshots.get(`ARC:${proposal.targetId}`) ?? null : null;
      if (proposal.operation === 'UPDATE' && !before) {
        throw new BadGatewayException('AI가 조회하지 않은 아크의 변경을 제안했습니다.');
      }
      const candidate = withoutDirections.parse({
        ...creationDefaults.ARC,
        ...(before ? planFields(before) : {}),
        ...milestoneChanges,
      });
      staged.push({
        proposalIndex,
        targetId: proposal.targetId,
        rawChanges: milestoneChanges,
        arc: {
          title: candidate.title,
          startEpisodeNumber: candidate.startEpisodeNumber,
          endEpisodeNumber: candidate.endEpisodeNumber,
          goal: candidate.goal,
          conflict: candidate.conflict,
          milestones: candidate.milestones,
        },
      });
    }
    if (staged.length === 0) return output;

    const replacedIds = new Set(staged.flatMap((item) => item.targetId ? [item.targetId] : []));
    const surroundingArcs: ArcDirectionPlanInput[] = [];
    for (const [key, snapshot] of snapshots) {
      if (!key.startsWith('ARC:') || replacedIds.has(snapshot.id) || snapshot.status === 'ARCHIVED') continue;
      const candidate = withoutDirections.safeParse({
        ...creationDefaults.ARC,
        ...planFields(snapshot),
      });
      if (!candidate.success) continue;
      surroundingArcs.push({
        title: candidate.data.title,
        startEpisodeNumber: candidate.data.startEpisodeNumber,
        endEpisodeNumber: candidate.data.endEpisodeNumber,
        goal: candidate.data.goal,
        conflict: candidate.data.conflict,
        milestones: candidate.data.milestones,
      });
    }
    surroundingArcs.push(...staged.map((item) => item.arc));
    surroundingArcs.sort((left, right) =>
      left.startEpisodeNumber - right.startEpisodeNumber
      || left.endEpisodeNumber - right.endEpisodeNumber,
    );

    const generated = await this.arcDirections.generateMany(staged.map((item) => ({
      projectId,
      projectContext: memory.projectContext,
      writingDirection: memory.writingDirection,
      canon: memory.canon,
      surroundingArcs,
      arc: item.arc,
      generationRequest: request,
      signal,
    })));
    const proposals = [...output.proposals];
    staged.forEach((item, index) => {
      const proposal = proposals[item.proposalIndex]!;
      proposals[item.proposalIndex] = {
        ...proposal,
        changesJson: stringifyJson({
          ...item.rawChanges,
          // The chat model only owns the milestone stage. Always replace a
          // model-supplied direction array with the dedicated second stage.
          episodeDirections: generated[index]!,
        }),
      };
    });
    return { ...output, proposals };
  }

  private prepareProposal(projectId: string, messageId: string, input: ChatOutput['proposals'][number], snapshots: SnapshotMap): typeof chatProposals.$inferInsert {
    const { kind, operation } = input;
    if (kind === 'PROJECT' && operation !== 'UPDATE') throw new BadGatewayException('프로젝트는 수정만 제안할 수 있습니다.');
    if ((operation === 'CREATE') !== (input.targetId === null)) throw new BadGatewayException('AI 변경 대상이 올바르지 않습니다.');
    let raw: unknown;
    try { raw = JSON.parse(input.changesJson); } catch (error) { throw new BadGatewayException('AI 변경 필드가 올바르지 않습니다.', { cause: error }); }
    const changes = editableValidators[kind].partial().parse(raw) as Record<string, unknown>;
    if (operation === 'DELETE' && Object.keys(changes).length) throw new BadGatewayException('삭제 제안에는 변경 필드를 넣을 수 없습니다.');
    if (operation === 'UPDATE' && !Object.keys(changes).length) throw new BadGatewayException('수정할 필드가 없습니다.');
    const before = input.targetId ? snapshots.get(`${kind}:${input.targetId}`) ?? null : null;
    if (operation !== 'CREATE') {
      if (!before || !input.targetId) throw new BadGatewayException('AI가 조회하지 않은 항목의 변경을 제안했습니다.');
      this.assertWritable(projectId, kind, before);
      this.assertArcOperation(kind, operation, before);
      const current = this.reads.getRecord(projectId, kind, input.targetId);
      if (current.revision !== before.revision) throw new ConflictException('답변 생성 중 항목이 변경되었습니다. 다시 시도해 주세요.');
    }
    let after: Record<string, unknown> | null = null;
    if (operation !== 'DELETE') {
      const fields = editableValidators[kind].parse({
        ...creationDefaults[kind], ...(before ? editableFields(kind, before) : {}), ...changes,
      }) as Record<string, unknown>;
      this.validateArc(kind, fields);
      this.assertArcStatusTransition(kind, operation, before, fields);
      if (kind === 'IMPROVEMENT' && operation === 'CREATE' && fields.active !== true) throw new BadGatewayException('새 개선점은 활성 상태로 제안해 주세요.');
      after = { ...(before ?? {}), ...fields, ...(before ? { revision: before.revision + 1 } : {}) };
      if (kind === 'IMPROVEMENT') Object.assign(after, { scope: 'PROJECT', projectId });
    }
    const effects: Effect[] = [];
    let activeArcs: Array<{
      id: string;
      revision: number;
      replacementStatus: 'COMPLETE' | 'ARCHIVED';
    }> | null = null;
    if (kind === 'ARC' && after?.status === 'ACTIVE') {
      activeArcs = this.activeArcs(projectId);
      const snapshotActive = [...snapshots.entries()].filter(([key, value]) => key.startsWith('ARC:') && value.status === 'ACTIVE')
        .map(([, value]) => ({ id: value.id, revision: value.revision })).sort((a, b) => a.id.localeCompare(b.id));
      if (stringifyJson(snapshotActive) !== stringifyJson(
        activeArcs.map(({ id: arcId, revision }) => ({ id: arcId, revision })),
      )) throw new ConflictException('답변 생성 중 활성 아크가 변경되었습니다.');
      for (const arc of this.arcs.list(projectId).filter((arc) => arc.status === 'ACTIVE' && arc.id !== input.targetId)) {
        const nextStatus = this.arcs.replacementStatus(projectId, arc);
        effects.push({
          label: `기존 현재 아크 “${arc.title}” ${nextStatus === 'COMPLETE' ? '완료' : '보관'}`,
          before: arc as RecordSnapshot,
          after: { ...arc, status: nextStatus, revision: arc.revision + 1 },
        });
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

  private assertArcOperation(kind: ChatKind, operation: ChatOperation, record: RecordSnapshot): void {
    if (kind !== 'ARC') return;
    if (['COMPLETE', 'ARCHIVED'].includes(String(record.status))) {
      throw new BadRequestException('이전·보관 아크는 채팅에서 변경할 수 없습니다.');
    }
    if (operation === 'DELETE' && record.status !== 'PLANNED') {
      throw new BadRequestException('대기 중인 미래 아크만 삭제할 수 있습니다.');
    }
  }

  private validateArc(kind: ChatKind, fields: Record<string, unknown>): void {
    if (kind !== 'ARC') return;
    const start = Number(fields.startEpisodeNumber);
    const end = Number(fields.endEpisodeNumber);
    const span = end - start + 1;
    if (span < 5 || span > 20) throw new BadRequestException('아크는 5~20화 범위여야 합니다.');
    const milestones = fields.milestones as Array<{ episode: number }>;
    if (!milestones.length || milestones.some((item) => item.episode < start || item.episode > end)) {
      throw new BadRequestException('아크 마일스톤은 하나 이상이며 모두 아크 범위 안이어야 합니다.');
    }
    const directions = fields.episodeDirections as Array<{ episode: number }>;
    if (directions.length !== span || directions.some((item, index) => item.episode !== start + index)) {
      throw new BadRequestException('아크 범위의 모든 회차에 전개 방향이 정확히 하나씩 필요합니다.');
    }
  }

  private assertArcStatusTransition(
    kind: ChatKind,
    operation: ChatOperation,
    before: RecordSnapshot | null,
    fields: Record<string, unknown>,
  ): void {
    if (kind !== 'ARC') return;
    const nextStatus = fields.status;
    const allowed = operation === 'CREATE'
      ? ['PLANNED', 'ACTIVE']
      : before?.status === 'PLANNED'
        ? ['PLANNED', 'ACTIVE']
        : before?.status === 'ACTIVE'
          ? ['ACTIVE']
          : [];
    if (!allowed.includes(String(nextStatus))) {
      throw new BadRequestException('아크 상태 전이가 올바르지 않습니다.');
    }
  }

  private activeArcs(projectId: string) {
    return this.arcs.list(projectId).filter((arc) => arc.status === 'ACTIVE')
      .map((arc) => ({
        id: arc.id,
        revision: arc.revision,
        replacementStatus: this.arcs.replacementStatus(projectId, arc),
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  private latestThread(projectId: string) {
    return this.database.orm.select().from(chatThreads).where(eq(chatThreads.projectId, projectId))
      .orderBy(desc(chatThreads.updatedAt), sql`rowid DESC`).get();
  }

  private requireThread(projectId: string, threadId: string) {
    const thread = this.database.orm.select().from(chatThreads)
      .where(and(eq(chatThreads.id, threadId), eq(chatThreads.projectId, projectId))).get();
    if (!thread) throw new NotFoundException('채팅방을 찾을 수 없습니다.');
    return thread;
  }

  private modelHistory(projectId: string, threadId: string, currentClientId: string): ModelMessage[] {
    const stored = this.history(projectId, threadId).messages;
    // A retried turn stays at its original position and must not see later turns.
    const currentIndex = stored.findIndex((message) => message.role === 'user' && message.clientMessageId === currentClientId);
    const all = currentIndex >= 0 ? stored.slice(0, currentIndex + 1) : stored;
    const hasOutcome = (message: typeof stored[number]) => message.status === 'COMPLETE' || message.episodeTasks.length > 0;
    const eligible = all.filter((message) => message.role === 'assistant' ? hasOutcome(message)
      : message.status === 'COMPLETE' && (message.clientMessageId === currentClientId
        || all.some((other) => other.clientMessageId === message.clientMessageId && other.role === 'assistant' && hasOutcome(other))));
    const current = eligible.find((message) => message.role === 'user' && message.clientMessageId === currentClientId);
    const candidates = [...eligible.filter((message) => message !== current), ...(current ? [current] : [])].slice(-20);
    const selected: ModelMessage[] = [];
    let characters = 0;
    for (const message of [...candidates].reverse()) {
      const proposalSummary = message.proposals.map((proposal) => ({ id: proposal.id, kind: proposal.kind, operation: proposal.operation,
        title: proposal.title, status: proposal.status, targetId: proposal.targetId,
        changes: proposal.after ? editableFields(proposal.kind, proposal.after) : null }));
      const tasks = message.episodeTasks.map((task) => ({ id: task.id, kind: task.kind, status: task.status,
        episodeId: task.episodeId, title: task.title, direction: task.direction, error: task.error,
        editStatus: task.editorMessage?.edit?.status ?? null, blocked: task.blocked }));
      const content = `${message.content}${proposalSummary.length ? `\n[이 메시지의 변경 제안과 현재 적용 상태]\n${stringifyJson(proposalSummary)}` : ''}${tasks.length ? `\n[회차 서브에이전트 작업 결과]\n${stringifyJson(tasks)}` : ''}`;
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
    const kind = row.kind as ChatKind;
    const normalize = (value: Record<string, unknown> | null) => {
      if (!value || kind !== 'ARC') return value;
      const { reversalPlan: _legacyReversalPlan, ...rest } = value;
      return { ...rest, ...editableFields('ARC', value) };
    };
    return { id: row.id, projectId: row.projectId, messageId: row.messageId,
      kind, operation: row.operation as ChatOperation, title: row.title, targetId: row.targetId,
      before: normalize(parseJson<Record<string, unknown> | null>(row.beforeJson, null)),
      after: normalize(parseJson<Record<string, unknown> | null>(row.afterJson, null)),
      effects: parseJson<Effect[]>(row.effectsJson, []).map((effect) => ({
        ...effect,
        before: normalize(effect.before),
        after: normalize(effect.after),
      })),
      status: row.status as 'PENDING' | 'APPLIED', createdAt: row.createdAt, appliedAt: row.appliedAt,
      result: normalize(parseJson<Record<string, unknown> | null>(row.resultJson, null)) };
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
