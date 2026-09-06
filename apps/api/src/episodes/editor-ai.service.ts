import { BadGatewayException, BadRequestException, ConflictException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import type { EditorAiEdit, EditorAiHistory, EditorAiInput, EditorAiMessage } from '@paranovel/contracts';
import { AiRunnerService } from '../ai/ai-runner.service';
import type { ChatMessage } from '../ai/ai.types';
import { DatabaseService } from '../database/database.service';
import { editorAiMessages } from '../database/schema';
import { MemoryService } from '../memory/memory.service';
import { serializeError } from '../shared/error-log';
import { id, now, parseJson, stringifyJson } from '../shared/utils';
import { EpisodesService } from './episodes.service';
import {
  editorAiInput, editorReplySchema, editorReplyValidator, editorTool, editToolInput,
  readManuscriptInput, readManuscriptTool, replaceTextInput, replaceTextTool,
} from './editor-ai.schemas';

const FAILED_REPLY = '편집 AI가 답변을 완료하지 못했습니다. 다시 시도해 주세요.';
type MessageRow = typeof editorAiMessages.$inferSelect;

function splitsCharacter(content: string, offset: number) {
  return /[\uD800-\uDBFF]/.test(content[offset - 1] ?? '') && /[\uDC00-\uDFFF]/.test(content[offset] ?? '');
}

@Injectable()
export class EditorAiService implements OnModuleInit {
  private readonly logger = new Logger(EditorAiService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly episodes: EpisodesService,
    private readonly memory: MemoryService,
    private readonly ai: AiRunnerService,
  ) {}

  onModuleInit() {
    this.database.orm.update(editorAiMessages).set({ status: 'FAILED', error: FAILED_REPLY })
      .where(eq(editorAiMessages.status, 'PENDING')).run();
  }

  history(projectId: string, episodeId: string): EditorAiHistory {
    this.episodes.get(projectId, episodeId);
    return { messages: this.rows(projectId, episodeId).map((row) => this.view(row)) };
  }

  async send(projectId: string, episodeId: string, body: unknown, signal?: AbortSignal): Promise<EditorAiHistory> {
    const parsed = editorAiInput.safeParse(body);
    if (!parsed.success) throw new BadRequestException('메시지와 원고의 선택 범위를 확인해 주세요.');
    const input = parsed.data;
    const turn = this.database.connection.transaction(() => {
      const episode = this.episodes.get(projectId, episodeId);
      const rows = this.rows(projectId, episodeId);
      const user = rows.find((row) => row.clientMessageId === input.clientMessageId && row.role === 'user');
      const assistant = rows.find((row) => row.clientMessageId === input.clientMessageId && row.role === 'assistant');
      if (user && user.requestJson !== stringifyJson(input)) throw new ConflictException('같은 메시지 ID에 다른 요청을 사용할 수 없습니다.');
      if (assistant?.status === 'COMPLETE') return { replay: true as const, assistantId: assistant.id, episode };
      if (rows.some((row) => row.status === 'PENDING')) throw new ConflictException('이 회차의 편집 AI가 답변 중입니다.');
      this.assertRevision(episode.revision, input.expectedRevision);
      this.assertSelection(episode.content, input.selection);
      const assistantId = assistant?.id ?? id();
      if (assistant) {
        this.database.orm.update(editorAiMessages).set({ status: 'PENDING', error: null, runId: null, editJson: null, content: '' })
          .where(eq(editorAiMessages.id, assistant.id)).run();
      } else {
        const common = { projectId, episodeId, clientMessageId: input.clientMessageId, createdAt: now() };
        this.database.orm.insert(editorAiMessages).values([
          { ...common, id: id(), role: 'user', content: input.content, status: 'COMPLETE', requestJson: stringifyJson(input) },
          { ...common, id: assistantId, role: 'assistant', content: '', status: 'PENDING' },
        ]).run();
      }
      return { replay: false as const, assistantId, episode };
    }).immediate();
    if (turn.replay) return this.history(projectId, episodeId);

    try {
      const memory = await this.memory.assemble(projectId, `${input.content}\n${input.selection.text}`, episodeId);
      signal?.throwIfAborted();
      const { start, end } = input.selection;
      const staged: { edit: EditorAiEdit | null } = { edit: null };
      const hasSelection = end > start;
      const tool = editorTool(hasSelection);
      const readTools = hasSelection ? [tool] : [tool, replaceTextTool, readManuscriptTool];
      const result = await this.ai.completeChat({
        task: 'episode_editor', promptId: 'episode-editor', projectId, episodeId, modelRole: 'WRITING',
        signal, maxTokens: 12_000, toolMaxTokens: 16_000,
        variables: {
          project_context: memory.projectContext, canon: memory.canon, current_arc: memory.currentArc,
          current_scene: memory.currentScene, recent_summaries: memory.recentSummaries,
          open_foreshadowing: memory.openForeshadowing, retrieved_memories: memory.retrievedMemories,
          improvements: memory.improvements,
          episode_context: {
            number: turn.episode.number, title: turn.episode.title, direction: turn.episode.direction,
            revision: turn.episode.revision, totalCharacters: turn.episode.content.length,
            editingMode: hasSelection ? 'SELECTION' : 'AUTO',
            textBefore: turn.episode.content.slice(Math.max(0, start - 30_000), start),
            selection: input.selection,
            textAfter: turn.episode.content.slice(end, end + 30_000),
            omittedBefore: Math.max(0, start - 30_000), omittedAfter: Math.max(0, turn.episode.content.length - end - 30_000),
          },
        },
        history: this.modelHistory(projectId, episodeId, input.clientMessageId),
        schema: { name: 'episode_editor_reply', value: editorReplySchema }, validator: editorReplyValidator,
        readTools,
        readTool: async (name, argumentsJson) => {
          signal?.throwIfAborted();
          if (!readTools.some((item) => item.function.name === name)) return { error: '현재 요청에 제공된 편집 도구만 사용할 수 있습니다.' };
          let args: unknown;
          try { args = JSON.parse(argumentsJson); } catch { return { error: '도구 인자는 올바른 JSON이어야 합니다.' }; }
          const manuscript = turn.episode.content;
          if (name === readManuscriptTool.function.name) {
            const range = readManuscriptInput.safeParse(args);
            if (!range.success || range.data.start > manuscript.length) return { error: '원고 안의 start와 1~20,000 사이의 length를 지정해 주세요.' };
            let from = range.data.start;
            let to = Math.min(manuscript.length, from + range.data.length);
            if (splitsCharacter(manuscript, from)) from -= 1;
            if (splitsCharacter(manuscript, to)) to += 1;
            return { start: from, end: to, text: manuscript.slice(from, to), totalCharacters: manuscript.length };
          }
          if (staged.edit) return { error: '수정안은 이미 준비되었습니다. 추가 수정은 다음 대화에서 요청받으세요.' };
          let target = input.selection;
          let edit: { title: string; replacement: string };
          if (name === replaceTextTool.function.name) {
            const parsedEdit = replaceTextInput.safeParse(args);
            if (!parsedEdit.success) return { error: 'title, original, replacement를 확인해 주세요. original에는 수정할 원문이 필요합니다.' };
            const { original, title, replacement } = parsedEdit.data;
            const from = manuscript.indexOf(original);
            if (from < 0) return { error: 'original이 현재 원고와 일치하지 않습니다. 원고를 읽고 공백과 줄바꿈까지 그대로 복사해 주세요.' };
            if (manuscript.indexOf(original, from + 1) >= 0) return { error: '같은 원문이 여러 곳에 있습니다. 수정할 위치가 하나로 정해지도록 앞뒤 문맥을 original에 포함해 주세요.' };
            target = { start: from, end: from + original.length, text: original };
            if (splitsCharacter(manuscript, target.start) || splitsCharacter(manuscript, target.end)) return { error: '문자 중간을 나눌 수 없습니다. 이모지 등은 온전한 문자로 포함해 주세요.' };
            edit = { title, replacement };
          } else {
            const parsedEdit = editToolInput.safeParse(args);
            if (!parsedEdit.success) return { error: 'title과 replacement를 확인해 주세요.' };
            edit = parsedEdit.data;
          }
          if (edit.replacement === target.text) return { error: '수정할 새 본문을 작성해 주세요.' };
          if (manuscript.length - (target.end - target.start) + edit.replacement.length > 1_000_000) {
            return { error: '원고는 1,000,000자 이하여야 합니다.' };
          }
          staged.edit = {
            ...edit, start: target.start, end: target.end, original: target.text,
            baseRevision: turn.episode.revision, status: 'PENDING',
          };
          return { status: 'PREVIEW_READY', title: edit.title, start: target.start, end: target.end,
            message: '전후 비교 카드에 표시할 수정안을 준비했습니다. 사용자가 수락하고 적용해야 원고에 반영됩니다.' };
        },
      }, (runId) => {
        this.database.orm.update(editorAiMessages).set({ runId }).where(eq(editorAiMessages.id, turn.assistantId)).run();
      });
      signal?.throwIfAborted();
      this.episodes.get(projectId, episodeId);
      this.database.orm.update(editorAiMessages).set({
        content: result.value.reply, status: 'COMPLETE', error: null, runId: result.runId,
        editJson: staged.edit ? stringifyJson(staged.edit) : null,
      }).where(eq(editorAiMessages.id, turn.assistantId)).run();
      return this.history(projectId, episodeId);
    } catch (error) {
      this.logger.error({ event: 'editor_ai_failed', projectId, episodeId, messageId: turn.assistantId, error: serializeError(error) });
      this.database.orm.update(editorAiMessages).set({ status: 'FAILED', error: FAILED_REPLY })
        .where(eq(editorAiMessages.id, turn.assistantId)).run();
      if (error instanceof NotFoundException) throw error;
      throw new BadGatewayException(FAILED_REPLY, { cause: error });
    }
  }

  apply(projectId: string, episodeId: string, messageId: string) {
    return this.database.connection.transaction(() => {
      const current = this.episodes.get(projectId, episodeId);
      const row = this.database.orm.select().from(editorAiMessages).where(and(
        eq(editorAiMessages.id, messageId), eq(editorAiMessages.projectId, projectId), eq(editorAiMessages.episodeId, episodeId),
      )).get();
      if (!row || row.role !== 'assistant' || row.status !== 'COMPLETE' || !row.editJson) {
        throw new NotFoundException('적용할 수정안을 찾을 수 없습니다.');
      }
      if (row.appliedAt) return { episode: current, message: this.view(row) };
      const edit = parseJson<EditorAiEdit | null>(row.editJson, null);
      if (!edit) throw new BadRequestException('수정안을 읽을 수 없습니다. 편집 AI에 다시 요청해 주세요.');
      this.assertRevision(current.revision, edit.baseRevision);
      this.assertSelection(current.content, { start: edit.start, end: edit.end, text: edit.original });
      const episode = this.episodes.updateSavedDraft(projectId, episodeId, {
        expectedRevision: edit.baseRevision,
        content: current.content.slice(0, edit.start) + edit.replacement + current.content.slice(edit.end),
      });
      const applied = { ...row, appliedAt: now() };
      this.database.orm.update(editorAiMessages).set({ appliedAt: applied.appliedAt }).where(eq(editorAiMessages.id, row.id)).run();
      return { episode, message: this.view(applied) };
    }).immediate();
  }

  private assertRevision(actual: number, expected: number) {
    if (actual !== expected) throw new ConflictException('원고가 변경되었습니다. 현재 원고를 기준으로 편집 AI에 다시 요청해 주세요.');
  }

  private assertSelection(content: string, selection: EditorAiInput['selection']) {
    const { start, end, text } = selection;
    if (end < start || end > content.length || content.slice(start, end) !== text || splitsCharacter(content, start) || splitsCharacter(content, end)) {
      throw new BadRequestException('선택한 문장이 원고와 일치하지 않습니다. 다시 선택해 주세요.');
    }
  }

  private rows(projectId: string, episodeId: string) {
    return this.database.orm.select().from(editorAiMessages)
      .where(and(eq(editorAiMessages.projectId, projectId), eq(editorAiMessages.episodeId, episodeId))).orderBy(sql`rowid`).all();
  }

  private view(row: MessageRow): EditorAiMessage {
    const edit = parseJson<EditorAiEdit | null>(row.editJson, null);
    return {
      id: row.id, projectId: row.projectId, episodeId: row.episodeId, clientMessageId: row.clientMessageId,
      role: row.role as EditorAiMessage['role'], content: row.content, status: row.status as EditorAiMessage['status'],
      request: parseJson<EditorAiInput | null>(row.requestJson, null),
      edit: edit ? { ...edit, status: row.appliedAt ? 'APPLIED' : 'PENDING' } : null,
      error: row.error, createdAt: row.createdAt,
    };
  }

  private modelHistory(projectId: string, episodeId: string, currentId: string): ChatMessage[] {
    const rows = this.rows(projectId, episodeId);
    const includedTurns = new Set(rows.filter((row) => row.role === 'assistant' && row.status === 'COMPLETE').map((row) => row.clientMessageId));
    const messages = rows.filter((row) => row.clientMessageId !== currentId && includedTurns.has(row.clientMessageId) && row.status === 'COMPLETE').slice(-20);
    // Retrying an older failed turn still makes that request the latest model input.
    const currentUser = rows.find((row) => row.clientMessageId === currentId && row.role === 'user');
    if (currentUser) messages.push(currentUser);
    let remaining = 120_000;
    const history: ChatMessage[] = [];
    for (const row of messages.reverse()) {
      const message = this.view(row);
      const content = message.role === 'user'
        ? stringifyJson({ request: message.content, selection: message.request?.selection })
        : stringifyJson({ reply: message.content, edit: message.edit });
      if (content.length > remaining && history.length) break;
      remaining -= content.length;
      history.unshift({ role: message.role, content });
    }
    while (history[0]?.role === 'assistant') history.shift();
    return history;
  }
}
