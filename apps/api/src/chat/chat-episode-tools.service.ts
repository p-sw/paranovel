import { BadRequestException, ConflictException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { ChatEpisodeTask, ChatHistory, ConversationStreamEvent } from '@paranovel/contracts';
import type { ToolDefinition } from '../ai/ai.types';
import { DatabaseService } from '../database/database.service';
import { chatEpisodeTasks, chatMessages } from '../database/schema';
import { EditorAiService } from '../episodes/editor-ai.service';
import { EpisodesService, type StreamEvent } from '../episodes/episodes.service';
import { id, parseJson, stringifyJson } from '../shared/utils';

const planInput = z.strictObject({
  instruction: z.string().trim().min(1).max(5_000),
  title: z.string().trim().min(1).max(200).nullable(),
  direction: z.string().max(20_000).refine((text) => Boolean(text.trim())).nullable(),
}).refine((input) => (input.title === null) === (input.direction === null));
const writeInput = z.strictObject({
  title: z.string().trim().min(1).max(200),
  direction: z.string().max(20_000).refine((text) => Boolean(text.trim())),
  targetChars: z.number().int().min(300).max(100_000).nullable(),
});
const editInput = z.strictObject({
  episodeId: z.string().trim().min(1),
  expectedRevision: z.number().int().nonnegative(),
  instruction: z.string().trim().min(1).max(20_000),
});
function tool(name: string, description: string, validator: z.ZodType): ToolDefinition {
  const { $schema: _, ...parameters } = z.toJSONSchema(validator);
  return { type: 'function', function: { name, description, parameters, strict: true } };
}
const definitions = [
  tool('plan_episode', 'Delegate episode direction planning to the same subagent as the New Episode dialog. Pass null title/direction for a new plan; pass BOTH previous title and direction to refine it using the instruction. Does not create an episode. One direction result per user turn; discuss further in the next turn.', planInput),
  tool('write_episode', 'Delegate a new MAIN episode to the same writing and continuity-review subagents as New Episode. Creates and saves a draft, never confirms it. Use only when the user asks to write, with the title/direction agreed in conversation (or call plan_episode first). targetChars null uses project default. One new episode per user turn; repeated calls replay the same result.', writeInput),
  tool('edit_episode', 'Delegate an existing episode to Editor AI. Read the episode first and pass its actual ID/revision and a self-contained instruction reflecting the conversation. Returns a real text edit preview; the user applies it with the same editor Apply button. Does not silently apply edits. One editing task per user turn.', editInput),
];
type StoredTask = ChatEpisodeTask & { baseRevision?: number };
type Emit = (event: ConversationStreamEvent<ChatHistory>) => void;

@Injectable()
export class ChatEpisodeToolsService implements OnModuleInit {
  constructor(
    private readonly database: DatabaseService,
    private readonly episodes: EpisodesService,
    private readonly editor: EditorAiService,
  ) {}

  onModuleInit() {
    for (const row of this.database.orm.select().from(chatEpisodeTasks).where(eq(chatEpisodeTasks.status, 'PENDING')).all()) {
      const task = parseJson<StoredTask>(row.taskJson, {} as StoredTask);
      this.retainInterruptedDraft(task);
      this.persist({ ...task, status: 'FAILED', blocked: task.blocked || (task.kind === 'WRITE' && Boolean(task.content.trim())),
        error: '서버가 재시작되어 회차 작업이 중단되었습니다. 남은 원고를 확인한 뒤 다시 요청해 주세요.' });
    }
  }

  definitions() { return [...definitions]; }
  has(name: string) { return definitions.some((item) => item.function.name === name); }

  history(projectId: string, messageId: string): ChatEpisodeTask[] {
    return this.database.orm.select().from(chatEpisodeTasks).where(and(
      eq(chatEpisodeTasks.projectId, projectId), eq(chatEpisodeTasks.messageId, messageId),
    )).orderBy(sql`rowid`).all().map((row) => this.view(parseJson<StoredTask>(row.taskJson, {} as StoredTask)));
  }

  recoveryContext(projectId: string, messageId: string) {
    return this.database.orm.select().from(chatEpisodeTasks).where(and(
      eq(chatEpisodeTasks.projectId, projectId), eq(chatEpisodeTasks.messageId, messageId),
    )).orderBy(sql`rowid`).all().map((row) => {
      const task = this.view(parseJson<StoredTask>(row.taskJson, {} as StoredTask));
      return { kind: task.kind, status: task.status, episodeId: task.episodeId, title: task.title, direction: task.direction,
        request: parseJson<unknown>(row.requestJson, null), error: task.error, blocked: task.blocked,
        editStatus: task.editorMessage?.edit?.status ?? null };
    });
  }

  async call(projectId: string, messageId: string, name: string, argumentsJson: string, signal?: AbortSignal, onEvent?: Emit) {
    let task: StoredTask | undefined;
    try {
      signal?.throwIfAborted();
      const message = this.database.orm.select().from(chatMessages).where(and(
        eq(chatMessages.id, messageId), eq(chatMessages.projectId, projectId), eq(chatMessages.role, 'assistant'),
      )).get();
      if (!message) throw new NotFoundException('회차 작업을 연결할 대화를 찾을 수 없습니다.');
      const validator = name === 'plan_episode' ? planInput : name === 'write_episode' ? writeInput : name === 'edit_episode' ? editInput : undefined;
      if (!validator) throw new BadRequestException('알 수 없는 회차 도구입니다.');
      const raw: unknown = JSON.parse(argumentsJson);
      const parsed = validator.safeParse(raw);
      if (!parsed.success) throw new BadRequestException('회차 도구의 인자를 확인해 주세요. 제목과 디렉션, 대상 회차 ID와 revision은 실제 값이어야 합니다.');
      const requestJson = stringifyJson(parsed.data);
      const kind = name === 'plan_episode' ? 'DIRECTION' : name === 'write_episode' ? 'WRITE' : 'EDIT';
      const existing = this.database.orm.select().from(chatEpisodeTasks).where(and(
        eq(chatEpisodeTasks.messageId, messageId), eq(chatEpisodeTasks.kind, kind),
      )).get();
      if (existing) {
        if (existing.requestJson !== requestJson) throw new ConflictException('이 메시지의 회차 작업은 이미 시작되었습니다. 변경한 지시는 다음 메시지로 요청해 주세요.');
        const saved = parseJson<StoredTask>(existing.taskJson, {} as StoredTask);
        if (existing.status === 'COMPLETE') {
          const replay = this.view(saved);
          onEvent?.({ type: 'episode_task', task: replay });
          return replay;
        }
        if (existing.status === 'PENDING') throw new ConflictException('회차 작업이 진행 중입니다.');
        task = { ...saved, status: 'PENDING', error: null };
      } else {
        if (name === 'edit_episode') {
          const input = editInput.parse(raw);
          const episode = this.episodes.get(projectId, input.episodeId);
          if (episode.revision !== input.expectedRevision) throw new ConflictException('원고가 변경되었습니다. 최신 회차를 다시 읽어 주세요.');
        }
        task = { id: id(), projectId, messageId, kind, status: 'PENDING', episodeId: null,
          title: kind === 'DIRECTION' ? '회차 구상' : kind === 'WRITE' ? '새 회차 작성' : '회차 편집',
          direction: null, content: '', error: null, editorMessage: null, issues: [], blocked: false };
        this.database.orm.insert(chatEpisodeTasks).values({
          id: task.id, projectId, messageId, kind, requestJson, status: task.status, taskJson: stringifyJson(task),
        }).run();
      }
      let lastPublished = 0;
      const publish = (force = false) => {
        if (!force && Date.now() - lastPublished < 200) return;
        lastPublished = Date.now();
        this.persist(task!);
        onEvent?.({ type: 'episode_task', task: this.view(task!) });
      };
      publish(true);
      if (name === 'plan_episode') {
        const input = planInput.parse(raw);
        const result = input.title !== null && input.direction !== null
          ? await this.episodes.refine(projectId, { title: input.title, direction: input.direction, instruction: input.instruction }, signal)
          : await this.episodes.propose(projectId, { hint: input.instruction }, signal);
        signal?.throwIfAborted();
        task = { ...task, title: result.title, direction: result.direction, content: result.conflicts.join('\n'), status: 'COMPLETE' };
      } else if (name === 'write_episode') {
        const input = writeInput.parse(raw);
        const episode = task.episodeId ? this.episodes.get(projectId, task.episodeId)
          : await this.episodes.create(projectId, { title: input.title, direction: input.direction, incomplete: true }, `chat-episode-${task.id}`);
        task = { ...task, episodeId: episode.id, title: episode.title, direction: episode.direction,
          baseRevision: task.baseRevision ?? episode.revision };
        if (episode.content.trim() || task.content.trim() || episode.revision !== task.baseRevision) throw new ConflictException('작성 중 원고가 변경되었거나 남은 본문이 있습니다. 에디터에서 확인하거나 편집을 요청해 주세요.');
        task = { ...task, content: '', issues: [], blocked: false };
        publish(true);
        signal?.throwIfAborted();
        let done: Extract<StreamEvent, { type: 'done' }> | undefined;
        await this.episodes.generate(projectId, {
          episodeId: episode.id, expectedRevision: episode.revision, title: input.title, direction: input.direction,
          ...(input.targetChars === null ? {} : { targetChars: input.targetChars }),
        }, (event) => {
          signal?.throwIfAborted();
          if (event.type === 'stage') task = { ...task!, stage: event.stage };
          if (event.type === 'delta') task = { ...task!, content: task!.content + event.text };
          if (event.type === 'reset') task = { ...task!, content: '' };
          if (event.type === 'done') { done = event; task = { ...task!, content: event.content, issues: event.issues, blocked: event.blocked }; }
          if (event.type === 'error') throw new Error(event.message);
          publish(event.type !== 'delta');
        }, signal);
        signal?.throwIfAborted();
        if (!done?.content.trim()) throw new Error('AI가 본문 작성을 완료하지 못했습니다.');
        if (done.baseRevision !== undefined && done.baseRevision !== episode.revision) throw new ConflictException('생성 기준 원고가 변경되었습니다.');
        this.database.connection.transaction(() => {
          this.episodes.updateSavedDraft(projectId, episode.id, {
            expectedRevision: episode.revision, content: done!.content, forceNeedsReview: done!.blocked,
          });
          task = { ...task!, status: 'COMPLETE' };
          this.persist(task);
        }).immediate();
      } else {
        const input = editInput.parse(raw);
        const episode = this.episodes.get(projectId, input.episodeId);
        task = { ...task, episodeId: episode.id, title: episode.title, direction: episode.direction, content: '' };
        publish(true);
        const history = await this.editor.send(projectId, episode.id, {
          content: input.instruction, clientMessageId: `chat-edit-${task.id}`, expectedRevision: input.expectedRevision,
          selection: { start: episode.content.length, end: episode.content.length, text: '' },
        }, signal, (event) => {
          // Child text belongs to its task card, never to the parent chat reply.
          if (event.type === 'delta') task = { ...task!, content: task!.content + event.text };
          if (event.type === 'reset') task = { ...task!, content: '' };
          publish(event.type !== 'delta');
        });
        signal?.throwIfAborted();
        const editorMessage = history.messages.find((item) => item.role === 'assistant' && item.clientMessageId === `chat-edit-${task!.id}`);
        if (editorMessage?.status !== 'COMPLETE' || !editorMessage.edit) throw new Error('편집 AI가 수정안을 완료하지 못했습니다.');
        task = { ...task, content: editorMessage.content, editorMessage, status: 'COMPLETE' };
      }
      publish(true);
      return this.view(task);
    } catch (error) {
      if (task) {
        // Match the editor: retain an interrupted draft as NEEDS_REVIEW, without
        // overwriting a manuscript that another writer has changed meanwhile.
        this.retainInterruptedDraft(task);
        task = { ...task, status: 'FAILED', blocked: task.blocked || (task.kind === 'WRITE' && Boolean(task.content.trim())), error: signal?.aborted ? '회차 작업이 중단되었습니다.' : error instanceof Error ? error.message : '회차 작업에 실패했습니다.' };
        this.persist(task);
        if (!signal?.aborted) onEvent?.({ type: 'episode_task', task: this.view(task) });
      }
      if (signal?.aborted) throw error;
      return { error: error instanceof ConflictException ? 'CONFLICT' : error instanceof NotFoundException ? 'NOT_FOUND' : 'EPISODE_TASK_FAILED',
        message: error instanceof Error ? error.message : '회차 작업에 실패했습니다.', ...(task ? { task: this.view(task) } : {}) };
    }
  }

  private retainInterruptedDraft(task: StoredTask) {
    if (task.kind !== 'WRITE' || !task.episodeId || !task.content.trim()) return;
    try {
      this.episodes.updateSavedDraft(task.projectId, task.episodeId, {
        expectedRevision: task.baseRevision, content: task.content, forceNeedsReview: true,
      });
    } catch { /* The task card retains the generated text if the episode changed. */ }
  }

  private persist(task: StoredTask) {
    this.database.orm.update(chatEpisodeTasks).set({ status: task.status, taskJson: stringifyJson(task) })
      .where(eq(chatEpisodeTasks.id, task.id)).run();
  }

  private view(task: StoredTask): ChatEpisodeTask {
    const { baseRevision: _, ...view } = task;
    if (view.editorMessage && view.episodeId) {
      try {
        const current = this.editor.history(view.projectId, view.episodeId).messages.find((item) => item.id === view.editorMessage!.id);
        if (current) return { ...view, editorMessage: current };
      } catch (error) {
        if (!(error instanceof NotFoundException)) throw error;
        return { ...view, editorMessage: null, error: '대상 회차가 삭제되었습니다.' };
      }
    }
    return view;
  }
}
