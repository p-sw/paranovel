import { BadGatewayException, ConflictException, Logger, NotFoundException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { ArcEpisodeDirectionsService } from '../src/ai/arc-episode-directions.service';
import { AiRunnerService } from '../src/ai/ai-runner.service';
import { OpenRouterGateway } from '../src/ai/openrouter.gateway';
import type { CompletionRequest } from '../src/ai/ai.types';
import type { ChatHistory, ConversationStreamEvent } from '@paranovel/contracts';
import { ArcsService } from '../src/arcs/arcs.service';
import { CanonService } from '../src/canon/canon.service';
import { ChatReadToolsService } from '../src/chat/chat-read-tools.service';
import { ChatEpisodeToolsService } from '../src/chat/chat-episode-tools.service';
import { ChatService } from '../src/chat/chat.service';
import { chatOutputSchema, chatOutputValidator, type ChatOutput } from '../src/chat/chat.schemas';
import { generateImageTagsTool, ImageTagToolService } from '../src/chat/image-tag-tool.service';
import { DatabaseService } from '../src/database/database.service';
import { chatMessages, chatProposals, chatThreads, episodes } from '../src/database/schema';
import { EditorAiService } from '../src/episodes/editor-ai.service';
import { EpisodesService } from '../src/episodes/episodes.service';
import { ImprovementsService } from '../src/improvements/improvements.service';
import { MemoryService } from '../src/memory/memory.service';
import { ProjectsService } from '../src/projects/projects.service';
import { PromptRegistryService } from '../src/prompts/prompt-registry.service';

const canonFields = { category: 'CHARACTER', name: '하린', content: '기억을 읽는 기록관' };
const arcFields = {
  title: '기록관의 비밀', startEpisodeNumber: 1, endEpisodeNumber: 8,
  goal: '기록을 찾는다', conflict: '왕실의 추적',
  milestones: [{ episode: 8, type: 'GOAL' as const, description: '기록을 찾는다' }],
};
function proposal(kind: ChatOutput['proposals'][number]['kind'], operation: ChatOutput['proposals'][number]['operation'], changes: Record<string, unknown> = {}, targetId: string | null = null): ChatOutput['proposals'][number] {
  return { kind, operation, targetId, title: '검토할 변경', changesJson: JSON.stringify(changes) };
}

describe('project chat', () => {
  let database: DatabaseService;
  let projects: ProjectsService;
  let canon: CanonService;
  let arcs: ArcsService;
  let improvements: ImprovementsService;
  let memory: MemoryService;
  let reads: ChatReadToolsService;
  let episodeService: EpisodesService;
  let editor: EditorAiService;
  let episodeTools: ChatEpisodeToolsService;
  let chat: ChatService;
  let projectId: string;
  const completeChat = vi.fn();
  const completeJson = vi.fn();
  const streamText = vi.fn();
  const infoLog = vi.fn();
  const errorLog = vi.fn();
  const embeddings = vi.fn(async (texts: string[]) => texts.map(() => [0, 1, 0, 1]));

  beforeEach(() => {
    vi.stubEnv('DB_PATH', ':memory:');
    vi.stubEnv('OPENROUTER_EMBEDDING_DIMENSIONS', '4');
    infoLog.mockReset();
    errorLog.mockReset();
    vi.spyOn(Logger.prototype, 'log').mockImplementation(infoLog);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(errorLog);
    database = new DatabaseService();
    memory = new MemoryService(database, { embeddings } as never);
    projects = new ProjectsService(database);
    const ai = { completeChat, completeJson, streamText, chatModel: () => 'test-chat-model' } as unknown as AiRunnerService;
    const arcDirections = new ArcEpisodeDirectionsService(ai);
    canon = new CanonService(database, memory, ai);
    arcs = new ArcsService(database, memory, ai, arcDirections);
    improvements = new ImprovementsService(database, ai, memory);
    const imageTags = new ImageTagToolService(projects, canon, ai);
    reads = new ChatReadToolsService(database, projects, canon, arcs, improvements, memory, { isConfigured: () => false } as never, imageTags);
    episodeService = new EpisodesService(database, projects, memory, ai);
    editor = new EditorAiService(database, episodeService, memory, ai);
    episodeTools = new ChatEpisodeToolsService(database, episodeService, editor);
    chat = new ChatService(database, ai, arcDirections, projects, canon, arcs, improvements, memory, reads, episodeTools);
    projectId = projects.createInternal({ title: '기록의 문', logline: '기억을 읽는 기록관', genreTags: ['판타지'] }).id;
    completeChat.mockReset();
    completeJson.mockReset().mockImplementation(async (request) => {
      if (request.task !== 'arc_episode_directions') throw new Error(`Unexpected task: ${request.task}`);
      const arc = request.variables.arc_milestones;
      return { value: request.validator.parse({
        episodeDirections: Array.from(
          { length: arc.endEpisodeNumber - arc.startEpisodeNumber + 1 },
          (_, index) => ({
            episode: arc.startEpisodeNumber + index,
            title: `${arc.startEpisodeNumber + index}화`,
            direction: '기록의 단서를 따라 다음 사건으로 나아간다.',
          }),
        ),
      }) };
    });
    streamText.mockReset();
    embeddings.mockClear();
  });

  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); database.onApplicationShutdown(); });

  async function ask(proposals: ChatOutput['proposals'], clientMessageId = 'turn-1', content = '작품을 개선해 줘', threadId?: string) {
    completeChat.mockResolvedValueOnce({ runId: 'chat-run', value: { reply: '검토할 내용을 준비했습니다.', proposals } });
    return chat.send(projectId, { content, clientMessageId }, undefined, threadId);
  }

  it('plans and refines across chat turns, then delegates writing and review while preserving the draft separately', async () => {
    const firstPlan = { title: '닫힌 기록실', direction: '하린이 기록실의 비밀을 발견한다.', conflicts: [] };
    completeJson.mockResolvedValueOnce({ runId: 'plan-run', value: firstPlan });
    completeChat.mockImplementationOnce(async (input) => {
      expect(input.task).toBe('project_chat');
      expect(input.readTools.map((tool: { function: { name: string } }) => tool.function.name))
        .toEqual(expect.arrayContaining(['plan_episode', 'write_episode', 'edit_episode']));
      expect(input.parallelToolNames).not.toEqual(expect.arrayContaining(['plan_episode']));
      expect(input.parallelToolNames).not.toEqual(expect.arrayContaining(['write_episode']));
      expect(input.parallelToolNames).not.toEqual(expect.arrayContaining(['edit_episode']));
      const task = await input.readTool('plan_episode', JSON.stringify({ instruction: '기록실의 비밀을 찾는 회차를 구상해 줘', title: null, direction: null }));
      expect(task).toMatchObject({ kind: 'DIRECTION', status: 'COMPLETE', title: firstPlan.title, direction: firstPlan.direction, episodeId: null });
      return { runId: 'plan-chat', value: { reply: '기록실에서 비밀을 찾는 방향을 준비했어요.', proposals: [] } };
    });
    const planned = await chat.send(projectId, { content: '기록실의 비밀을 찾는 회차를 구상해 줘', clientMessageId: 'plan-episode' });
    expect(planned.messages[1]?.episodeTasks).toMatchObject([{ kind: 'DIRECTION', status: 'COMPLETE', title: firstPlan.title }]);
    expect(episodeService.list(projectId)).toHaveLength(0);
    expect(completeJson.mock.calls[0]?.[0]).toMatchObject({ task: 'episode_direction', promptId: 'episode-direction' });

    const refinedPlan = { title: '문 너머의 발소리', direction: '하린이 기록실에 숨고 문밖의 추격자를 피한다.', conflicts: [] };
    completeJson.mockResolvedValueOnce({ runId: 'refine-run', value: refinedPlan });
    completeChat.mockImplementationOnce(async (input) => {
      expect(JSON.stringify(input.history)).toContain(firstPlan.direction);
      const task = await input.readTool('plan_episode', JSON.stringify({ instruction: '비밀 발견보다 추격의 긴장감을 높여 줘', title: firstPlan.title, direction: firstPlan.direction }));
      expect(task).toMatchObject({ kind: 'DIRECTION', status: 'COMPLETE', title: refinedPlan.title, direction: refinedPlan.direction });
      return { runId: 'refine-chat', value: { reply: '추격자를 피하는 방향으로 바꿨어요.', proposals: [] } };
    });
    await chat.send(projectId, { content: '비밀 발견보다 추격의 긴장감을 높여 줘', clientMessageId: 'refine-episode' });
    expect(completeJson.mock.calls[1]?.[0]).toMatchObject({ task: 'episode_direction_refine', promptId: 'episode-direction-refine' });
    expect(episodeService.list(projectId)).toHaveLength(0);

    const draft = '하린은 기록실 문을 닫았다.\n문밖에서 발소리가 멎었다.';
    streamText.mockImplementationOnce(async (input, onDelta) => {
      expect(input).toMatchObject({ task: 'episode_draft', promptId: 'episode-draft', variables: { episode_title: refinedPlan.title, episode_direction: refinedPlan.direction } });
      onDelta('하린은 기록실 문을 닫았다.\n');
      onDelta('문밖에서 발소리가 멎었다.');
      return { runId: 'draft-run', result: { content: draft, toolCalls: [], usage: {}, model: 'test-writer' } };
    });
    completeJson.mockResolvedValueOnce({ runId: 'review-run', value: { issues: [] } });
    const events: ConversationStreamEvent<ChatHistory>[] = [];
    completeChat.mockImplementationOnce(async (input) => {
      expect(JSON.stringify(input.history)).toContain(refinedPlan.direction);
      const args = JSON.stringify({ title: refinedPlan.title, direction: refinedPlan.direction, targetChars: null });
      const task = await input.readTool('write_episode', args);
      expect(task).toMatchObject({ kind: 'WRITE', status: 'COMPLETE', title: refinedPlan.title, blocked: false });
      expect(task).not.toHaveProperty('content');
      expect(await input.readTool('write_episode', args)).toEqual(task);
      input.onEvent({ type: 'delta', text: '새 회차 초안을 저장했어요.' });
      return { runId: 'write-chat', value: { reply: '새 회차 초안을 저장했어요.', proposals: [] } };
    });
    const body = { content: '좋아. 그 방향대로 새 회차를 써 줘', clientMessageId: 'write-episode' };
    const written = await chat.send(projectId, body, undefined, undefined, (event) => events.push(event));
    const message = written.messages.at(-1)!;
    expect(message).toMatchObject({ status: 'COMPLETE', content: '새 회차 초안을 저장했어요.', proposals: [],
      episodeTasks: [{ kind: 'WRITE', status: 'COMPLETE', content: draft, title: refinedPlan.title }] });
    expect(episodeService.list(projectId)).toMatchObject([{ id: message.episodeTasks[0]!.episodeId, content: draft, status: 'DRAFT', revision: 2 }]);
    expect(streamText).toHaveBeenCalledOnce();
    expect(completeJson.mock.calls[2]?.[0]).toMatchObject({ task: 'continuity_review', promptId: 'continuity-review', variables: { candidate_text: draft } });
    expect(events.filter((event) => event.type === 'delta')).toEqual([{ type: 'delta', text: '새 회차 초안을 저장했어요.' }]);
    expect(events).toContainEqual({ type: 'episode_task', task: expect.objectContaining({ kind: 'WRITE', status: 'COMPLETE', content: draft }) });
    expect(chat.history(projectId)).toEqual(written);
    expect(await chat.send(projectId, body)).toEqual(written);
    expect(streamText).toHaveBeenCalledOnce();
    await ask([], 'discuss-written', '다음 회차의 도입은 어떻게 이어 갈까?');
    const history = JSON.stringify(completeChat.mock.calls.at(-1)![0].history);
    expect(history).toContain(message.episodeTasks[0]!.episodeId);
    expect(history).toContain(refinedPlan.title);
  });

  it('routes chat edits through Editor AI and exposes the same preview and application state on later turns', async () => {
    const original = '하린은 문을 바라보았다.\n복도는 조용했다.';
    const replacement = '하린은 문고리를 쥔 채 숨을 죽였다.';
    const episode = await episodeService.create(projectId, { title: '닫힌 문', direction: '추격자를 피한다.', content: original });
    const instruction = '첫 문장에서 하린의 긴장감을 높여 줘';
    const events: ConversationStreamEvent<ChatHistory>[] = [];
    completeChat.mockImplementationOnce(async (input) => {
      const read = await input.readTool('read_project_record', JSON.stringify({ kind: 'EPISODE', id: episode.id, episodeNumber: null, offset: 0 }));
      expect(read).toMatchObject({ id: episode.id, revision: 1, content: original });
      const args = JSON.stringify({ episodeId: episode.id, expectedRevision: 1, instruction });
      const task = await input.readTool('edit_episode', args);
      expect(task).toMatchObject({ kind: 'EDIT', status: 'COMPLETE', episodeId: episode.id, editStatus: 'PENDING' });
      expect(task).not.toHaveProperty('editorMessage');
      expect(await input.readTool('edit_episode', args)).toEqual(task);
      return { runId: 'parent-edit-chat', value: { reply: '첫 문장의 수정안을 준비했어요. 비교한 뒤 적용해 주세요.', proposals: [] } };
    }).mockImplementationOnce(async (input) => {
      expect(input).toMatchObject({ task: 'episode_editor', promptId: 'episode-editor', episodeId: episode.id, modelRole: 'WRITING',
        variables: { episode_context: { editingMode: 'AUTO' } } });
      expect(JSON.stringify(input.history)).toContain(instruction);
      expect(input.readTools.map((tool: { function: { name: string } }) => tool.function.name)).not.toContain('write_episode');
      expect(await input.readTool('replace_text', JSON.stringify({ title: '긴장감 높이기', original: '하린은 문을 바라보았다.', replacement })))
        .toHaveProperty('status', 'PREVIEW_READY');
      input.onEvent({ type: 'delta', text: '인물의 행동으로 긴장을 드러냈어요.' });
      return { runId: 'child-editor', value: { reply: '인물의 행동으로 긴장을 드러냈어요.' } };
    });
    const result = await chat.send(projectId, { content: '기존 1화의 첫 문장에서 긴장감을 높여 줘', clientMessageId: 'edit-episode' }, undefined, undefined, (event) => events.push(event));
    const task = result.messages[1]!.episodeTasks[0]!;
    expect(task.editorMessage).toMatchObject({ status: 'COMPLETE', edit: { original: '하린은 문을 바라보았다.', replacement, status: 'PENDING' } });
    expect(episodeService.get(projectId, episode.id)).toMatchObject({ content: original, revision: 1 });
    expect(editor.history(projectId, episode.id).messages.at(-1)?.id).toBe(task.editorMessage!.id);
    expect(events.filter((event) => event.type === 'delta')).toEqual([]);
    expect(events).toContainEqual({ type: 'episode_task', task: expect.objectContaining({ kind: 'EDIT', status: 'COMPLETE', content: '인물의 행동으로 긴장을 드러냈어요.' }) });
    expect(completeChat).toHaveBeenCalledTimes(2);
    const applied = editor.apply(projectId, episode.id, task.editorMessage!.id);
    expect(applied.episode).toMatchObject({ content: original.replace('하린은 문을 바라보았다.', replacement), revision: 2 });
    expect(chat.history(projectId).messages[1]!.episodeTasks[0]!.editorMessage?.edit?.status).toBe('APPLIED');
    await ask([], 'discuss-edited', '같은 부분을 더 짧게 다듬을까?');
    const modelHistory = JSON.stringify(completeChat.mock.calls.at(-1)![0].history);
    expect(modelHistory).toContain('APPLIED');
    expect(modelHistory).toContain(episode.id);
  });

  it('replays a completed child draft when a failed parent chat turn is retried', async () => {
    const draft = '하린은 기록실로 들어갔다.';
    streamText.mockImplementationOnce(async (_input, onDelta) => {
      onDelta(draft);
      return { runId: 'child-write', result: { content: draft, toolCalls: [], usage: {}, model: 'writer' } };
    });
    completeJson.mockResolvedValueOnce({ runId: 'review', value: { issues: [] } });
    const args = JSON.stringify({ title: '기록실', direction: '숨겨진 기록을 찾는다.', targetChars: null });
    completeChat.mockImplementationOnce(async (input) => {
      expect(await input.readTool('write_episode', args)).toMatchObject({ status: 'COMPLETE', kind: 'WRITE' });
      throw new Error('parent reply failed after saving the child result');
    });
    const body = { content: '기록실에 들어가는 새 회차를 써 줘', clientMessageId: 'retry-write' };
    await expect(chat.send(projectId, body)).rejects.toThrow(BadGatewayException);
    const failed = chat.history(projectId).messages[1]!;
    expect(failed).toMatchObject({ status: 'FAILED', episodeTasks: [{ status: 'COMPLETE', content: draft }] });
    completeChat.mockImplementationOnce(async (input) => {
      expect(input.history).toContainEqual(expect.objectContaining({ role: 'system', content: expect.stringContaining(failed.episodeTasks[0]!.episodeId!) }));
      expect(await input.readTool('write_episode', args)).toMatchObject({ id: failed.episodeTasks[0]!.id, status: 'COMPLETE' });
      return { runId: 'retried-parent', value: { reply: '저장된 초안을 확인해 주세요.', proposals: [] } };
    });
    const retried = await chat.send(projectId, body);
    expect(retried.messages).toHaveLength(2);
    expect(retried.messages[1]).toMatchObject({ id: failed.id, status: 'COMPLETE', episodeTasks: [{ id: failed.episodeTasks[0]!.id, status: 'COMPLETE' }] });
    expect(episodeService.list(projectId)).toHaveLength(1);
    expect(streamText).toHaveBeenCalledOnce();
  });

  it('streams a pending turn, keeps proposals unavailable until complete, and replays the saved answer', async () => {
    const events: ConversationStreamEvent<ChatHistory>[] = [];
    let finish!: () => void;
    const ready = new Promise<void>((resolve) => { finish = resolve; });
    completeChat.mockImplementationOnce(async (input) => {
      expect(input.parallelToolNames).toEqual(expect.arrayContaining(['read_project_record', 'search_project_memory']));
      expect(input.parallelToolNames).not.toContain('generate_image_tags');
      input.onEvent({ type: 'delta', text: '설정을 정리' });
      await ready;
      input.onEvent({ type: 'delta', text: '했습니다.' });
      return { runId: 'stream-run', value: { reply: '설정을 정리했습니다.', proposals: [proposal('CANON', 'CREATE', canonFields)] } };
    });
    const body = { clientMessageId: 'stream-turn', content: '설정을 만들어 줘' };
    const pending = chat.send(projectId, body, undefined, undefined, (event) => events.push(event));
    await vi.waitFor(() => expect(events.some((event) => event.type === 'delta')).toBe(true));
    const assistant = chat.history(projectId).messages.at(-1)!;
    expect(events[0]).toEqual({ type: 'start', messageId: assistant.id });
    expect(assistant).toMatchObject({ content: '', status: 'PENDING', proposals: [] });
    expect(database.orm.select().from(chatProposals).all()).toHaveLength(0);
    finish();
    const completed = await pending;
    expect(completed.messages.at(-1)).toMatchObject({ id: assistant.id, content: '설정을 정리했습니다.', status: 'COMPLETE', proposals: [expect.objectContaining({ status: 'PENDING' })] });
    const replay: ConversationStreamEvent<ChatHistory>[] = [];
    expect(await chat.send(projectId, body, undefined, undefined, (event) => replay.push(event))).toEqual(completed);
    expect(replay).toEqual([{ type: 'start', messageId: assistant.id }]);
    expect(completeChat).toHaveBeenCalledTimes(1);
  });

  it('marks a streamed turn failed after cancellation without saving partial proposals', async () => {
    const controller = new AbortController();
    const emit = vi.fn();
    completeChat.mockImplementationOnce(async (input) => {
      input.onEvent({ type: 'delta', text: '일부 답변' });
      controller.abort();
      return { runId: 'cancelled-run', value: { reply: '완성된 답변', proposals: [proposal('CANON', 'CREATE', canonFields)] } };
    });
    await expect(chat.send(projectId, { clientMessageId: 'cancelled-stream', content: '설정을 만들어 줘' }, controller.signal, undefined, emit)).rejects.toBeInstanceOf(BadGatewayException);
    expect(emit).toHaveBeenCalledWith({ type: 'delta', text: '일부 답변' });
    expect(chat.history(projectId).messages.at(-1)).toMatchObject({ content: '', status: 'FAILED', proposals: [] });
    expect(database.orm.select().from(chatProposals).all()).toHaveLength(0);
  });

  it('creates empty rooms idempotently without creating rooms when reading empty history', () => {
    expect(chat.history(projectId)).toEqual({ thread: null, messages: [] });
    expect(chat.threads(projectId)).toEqual([]);
    const thread = chat.createThread(projectId, { clientThreadId: 'new-room' });
    expect(chat.createThread(projectId, { clientThreadId: 'new-room' })).toEqual(thread);
    expect(chat.threads(projectId)).toEqual([{ ...thread, preview: '', messageCount: 0, status: null }]);
    expect(chat.history(projectId, thread.id)).toEqual({ thread, messages: [] });
    expect(completeChat).not.toHaveBeenCalled();
  });

  it('isolates conversation context and proposals by room and sorts history by most recent activity', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-06T00:00:00.000Z'));
    const first = await ask([proposal('CANON', 'CREATE', canonFields)], 'first-turn', '  첫 번째\n 설정  ');
    expect(first.thread?.title).toBe('첫 번째 설정');
    const firstId = first.thread!.id;
    vi.setSystemTime(new Date('2026-09-06T01:00:00.000Z'));
    const second = chat.createThread(projectId);
    expect(chat.history(projectId, second.id).messages).toEqual([]);
    expect(chat.history(projectId, firstId)).toEqual(first);
    expect(chat.history(projectId).thread?.id).toBe(second.id);
    const secondHistory = await ask([], 'second-turn', '다음 아크를 계획해 줘', second.id);
    expect(completeChat.mock.calls.at(-1)![0].history).toEqual([{ role: 'user', content: '다음 아크를 계획해 줘' }]);
    expect(secondHistory.messages).toHaveLength(2);
    expect(secondHistory.messages[1]!.proposals).toEqual([]);
    expect(chat.threads(projectId).map((thread) => thread.id)).toEqual([second.id, firstId]);
    expect(chat.threads(projectId)[0]).toMatchObject({ title: '다음 아크를 계획해 줘', messageCount: 2, preview: '검토할 내용을 준비했습니다.', status: 'COMPLETE' });

    await chat.apply(projectId, first.messages[1]!.proposals[0]!.id);
    vi.setSystemTime(new Date('2026-09-06T02:00:00.000Z'));
    await ask([], 'first-followup', '이 설정을 이어서 정리해 줘', firstId);
    const context = completeChat.mock.calls.at(-1)![0].history;
    expect(context).toHaveLength(3);
    expect(context[1].content).toContain('APPLIED');
    expect(JSON.stringify(context)).not.toContain('다음 아크를 계획해 줘');
    expect(chat.threads(projectId).map((thread) => thread.id)).toEqual([firstId, second.id]);
    expect(chat.history(projectId, firstId).thread?.title).toBe('첫 번째 설정');
    expect(chat.history(projectId, second.id)).toEqual(secondHistory);
  });

  it('rejects foreign and missing rooms and prevents replaying a turn into another room', async () => {
    const first = await ask([]);
    const second = chat.createThread(projectId);
    const other = projects.createInternal({ title: '다른 작품', logline: '다른 세계', genreTags: ['SF'] });
    const foreign = chat.createThread(other.id);
    expect(chat.threads(projectId).map((thread) => thread.id)).not.toContain(foreign.id);
    expect(chat.threads(other.id).map((thread) => thread.id)).toEqual([foreign.id]);
    for (const threadId of [foreign.id, 'missing-room']) {
      expect(() => chat.history(projectId, threadId)).toThrow(NotFoundException);
      await expect(chat.send(projectId, { content: 'question', clientMessageId: 'foreign-turn' }, undefined, threadId)).rejects.toBeInstanceOf(NotFoundException);
    }
    expect(() => chat.createThread(other.id, { clientThreadId: second.id })).toThrow(ConflictException);
    await expect(chat.send(projectId, { content: '작품을 개선해 줘', clientMessageId: 'turn-1' }, undefined, second.id)).rejects.toBeInstanceOf(ConflictException);
    expect(chat.history(projectId, first.thread!.id)).toEqual(first);
    expect(chat.history(projectId, second.id).messages).toEqual([]);
    expect(completeChat).toHaveBeenCalledTimes(1);
  });

  it('keeps a pending reply in its original room while allowing a new room to send', async () => {
    const first = chat.createThread(projectId);
    let finish!: (value: unknown) => void;
    completeChat.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const pending = chat.send(projectId, { content: '이전 방 질문', clientMessageId: 'pending-turn' }, undefined, first.id);
    await vi.waitFor(() => expect(finish).toBeDefined());
    expect(chat.threads(projectId)[0]).toMatchObject({ id: first.id, status: 'PENDING' });
    await expect(chat.send(projectId, { content: '중복 질문', clientMessageId: 'duplicate' }, undefined, first.id)).rejects.toBeInstanceOf(ConflictException);
    const second = chat.createThread(projectId);
    const secondHistory = await ask([], 'new-turn', '새 방 질문', second.id);
    finish({ runId: 'old-run', value: { reply: '이전 방 답변', proposals: [] } });
    const result = await pending;
    expect(result.thread?.id).toBe(first.id);
    expect(result.messages.map((message) => message.content)).toEqual(['이전 방 질문', '이전 방 답변']);
    expect(chat.history(projectId, second.id)).toEqual(secondHistory);
  });

  it('retries and replays an older failed room without changing the newer room', async () => {
    const first = chat.createThread(projectId);
    completeChat.mockRejectedValueOnce(new Error('temporary failure'));
    const turn = { content: '첫 방 질문', clientMessageId: 'failed-turn' };
    await expect(chat.send(projectId, turn, undefined, first.id)).rejects.toBeInstanceOf(BadGatewayException);
    expect(chat.threads(projectId)[0]).toMatchObject({ status: 'FAILED' });
    const second = chat.createThread(projectId);
    const newer = await ask([], 'new-turn', '새 방 질문', second.id);
    completeChat.mockResolvedValueOnce({ runId: 'retried', value: { reply: '첫 방 답변', proposals: [] } });
    const retried = await chat.send(projectId, turn);
    expect(retried.thread?.id).toBe(first.id);
    expect(retried.messages).toHaveLength(2);
    expect(completeChat.mock.calls.at(-1)![0].history).toEqual([{ role: 'user', content: turn.content }]);
    expect(await chat.send(projectId, turn, undefined, first.id)).toEqual(retried);
    expect(chat.history(projectId, second.id)).toEqual(newer);
    expect(completeChat).toHaveBeenCalledTimes(3);
  });

  it('keeps questions and proposals in persistent project history without applying changes', async () => {
    const history = await ask([proposal('CANON', 'CREATE', canonFields)]);
    expect(history.messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(history.messages[1]!.proposals[0]).toMatchObject({ status: 'PENDING', before: null, after: canonFields });
    expect(canon.list(projectId)).toEqual([]);
    expect(chat.history(projectId)).toEqual(history);
    expect(completeChat).toHaveBeenCalledWith(expect.objectContaining({ modelRole: 'CHAT', projectId }), expect.any(Function));
    expect(completeChat.mock.calls[0]![0].history.at(-1)).toEqual({ role: 'user', content: '작품을 개선해 줘' });
  });

  it('creates and updates distinct same-name appearance canon through approved chat proposals', async () => {
    const character = await canon.create(projectId, canonFields);
    const visualFields = { category: 'CHARACTER_APPEARANCE', name: canonFields.name, content: '은발, 보라색 눈, 남색 코트, 초승달 귀걸이' };
    const created = await ask([proposal('CANON', 'CREATE', visualFields)]);
    expect(canon.list(projectId)).toHaveLength(1);
    const applied = await chat.apply(projectId, created.messages[1]!.proposals[0]!.id);
    const appearanceId = applied.proposal.targetId!;
    expect(canon.get(projectId, appearanceId)).toMatchObject(visualFields);
    expect(reads.snapshot(projectId).catalog.filter((record) => record.kind === 'CANON')).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: character.id, name: canonFields.name, category: 'CHARACTER' }),
      expect.objectContaining({ id: appearanceId, name: canonFields.name, category: 'CHARACTER_APPEARANCE' }),
    ]));
    const updated = await ask([proposal('CANON', 'UPDATE', { content: `${visualFields.content}, 검은 장화` }, appearanceId)], 'turn-2');
    await chat.apply(projectId, updated.messages.at(-1)!.proposals[0]!.id);
    expect(canon.get(projectId, appearanceId).content).toContain('검은 장화');
    expect(canon.get(projectId, character.id).content).toBe(canonFields.content);
  });

  it('delegates image-tag requests to the nested tool once and persists its exact tags without proposals', async () => {
    const appearance = canon.persistCreate(projectId, {
      category: 'CHARACTER_APPEARANCE', name: '하린', content: '긴 은발, 보라색 눈, 남색 코트', status: 'ACTIVE',
    });
    const location = canon.persistCreate(projectId, {
      category: 'LOCATION', name: '유리 온실', content: '높은 유리 천장과 흰 대리석 바닥', status: 'ACCEPTED',
    });
    const canonBefore = canon.list(projectId);
    completeJson.mockResolvedValueOnce({ runId: 'image-tag-run', value: {
      tags: ['1girl', 'long_silver_hair', 'purple_eyes', 'glasshouse', 'rain'],
    } });
    let firstToolResult: unknown;
    let repeatedToolResult: unknown;
    completeChat.mockImplementationOnce(async (request) => {
      expect(request.readTools.map((tool: { function: { name: string } }) => tool.function.name)).toContain('generate_image_tags');
      const args = JSON.stringify({
        characterAppearanceIds: [appearance.id],
        locationId: location.id,
        additionalDescription: '비 오는 밤에 뒤돌아보는 장면',
      });
      firstToolResult = await request.readTool('generate_image_tags', args);
      repeatedToolResult = await request.readTool('generate_image_tags', args);
      return {
        runId: 'project-chat-run',
        value: { reply: '메인 모델이 바꾼 답변', proposals: [proposal('CANON', 'CREATE', canonFields)] },
      };
    });

    const history = await chat.send(projectId, {
      content: '하린이 유리 온실에서 비를 맞는 모습의 단부루 태그를 만들어 줘',
      clientMessageId: 'image-tags',
    });

    expect(firstToolResult).toMatchObject({
      tags: ['1girl', 'long_silver_hair', 'purple_eyes', 'glasshouse', 'rain'],
      tagString: '1girl, long_silver_hair, purple_eyes, glasshouse, rain',
      sourceCanonIds: [appearance.id, location.id],
    });
    expect(repeatedToolResult).toEqual(firstToolResult);
    expect(completeJson).toHaveBeenCalledTimes(1);
    expect(history.messages.at(-1)).toMatchObject({
      role: 'assistant',
      content: '1girl, long_silver_hair, purple_eyes, glasshouse, rain',
      proposals: [],
      status: 'COMPLETE',
    });
    expect(database.orm.select().from(chatProposals).all()).toEqual([]);
    expect(canon.list(projectId)).toEqual(canonBefore);
  });

  it('lets the outer model correct one invalid image-tag selection without rerunning nested generation', async () => {
    const character = canon.persistCreate(projectId, canonFields);
    const appearance = canon.persistCreate(projectId, {
      category: 'CHARACTER_APPEARANCE', name: '하린', content: '긴 은발', status: 'ACTIVE',
    });
    completeJson.mockResolvedValueOnce({ runId: 'corrected-image-tag-run', value: {
      tags: ['1girl', 'long_silver_hair'],
    } });
    let attempts: unknown[] = [];
    completeChat.mockImplementationOnce(async (request) => {
      attempts = [
        await request.readTool('generate_image_tags', JSON.stringify({
          characterAppearanceIds: [character.id], locationId: null, additionalDescription: '',
        })),
        await request.readTool('generate_image_tags', JSON.stringify({
          characterAppearanceIds: [appearance.id], locationId: null, additionalDescription: '',
        })),
      ];
      return { runId: 'corrected-tool-run', value: request.resolveAfterTools() };
    });

    const history = await chat.send(projectId, { content: '하린 이미지 태그를 만들어 줘', clientMessageId: 'invalid-image-tags' });

    expect(attempts).toEqual([
      expect.objectContaining({ error: 'WRONG_CANON_CATEGORY' }),
      {
        tags: ['1girl', 'long_silver_hair'],
        tagString: '1girl, long_silver_hair',
        sourceCanonIds: [appearance.id],
      },
    ]);
    expect(completeJson).toHaveBeenCalledTimes(1);
    expect(history.messages.at(-1)).toMatchObject({
      content: '1girl, long_silver_hair', proposals: [], status: 'COMPLETE',
    });
  });

  it('stops image-tag argument correction after two invalid tool attempts', async () => {
    const character = canon.persistCreate(projectId, canonFields);
    const invalidArguments = JSON.stringify({
      characterAppearanceIds: [character.id], locationId: null, additionalDescription: '',
    });
    let attempts: unknown[] = [];
    completeChat.mockImplementationOnce(async (request) => {
      attempts = [
        await request.readTool('generate_image_tags', invalidArguments),
        await request.readTool('generate_image_tags', invalidArguments),
        await request.readTool('generate_image_tags', invalidArguments),
      ];
      return { runId: 'tool-attempt-limit-run', value: { reply: '확정된 인물 외형을 지정해 주세요.', proposals: [] } };
    });

    await chat.send(projectId, { content: '하린 이미지 태그를 만들어 줘', clientMessageId: 'limited-image-tags' });

    expect(attempts).toEqual([
      expect.objectContaining({ error: 'WRONG_CANON_CATEGORY' }),
      expect.objectContaining({ error: 'WRONG_CANON_CATEGORY' }),
      expect.objectContaining({ error: 'IMAGE_TAG_TOOL_ATTEMPT_LIMIT' }),
    ]);
    expect(completeJson).not.toHaveBeenCalled();
  });

  it('omits unsupported temperature on actual Luna gateway requests while requiring tools and structured output', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'test-chat-key');
    vi.stubEnv('AI_CHAT_MODEL', 'openai/gpt-5.6-luna');
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return Response.json({
        model: 'openai/gpt-5.6-luna',
        choices: [{ message: { role: 'assistant', content: bodies.length === 1 ? '' : JSON.stringify({ reply: '작품 설명입니다.', proposals: [] }) } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      });
    }));
    const runner = new AiRunnerService(database, new PromptRegistryService(), new OpenRouterGateway(), { isConfigured: () => false } as never);
    const service = new ChatService(database, runner, new ArcEpisodeDirectionsService(runner), projects, canon, arcs, improvements, memory, reads, episodeTools);
    const history = await service.send(projectId, { content: '작품을 설명해 줘', clientMessageId: 'wire' });
    expect(history.messages[1]!.status).toBe('COMPLETE');
    expect(bodies).toHaveLength(2);
    for (const body of bodies) {
      expect(body.model).toBe('openai/gpt-5.6-luna');
      expect(body).not.toHaveProperty('temperature');
      expect(body.provider).toEqual({ require_parameters: true });
    }
    expect(bodies[0]!.tools).toBeInstanceOf(Array);
    expect(bodies[1]!.response_format).toMatchObject({ type: 'json_schema', json_schema: { strict: true } });
  });

  it('atomically applies a creation once and indexes it after commit', async () => {
    const history = await ask([proposal('CANON', 'CREATE', canonFields)]);
    const id = history.messages[1]!.proposals[0]!.id;
    const results = await Promise.all([chat.apply(projectId, id), chat.apply(projectId, id)]);
    expect(results[0]).toEqual(results[1]);
    expect(results[0]!.proposal.status).toBe('APPLIED');
    expect(canon.list(projectId)).toHaveLength(1);
    expect(await memory.search(projectId, '하린')).not.toHaveLength(0);
    expect(database.connection.prepare('SELECT index_targets_json FROM chat_proposals WHERE id = ?').get(id)).toEqual({ index_targets_json: '[]' });
  });

  it('rolls back entity changes when recording an application fails', async () => {
    const history = await ask([proposal('CANON', 'CREATE', canonFields)]);
    const id = history.messages[1]!.proposals[0]!.id;
    const original = canon.persistCreate.bind(canon);
    vi.spyOn(canon, 'persistCreate').mockImplementation((scope, body) => { original(scope, body); throw new Error('crash before proposal record'); });
    await expect(chat.apply(projectId, id)).rejects.toThrow('crash before');
    expect(canon.list(projectId)).toHaveLength(0);
    expect(chat.history(projectId).messages[1]!.proposals[0]!.status).toBe('PENDING');
  });

  it('retries indexing after a committed apply without repeating the creation', async () => {
    const history = await ask([proposal('CANON', 'CREATE', canonFields)]);
    const id = history.messages[1]!.proposals[0]!.id;
    const sync = vi.spyOn(canon, 'syncMemory').mockRejectedValueOnce(new Error('index unavailable'));
    const first = await chat.apply(projectId, id);
    expect(first.proposal.status).toBe('APPLIED');
    expect(database.connection.prepare('SELECT index_targets_json FROM chat_proposals WHERE id = ?').get(id)).not.toEqual({ index_targets_json: '[]' });
    await chat.onModuleInit();
    expect(await chat.apply(projectId, id)).toEqual(first);
    expect(canon.list(projectId)).toHaveLength(1);
    expect(sync).toHaveBeenCalledTimes(2);
  });

  it('rejects stale update and deletion proposals before mutating anything', async () => {
    const record = await canon.create(projectId, canonFields);
    const first = await ask([proposal('CANON', 'UPDATE', { content: '다른 설정' }, record.id)]);
    const second = await ask([proposal('CANON', 'DELETE', {}, record.id)], 'turn-2');
    await canon.update(projectId, record.id, { expectedRevision: record.revision, content: '사용자가 수정한 설정' });
    await expect(chat.apply(projectId, first.messages[1]!.proposals[0]!.id)).rejects.toBeInstanceOf(ConflictException);
    await expect(chat.apply(projectId, second.messages[3]!.proposals[0]!.id)).rejects.toBeInstanceOf(ConflictException);
    expect(canon.get(projectId, record.id).content).toBe('사용자가 수정한 설정');
  });

  it.each(['CANON', 'ARC', 'IMPROVEMENT'] as const)('applies and replays %s deletions without deleting unrelated records', async (kind) => {
    const record = kind === 'CANON' ? await canon.create(projectId, canonFields)
      : kind === 'ARC' ? await arcs.create(projectId, arcFields)
      : await improvements.create({ scope: 'PROJECT', projectId, title: '간결성', rule: '문장을 간결하게 쓴다' });
    const history = await ask([proposal(kind, 'DELETE', {}, record.id)]);
    const id = history.messages[1]!.proposals[0]!.id;
    const response = await chat.apply(projectId, id);
    expect(response.proposal.result).toEqual({ id: record.id, deleted: true });
    expect(await chat.apply(projectId, id)).toEqual(response);
    expect(() => reads.getRecord(projectId, kind, record.id)).toThrow(NotFoundException);
    expect(projects.get(projectId)).toBeDefined();
  });

  it('supports project updates and creates project-scoped improvements with defaults', async () => {
    const history = await ask([
      proposal('PROJECT', 'UPDATE', {
        title: '새 작품명',
        writingDirection: '주인공의 1인칭 현재 시점과 빠른 대화 호흡을 유지한다.',
      }, projectId),
      proposal('IMPROVEMENT', 'CREATE', { title: '간결성', rule: '문장을 간결하게 쓴다' }),
    ]);
    for (const item of history.messages[1]!.proposals) await chat.apply(projectId, item.id);
    expect(projects.get(projectId)).toMatchObject({
      title: '새 작품명',
      writingDirection: '주인공의 1인칭 현재 시점과 빠른 대화 호흡을 유지한다.',
    });
    expect(improvements.list(projectId)[0]).toMatchObject({ scope: 'PROJECT', projectId, rule: '문장을 간결하게 쓴다', active: true });
  });

  it('applies a pending project proposal saved with the legacy details field', async () => {
    const history = await ask([
      proposal('PROJECT', 'UPDATE', {
        writingDirection: '3인칭 제한 시점과 묵직한 문체를 유지한다.',
      }, projectId),
    ]);
    const proposalId = history.messages[1]!.proposals[0]!.id;
    const stored = database.orm.select().from(chatProposals).where(eq(chatProposals.id, proposalId)).get()!;
    const legacy = (value: string) => {
      const parsed = JSON.parse(value) as Record<string, unknown>;
      parsed.details = parsed.writingDirection;
      delete parsed.writingDirection;
      return JSON.stringify(parsed);
    };
    database.orm.update(chatProposals).set({
      beforeJson: legacy(stored.beforeJson),
      afterJson: legacy(stored.afterJson),
    }).where(eq(chatProposals.id, proposalId)).run();

    await chat.apply(projectId, proposalId);

    expect(projects.get(projectId).writingDirection)
      .toBe('3인칭 제한 시점과 묵직한 문체를 유지한다.');
  });

  it('generates ARC CREATE directions in stage two and overwrites model-supplied directions', async () => {
    const history = await ask([proposal('ARC', 'CREATE', {
      ...arcFields,
      episodeDirections: '형식도 틀린 모델 전개 값',
    })]);
    const created = history.messages[1]!.proposals[0]!;

    expect(created.after).toMatchObject({
      milestones: arcFields.milestones,
      episodeDirections: Array.from({ length: 8 }, (_, index) => ({
        episode: index + 1,
        title: `${index + 1}화`,
        direction: '기록의 단서를 따라 다음 사건으로 나아간다.',
      })),
    });
    expect(JSON.stringify(created.after)).not.toContain('형식도 틀린 모델 전개 값');
    expect(completeJson).toHaveBeenCalledOnce();
    expect(completeJson.mock.calls[0]![0]).toMatchObject({
      task: 'arc_episode_directions',
      promptId: 'arc-episode-directions',
      projectId,
      variables: { arc_milestones: arcFields },
    });
    expect(completeJson.mock.calls[0]![0].variables.arc_milestones)
      .not.toHaveProperty('episodeDirections');
  });

  it('regenerates directions for structural ARC updates but skips status-only updates and deletes', async () => {
    const record = await arcs.create(projectId, arcFields);
    completeJson.mockClear();

    const structural = await ask([
      proposal('ARC', 'UPDATE', { goal: '숨겨진 왕실 기록까지 찾는다.' }, record.id),
    ]);
    expect(completeJson).toHaveBeenCalledOnce();
    expect(structural.messages[1]!.proposals[0]!.after).toMatchObject({
      goal: '숨겨진 왕실 기록까지 찾는다.',
      episodeDirections: Array.from({ length: 8 }, (_, index) => ({ episode: index + 1 })),
    });

    completeJson.mockClear();
    await ask([proposal('ARC', 'UPDATE', { status: 'PLANNED' }, record.id)], 'status-only');
    await ask([proposal('ARC', 'DELETE', {}, record.id)], 'delete-only');
    expect(completeJson).not.toHaveBeenCalled();
  });

  it('fails the whole chat turn without proposals when ARC direction generation fails', async () => {
    completeJson.mockRejectedValueOnce(new Error('direction stage unavailable'));

    await expect(ask([proposal('ARC', 'CREATE', arcFields)], 'direction-failure'))
      .rejects.toBeInstanceOf(BadGatewayException);

    expect(chat.history(projectId).messages[1]).toMatchObject({
      status: 'FAILED',
      content: '',
      proposals: [],
    });
    expect(database.orm.select().from(chatProposals).all()).toHaveLength(0);
    expect(errorLog).toHaveBeenCalledWith(expect.objectContaining({
      event: 'chat_send_failed',
      stage: 'arc_directions',
      runId: 'chat-run',
    }));
  });

  it('applies a pending legacy ARC proposal with preserved reversals and synthesized directions', async () => {
    const description = '원래 저장된 반전 문구';
    const history = await ask([proposal('ARC', 'CREATE', {
      ...arcFields,
      milestones: [{ episode: 4, type: 'REVERSAL', description }],
    })], 'legacy-arc-proposal');
    const proposalId = history.messages[1]!.proposals[0]!.id;
    const stored = database.orm.select().from(chatProposals).where(eq(chatProposals.id, proposalId)).get()!;
    const legacyAfter = JSON.parse(stored.afterJson) as Record<string, unknown>;
    legacyAfter.reversalPlan = [{ episode: 4, description }];
    delete legacyAfter.milestones;
    delete legacyAfter.episodeDirections;
    database.orm.update(chatProposals).set({
      afterJson: JSON.stringify(legacyAfter),
    }).where(eq(chatProposals.id, proposalId)).run();

    expect(chat.history(projectId).messages[1]!.proposals[0]!.after).toMatchObject({
      milestones: [{ episode: 4, type: 'REVERSAL', description }],
      episodeDirections: Array.from({ length: 8 }, (_, index) => ({ episode: index + 1 })),
    });
    const applied = await chat.apply(projectId, proposalId);
    const arcId = String(applied.proposal.result!.id);
    expect(arcs.get(projectId, arcId)).toMatchObject({
      milestones: [{ episode: 4, type: 'REVERSAL', description }],
      episodeDirections: Array.from({ length: 8 }, (_, index) => ({ episode: index + 1 })),
    });
  });

  it('shows arc archival effects and applies the activation with those effects atomically', async () => {
    const oldArc = await arcs.create(projectId, { ...arcFields, status: 'ACTIVE' });
    const history = await ask([proposal('ARC', 'CREATE', {
      ...arcFields,
      title: '다음 아크',
      startEpisodeNumber: 9,
      endEpisodeNumber: 16,
      milestones: [{ episode: 16, type: 'GOAL', description: '다음 아크의 목표를 완수한다.' }],
      status: 'ACTIVE',
    })]);
    const item = history.messages[1]!.proposals[0]!;
    expect(item.effects[0]).toMatchObject({ label: expect.stringContaining(oldArc.title), before: { id: oldArc.id, status: 'ACTIVE' }, after: { status: 'ARCHIVED' } });
    await chat.apply(projectId, item.id);
    expect(arcs.current(projectId)?.title).toBe('다음 아크');
    expect(arcs.get(projectId, oldArc.id)).toMatchObject({ status: 'ARCHIVED', revision: 2 });
  });

  it('rejects arc activation if the reviewed active arc changed', async () => {
    const old = await arcs.create(projectId, { ...arcFields, status: 'ACTIVE' });
    const history = await ask([proposal('ARC', 'CREATE', { ...arcFields, title: '다음', status: 'ACTIVE' })]);
    await arcs.update(projectId, old.id, {
      expectedRevision: old.revision, title: '수정한 아크', confirmProtected: true,
    });
    await expect(chat.apply(projectId, history.messages[1]!.proposals[0]!.id)).rejects.toBeInstanceOf(ConflictException);
    expect(arcs.list(projectId)).toHaveLength(1);
    expect(arcs.current(projectId)?.title).toBe('수정한 아크');
  });

  it('rejects activation when writing progress changes the reviewed current-arc outcome', async () => {
    const old = await arcs.create(projectId, { ...arcFields, status: 'ACTIVE' });
    const history = await ask([proposal('ARC', 'CREATE', {
      ...arcFields,
      title: '다음 아크',
      startEpisodeNumber: 9,
      endEpisodeNumber: 16,
      milestones: [{ episode: 16, type: 'GOAL', description: '다음 아크의 목표를 완수한다.' }],
      status: 'ACTIVE',
    })]);
    const stamp = new Date().toISOString();
    database.orm.insert(episodes).values({
      id: 'arc-ending-episode', projectId, number: 8, title: '마지막 문', direction: '문을 연다.', content: '문이 열렸다.',
      status: 'DRAFT', revision: 1, createdAt: stamp, updatedAt: stamp,
    }).run();

    await expect(chat.apply(projectId, history.messages[1]!.proposals[0]!.id))
      .rejects.toBeInstanceOf(ConflictException);
    expect(arcs.current(projectId)?.id).toBe(old.id);
    expect(arcs.list(projectId)).toHaveLength(1);
  });

  it.each([
    [null, 'COMPLETE'],
    [null, 'ARCHIVED'],
    ['PLANNED', 'COMPLETE'],
    ['PLANNED', 'ARCHIVED'],
    ['ACTIVE', 'PLANNED'],
    ['ACTIVE', 'COMPLETE'],
    ['ACTIVE', 'ARCHIVED'],
  ] as const)('rejects an ARC %s -> %s status transition while preparing proposals', async (currentStatus, nextStatus) => {
    const current = currentStatus ? await arcs.create(projectId, { ...arcFields, status: currentStatus }) : null;
    const invalid = current
      ? proposal('ARC', 'UPDATE', { status: nextStatus }, current.id)
      : proposal('ARC', 'CREATE', { ...arcFields, status: nextStatus });

    await expect(ask([invalid])).rejects.toBeInstanceOf(BadGatewayException);

    expect(chat.history(projectId).messages[1]).toMatchObject({ status: 'FAILED', proposals: [] });
    expect(database.orm.select().from(chatProposals).all()).toHaveLength(0);
    expect(arcs.list(projectId)).toEqual(current ? [current] : []);
  });

  it('keeps global improvements read-only and rejects cross-project targets and proposal application', async () => {
    const global = await improvements.create({ scope: 'GLOBAL', title: '전역', rule: '공통 지침' });
    await expect(ask([proposal('IMPROVEMENT', 'UPDATE', { rule: '변경' }, global.id)])).rejects.toBeInstanceOf(BadGatewayException);
    const other = projects.createInternal({ title: '다른 작품', logline: '별개의 세계', genreTags: ['SF'] });
    const foreign = await canon.create(other.id, canonFields);
    await expect(ask([proposal('CANON', 'DELETE', {}, foreign.id)], 'turn-2')).rejects.toBeInstanceOf(BadGatewayException);
    const history = await ask([proposal('CANON', 'CREATE', canonFields)], 'turn-3');
    await expect(chat.apply(other.id, history.messages.at(-1)!.proposals[0]!.id)).rejects.toBeInstanceOf(NotFoundException);
    expect(improvements.get(global.id).rule).toBe('공통 지침');
    expect(canon.get(other.id, foreign.id)).toBeDefined();
  });

  it.each([
    proposal('PROJECT', 'DELETE', {}, 'REPLACE_PROJECT'),
    proposal('CANON', 'CREATE', { ...canonFields, projectId: 'foreign' }),
    proposal('IMPROVEMENT', 'CREATE', { title: '금지', rule: '지침', scope: 'GLOBAL' }),
    proposal('ARC', 'CREATE', { ...arcFields, endEpisodeNumber: 50 }),
  ])('rejects unsupported or invalid proposals without publishing a partial turn', async (invalid) => {
    const input = { ...invalid, targetId: invalid.targetId === 'REPLACE_PROJECT' ? projectId : invalid.targetId };
    await expect(ask([proposal('CANON', 'CREATE', canonFields), input])).rejects.toBeInstanceOf(BadGatewayException);
    expect(chat.history(projectId).messages[1]).toMatchObject({ status: 'FAILED', proposals: [] });
    expect(database.orm.select().from(chatProposals).all()).toHaveLength(0);
    expect(canon.list(projectId)).toHaveLength(0);
  });

  it('replays complete turns, retries failed turns with the same ID, and rejects changed retry content', async () => {
    completeChat.mockRejectedValueOnce(new Error('provider failure'));
    const input = { content: '설정을 설명해 줘', clientMessageId: 'request' };
    await expect(chat.send(projectId, input)).rejects.toBeInstanceOf(BadGatewayException);
    expect(chat.history(projectId).messages[1]!.status).toBe('FAILED');
    completeChat.mockResolvedValueOnce({ runId: 'retry', value: { reply: '설명입니다.', proposals: [] } });
    const recovered = await chat.send(projectId, input);
    expect(recovered.messages).toHaveLength(2);
    expect(recovered.messages[1]!.status).toBe('COMPLETE');
    expect(await chat.send(projectId, input)).toEqual(recovered);
    expect(completeChat).toHaveBeenCalledTimes(2);
    await expect(chat.send(projectId, { ...input, content: '다른 내용' })).rejects.toBeInstanceOf(ConflictException);
  });

  it('logs start and completion with correlation IDs without logging the conversation', async () => {
    const history = await ask([], 'logged-turn', 'private conversation text');
    expect(infoLog).toHaveBeenCalledWith(expect.objectContaining({ event: 'chat_send_started', projectId,
      clientMessageId: 'logged-turn', model: 'test-chat-model', elapsedMs: expect.any(Number) }));
    expect(infoLog).toHaveBeenCalledWith(expect.objectContaining({ event: 'chat_send_completed', stage: 'complete',
      assistantMessageId: history.messages[1]!.id, runId: 'chat-run', proposalCount: 0, replayed: false }));
    await chat.send(projectId, { content: 'private conversation text', clientMessageId: 'logged-turn' });
    expect(infoLog).toHaveBeenLastCalledWith(expect.objectContaining({ event: 'chat_send_completed', runId: 'chat-run', replayed: true }));
    expect(errorLog).not.toHaveBeenCalled();
    expect(JSON.stringify(infoLog.mock.calls)).not.toContain('private conversation text');
    expect(JSON.stringify(infoLog.mock.calls)).not.toContain('검토할 내용을 준비했습니다.');
  });

  it('logs the offending proposal and Zod field diagnostics after successful AI output', async () => {
    await expect(ask([
      proposal('CANON', 'CREATE', canonFields),
      proposal('IMPROVEMENT', 'CREATE', { title: 'private proposal title', rule: 'private rule text', scope: 'GLOBAL' }),
    ], 'invalid-proposal')).rejects.toBeInstanceOf(BadGatewayException);
    expect(errorLog).toHaveBeenCalledWith(expect.objectContaining({ event: 'chat_send_failed', stage: 'proposal_validate',
      projectId, clientMessageId: 'invalid-proposal', assistantMessageId: expect.any(String), runId: 'chat-run',
      proposal: { index: 1, kind: 'IMPROVEMENT', operation: 'CREATE', targetId: null },
      error: expect.objectContaining({ name: 'ZodError', issues: expect.arrayContaining([
        expect.objectContaining({ code: 'unrecognized_keys', keys: ['scope'] }),
      ]) }),
    }));
    expect(chat.history(projectId).messages[1]).toMatchObject({ status: 'FAILED', content: '', proposals: [] });
    expect(database.orm.select().from(chatProposals).all()).toHaveLength(0);
    const logs = JSON.stringify(errorLog.mock.calls);
    expect(logs).not.toContain('private proposal title');
    expect(logs).not.toContain('private rule text');
  });

  it('logs the path and expected type of an invalid change field', async () => {
    await expect(ask([proposal('CANON', 'CREATE', { ...canonFields, aliases: 42 })])).rejects.toBeInstanceOf(BadGatewayException);
    expect(errorLog).toHaveBeenCalledWith(expect.objectContaining({ stage: 'proposal_validate', error: expect.objectContaining({
      issues: expect.arrayContaining([expect.objectContaining({ path: ['aliases'], code: 'invalid_type', expected: 'array' })]),
    }) }));
  });

  it('retains the JSON parsing cause without logging the malformed output', async () => {
    const invalid = { ...proposal('CANON', 'CREATE'), changesJson: 'private-model-output-that-is-not-json' };
    await expect(ask([invalid])).rejects.toBeInstanceOf(BadGatewayException);
    expect(errorLog).toHaveBeenCalledWith(expect.objectContaining({ stage: 'proposal_validate', error: expect.objectContaining({
      name: 'BadGatewayException', cause: expect.objectContaining({ name: 'SyntaxError' }),
    }) }));
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain('private-model-output');
  });

  it('logs OpenRouter failures with the run ID and leaves the public error unchanged', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'private-router-key');
    vi.stubEnv('AI_CHAT_MODEL', 'openai/gpt-5.6-luna');
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: { message: 'Provider rejected this request' } }, { status: 401 })));
    const runner = new AiRunnerService(database, new PromptRegistryService(), new OpenRouterGateway(), { isConfigured: () => false } as never);
    const service = new ChatService(database, runner, new ArcEpisodeDirectionsService(runner), projects, canon, arcs, improvements, memory, reads, episodeTools);
    await expect(service.send(projectId, { content: 'private request', clientMessageId: 'upstream-failure' }))
      .rejects.toThrow('AI 답변을 만들지 못했습니다. 같은 메시지를 다시 시도해 주세요.');
    const message = service.history(projectId).messages[1]!;
    const run = database.connection.prepare("SELECT id, status FROM ai_runs WHERE task = 'project_chat'").get() as { id: string; status: string };
    expect(run.status).toBe('FAILED');
    expect(errorLog).toHaveBeenCalledWith(expect.objectContaining({ stage: 'ai', runId: run.id, assistantMessageId: message.id,
      model: 'openai/gpt-5.6-luna', error: expect.objectContaining({ name: 'ServiceUnavailableException', message: 'Provider rejected this request' }),
    }));
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain('private-router-key');
  });

  it('logs memory failures before an AI run exists', async () => {
    vi.spyOn(memory, 'assemble').mockRejectedValueOnce(new Error('Context assembly failed'));
    await expect(chat.send(projectId, { content: 'question', clientMessageId: 'memory-failure' })).rejects.toBeInstanceOf(BadGatewayException);
    expect(errorLog).toHaveBeenCalledWith(expect.objectContaining({ stage: 'memory', runId: null,
      assistantMessageId: expect.any(String), error: expect.objectContaining({ message: 'Context assembly failed' }),
    }));
    expect(completeChat).not.toHaveBeenCalled();
  });

  it('distinguishes proposal persistence from validation failures and rolls back proposals', async () => {
    database.connection.exec("CREATE TEMP TRIGGER reject_proposal BEFORE INSERT ON chat_proposals BEGIN SELECT RAISE(FAIL, 'Synthetic proposal storage failure'); END");
    await expect(ask([proposal('CANON', 'CREATE', canonFields)])).rejects.toBeInstanceOf(BadGatewayException);
    expect(errorLog).toHaveBeenCalledWith(expect.objectContaining({ stage: 'proposal_persist', runId: 'chat-run',
      proposal: { index: 0, kind: 'CANON', operation: 'CREATE', targetId: null },
    }));
    expect(JSON.stringify(errorLog.mock.calls)).toContain('Synthetic proposal storage failure');
    expect(database.orm.select().from(chatProposals).all()).toHaveLength(0);
    expect(chat.history(projectId).messages[1]!.status).toBe('FAILED');
  });

  it('logs final answer persistence failures separately', async () => {
    database.connection.exec("CREATE TEMP TRIGGER reject_answer BEFORE UPDATE ON chat_messages WHEN NEW.status = 'COMPLETE' BEGIN SELECT RAISE(FAIL, 'Synthetic answer storage failure'); END");
    await expect(ask([proposal('CANON', 'CREATE', canonFields)])).rejects.toBeInstanceOf(BadGatewayException);
    expect(errorLog).toHaveBeenCalledWith(expect.objectContaining({ stage: 'message_persist', runId: 'chat-run' }));
    expect(errorLog.mock.calls[0]![0]).not.toHaveProperty('proposal');
    expect(database.orm.select().from(chatProposals).all()).toHaveLength(0);
    expect(chat.history(projectId).messages[1]!.status).toBe('FAILED');
  });

  it('captures the run ID even when linking it to the message fails', async () => {
    database.connection.exec("CREATE TEMP TRIGGER reject_run_link BEFORE UPDATE ON chat_messages WHEN NEW.run_id IS NOT NULL BEGIN SELECT RAISE(FAIL, 'Synthetic run link failure'); END");
    completeChat.mockImplementationOnce(async (_input, onRunStarted) => { onRunStarted('unlinked-run'); });
    await expect(chat.send(projectId, { content: 'question', clientMessageId: 'run-link-failure' })).rejects.toBeInstanceOf(BadGatewayException);
    expect(errorLog).toHaveBeenCalledWith(expect.objectContaining({ stage: 'run_link_persist', runId: 'unlinked-run' }));
    expect(chat.history(projectId).messages[1]!.status).toBe('FAILED');
  });

  it('logs the original failure before a failed status write and retains it as the thrown cause', async () => {
    database.connection.exec("CREATE TEMP TRIGGER reject_failure_status BEFORE UPDATE ON chat_messages WHEN NEW.status = 'FAILED' BEGIN SELECT RAISE(FAIL, 'Synthetic failure status storage failure'); END");
    const original = new Error('Original provider failure');
    completeChat.mockRejectedValueOnce(original);
    await expect(chat.send(projectId, { content: 'question', clientMessageId: 'double-failure' })).rejects.toMatchObject({ cause: original });
    expect(errorLog.mock.calls.map(([entry]) => entry.event)).toEqual(['chat_send_failed', 'chat_failure_status_write_failed']);
    expect(errorLog.mock.calls[0]![0]).toMatchObject({ stage: 'ai', error: { message: original.message } });
    expect(errorLog.mock.calls[1]![0]).toMatchObject({ stage: 'failure_persist', failedStage: 'ai' });
    expect(JSON.stringify(errorLog.mock.calls[1])).toContain('Synthetic failure status storage failure');
    expect(chat.history(projectId).messages[1]!.status).toBe('PENDING');
  });

  it('logs an initial turn write failure without marking another turn failed', async () => {
    database.connection.exec("CREATE TEMP TRIGGER reject_turn BEFORE INSERT ON chat_messages BEGIN SELECT RAISE(FAIL, 'Synthetic turn storage failure'); END");
    await expect(chat.send(projectId, { content: 'question', clientMessageId: 'turn-failure' })).rejects.toThrow('Synthetic turn storage failure');
    expect(errorLog).toHaveBeenCalledOnce();
    expect(errorLog.mock.calls[0]![0]).toMatchObject({ stage: 'turn_persist', assistantMessageId: null, runId: null });
    expect(chat.history(projectId).messages).toEqual([]);
  });

  it('keeps retries in their original conversation position without using later turns', async () => {
    completeChat.mockRejectedValueOnce(new Error('temporary failure'));
    await expect(chat.send(projectId, { content: '첫 번째 질문', clientMessageId: 'first' })).rejects.toBeInstanceOf(BadGatewayException);
    await ask([], 'second', '나중에 한 질문');
    completeChat.mockResolvedValueOnce({ runId: 'retry', value: { reply: '첫 답변', proposals: [] } });
    await chat.send(projectId, { content: '첫 번째 질문', clientMessageId: 'first' });
    expect(completeChat.mock.calls.at(-1)![0].history).toEqual([{ role: 'user', content: '첫 번째 질문' }]);
    expect(chat.history(projectId).messages.map((message) => message.clientMessageId)).toEqual(['first', 'first', 'second', 'second']);
  });

  it('accepts pasted requests up to the frontend 20,000-character limit', async () => {
    const history = await ask([], 'long-request', '가'.repeat(20_000));
    expect(history.messages[0]!.content).toHaveLength(20_000);
    await expect(chat.send(projectId, { content: '가'.repeat(20_001), clientMessageId: 'too-long' })).rejects.toThrow();
  });

  it('marks interrupted pending assistants failed on startup', async () => {
    const thread = chat.createThread(projectId);
    database.orm.insert(chatMessages).values({ id: 'interrupted', projectId, threadId: thread.id, clientMessageId: 'old', role: 'assistant', content: '', status: 'PENDING', createdAt: new Date().toISOString() }).run();
    await chat.onModuleInit();
    expect(chat.history(projectId).messages[0]).toMatchObject({ status: 'FAILED', error: expect.stringContaining('재시작') });
  });

  it('rejects overlapping sends and removes chat data if the project disappears during a model request', async () => {
    let finish!: (value: unknown) => void;
    completeChat.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const pending = chat.send(projectId, { content: '첫 질문', clientMessageId: 'a' });
    await vi.waitFor(() => expect(finish).toBeDefined());
    await expect(chat.send(projectId, { content: '둘째 질문', clientMessageId: 'b' })).rejects.toBeInstanceOf(ConflictException);
    projects.remove(projectId);
    finish({ runId: 'late', value: { reply: '늦은 답변', proposals: [] } });
    await expect(pending).rejects.toBeInstanceOf(NotFoundException);
    expect(database.orm.select().from(chatMessages).all()).toHaveLength(0);
    expect(database.orm.select().from(chatThreads).all()).toHaveLength(0);
  });

  it('reads a specific old draft episode in bounded pages without changing its body or status', async () => {
    const stamp = new Date().toISOString();
    database.orm.insert(episodes).values({ id: 'old-episode', projectId, number: 2, title: '이전 회차', direction: '', content: '가'.repeat(13_000), status: 'DRAFT', revision: 3, createdAt: stamp, updatedAt: stamp }).run();
    const snapshots = new Map();
    const page = await reads.call(projectId, 'read_project_record', JSON.stringify({ kind: 'EPISODE', id: null, episodeNumber: 2, offset: 0 }), snapshots) as Record<string, unknown>;
    expect(page).toMatchObject({ id: 'old-episode', status: 'DRAFT', revision: 3, summary: null, nextOffset: 12_000 });
    expect(String(page.content)).toHaveLength(12_000);
    const rest = await reads.call(projectId, 'read_project_record', JSON.stringify({ kind: 'EPISODE', id: 'old-episode', episodeNumber: null, offset: 12_000 }), snapshots) as Record<string, unknown>;
    expect(String(rest.content)).toHaveLength(1_000);
    expect(rest.nextOffset).toBeNull();
    const list = await reads.call(projectId, 'list_project_records', JSON.stringify({ kind: 'EPISODE', offset: 0, limit: 50 }), snapshots);
    expect(JSON.stringify(list)).not.toContain('가');
    expect(database.orm.select().from(episodes).where(eq(episodes.id, 'old-episode')).get()).toMatchObject({ status: 'DRAFT', revision: 3, content: '가'.repeat(13_000) });
    const other = projects.createInternal({ title: '다른 작품', logline: '다른 세계', genreTags: ['SF'] });
    expect(await reads.call(other.id, 'read_project_record', JSON.stringify({ kind: 'EPISODE', id: 'old-episode', episodeNumber: null, offset: 0 }), snapshots)).toEqual({ error: 'NOT_FOUND' });
    expect(await reads.call(projectId, 'write_episode', '{}', snapshots)).toEqual({ error: 'UNKNOWN_TOOL' });
  });

  it('bounds conversation history while retaining the latest request and proposal application status', async () => {
    for (let turn = 0; turn < 12; turn += 1) await ask([], `turn-${turn}`, `질문 ${turn}`);
    const input = completeChat.mock.calls.at(-1)![0];
    expect(input.history).toHaveLength(20);
    expect(input.history.at(-1)).toEqual({ role: 'user', content: '질문 11' });
    expect(input.history.reduce((sum: number, item: { content: string }) => sum + item.content.length, 0)).toBeLessThanOrEqual(40_000);
  });
});

describe('chat model runner', () => {
  let database: DatabaseService;
  beforeEach(() => {
    vi.stubEnv('DB_PATH', ':memory:'); vi.stubEnv('OPENROUTER_EMBEDDING_DIMENSIONS', '4');
    vi.stubEnv('AI_WRITING_MODEL', 'writing-model'); vi.stubEnv('AI_IMPROVEMENT_MODEL', 'improvement-model');
    vi.stubEnv('AI_CHAT_MODEL', 'openai/gpt-5.6-luna');
    database = new DatabaseService();
  });
  afterEach(() => { database.onApplicationShutdown(); vi.unstubAllEnvs(); });

  it('uses Luna for scoped read rounds and final validated JSON, retaining tool metadata and aggregate usage', async () => {
    const toolCall = { id: 'read-1', type: 'function' as const, function: { name: 'read_project_record', arguments: '{}' } };
    const metadata = [{ type: 'reasoning.encrypted', data: 'signature' }];
    const gateway = { complete: vi.fn()
      .mockResolvedValueOnce({ content: '', model: 'openai/gpt-5.6-luna', toolCalls: [toolCall], usage: { promptTokens: 1, completionTokens: 2 }, assistantMessage: { role: 'assistant', content: null, tool_calls: [toolCall], reasoning_details: metadata } })
      .mockResolvedValueOnce({ content: '자료 조회 완료', model: 'openai/gpt-5.6-luna', toolCalls: [], usage: { promptTokens: 3, completionTokens: 4 } })
      .mockResolvedValueOnce({ content: '{"reply":"옛 회차에 대한 답변","proposals":[]}', model: 'openai/gpt-5.6-luna', toolCalls: [], usage: { promptTokens: 5, completionTokens: 6 } }) };
    const registry = new PromptRegistryService();
    const runner = new AiRunnerService(database, registry, gateway as never, { isConfigured: () => false } as never);
    const readTool = vi.fn(async () => ({ content: '실제 과거 회차의 본문' }));
    const result = await runner.completeChat({ task: 'project_chat', promptId: 'project-chat', variables: Object.fromEntries(registry.get('project-chat').requiredVariables.map((key) => [key, '[]'])),
      history: [{ role: 'user', content: '2화에 어떤 일이 있었어?' }], validator: chatOutputValidator,
      schema: { name: 'project_chat_reply', value: chatOutputSchema }, readTools: [], readTool });
    expect(result.value.reply).toContain('옛 회차');
    expect(readTool).toHaveBeenCalledWith('read_project_record', '{}');
    for (const [request] of gateway.complete.mock.calls as [CompletionRequest][]) expect(request.model).toBe('openai/gpt-5.6-luna');
    const second = gateway.complete.mock.calls[1]![0] as CompletionRequest;
    expect(second.messages).toContainEqual(expect.objectContaining({ role: 'assistant', reasoning_details: metadata }));
    expect(second.messages).toContainEqual(expect.objectContaining({ role: 'tool', tool_call_id: 'read-1' }));
    expect((gateway.complete.mock.calls[2]![0] as CompletionRequest).tools).toBeUndefined();
    expect(database.connection.prepare('SELECT status, input_tokens, output_tokens, model FROM ai_runs').get()).toEqual({ status: 'SUCCEEDED', input_tokens: 9, output_tokens: 12, model: 'openai/gpt-5.6-luna' });
  });

  it('runs the image-tag tool as a separate Luna completion without exposing tools to the nested run', async () => {
    vi.stubEnv('AI_IMAGE_TAG_MODEL', 'openai/gpt-5.6-luna');
    let toolArguments = '';
    const contaminatedOuterOutput = {
      reply: '메인 모델이 태그 순서와 문장을 임의로 바꾸었습니다.',
      proposals: [proposal('CANON', 'CREATE', canonFields)],
    };
    const gateway = { complete: vi.fn(async (request: CompletionRequest) => {
      if (request.schema?.name === 'image_tags') {
        return { content: '{"tags":["1girl","long_silver_hair","glasshouse","moonlight"]}', model: request.model, toolCalls: [], usage: { promptTokens: 3, completionTokens: 2 } };
      }
      if (request.messages.some((message) => message.role === 'tool') || request.schema?.name === 'project_chat_reply') {
        return { content: JSON.stringify(contaminatedOuterOutput), model: request.model, toolCalls: [], usage: { promptTokens: 5, completionTokens: 3 } };
      }
      const toolCalls = [{
        id: 'image-tags-1',
        type: 'function' as const,
        function: { name: 'generate_image_tags', arguments: toolArguments },
      }, {
        id: 'unneeded-read-1',
        type: 'function' as const,
        function: { name: 'read_project_record', arguments: JSON.stringify({ kind: 'PROJECT', id: null, episodeNumber: null, offset: 0 }) },
      }];
      return { content: '', model: request.model, toolCalls, usage: { promptTokens: 1, completionTokens: 1 }, assistantMessage: { role: 'assistant', content: null, tool_calls: toolCalls } };
    }) };
    const registry = new PromptRegistryService();
    const runner = new AiRunnerService(database, registry, gateway as never, { isConfigured: () => false } as never);
    const projects = new ProjectsService(database);
    const memory = new MemoryService(database, { embeddings: vi.fn(async (texts: string[]) => texts.map(() => [0, 1, 0, 1])) } as never);
    const canon = new CanonService(database, memory, runner);
    const arcDirections = new ArcEpisodeDirectionsService(runner);
    const arcs = new ArcsService(database, memory, runner, arcDirections);
    const improvements = new ImprovementsService(database, runner, memory);
    const imageTags = new ImageTagToolService(projects, canon, runner);
    const imageTagCall = vi.spyOn(imageTags, 'call');
    const reads = new ChatReadToolsService(database, projects, canon, arcs, improvements, memory, { isConfigured: () => false } as never, imageTags);
    const readCall = vi.spyOn(reads, 'call');
    const episodeService = new EpisodesService(database, projects, memory, runner);
    const editor = new EditorAiService(database, episodeService, memory, runner);
    const episodeTools = new ChatEpisodeToolsService(database, episodeService, editor);
    const chat = new ChatService(database, runner, arcDirections, projects, canon, arcs, improvements, memory, reads, episodeTools);
    const projectId = projects.createInternal({ title: '달의 문', logline: '달빛 아래 기록관', genreTags: ['판타지'] }).id;
    const appearance = canon.persistCreate(projectId, {
      category: 'CHARACTER_APPEARANCE', name: '하린', content: '허리까지 오는 은발', status: 'ACTIVE',
    });
    const location = canon.persistCreate(projectId, {
      category: 'LOCATION', name: '유리 온실', content: '높은 유리 천장과 흰 대리석 바닥', status: 'ACTIVE',
    });
    const canonBefore = canon.list(projectId);
    toolArguments = JSON.stringify({
      characterAppearanceIds: [appearance.id],
      locationId: location.id,
      additionalDescription: '달빛',
    });
    const requestContent = '하린이 유리 온실에 서 있는 달빛 이미지의 단부루 태그를 만들어 줘';

    const history = await chat.send(projectId, { content: requestContent, clientMessageId: 'nested-image-tags' });

    const expectedToolResult = {
      tags: ['1girl', 'long_silver_hair', 'glasshouse', 'moonlight'],
      tagString: '1girl, long_silver_hair, glasshouse, moonlight',
      sourceCanonIds: [appearance.id, location.id],
    };
    expect(imageTagCall).toHaveBeenCalledTimes(1);
    expect(readCall).toHaveBeenCalledTimes(1);
    const nestedResult = await imageTagCall.mock.results[0]!.value;
    expect(nestedResult).toEqual(expectedToolResult);
    expect(JSON.stringify(nestedResult)).toBe(JSON.stringify(expectedToolResult));
    expect(history.messages.at(-1)).toMatchObject({
      role: 'assistant', content: expectedToolResult.tagString, proposals: [], status: 'COMPLETE',
    });
    expect(database.orm.select().from(chatProposals).all()).toEqual([]);
    expect(canon.list(projectId)).toEqual(canonBefore);

    expect(gateway.complete).toHaveBeenCalledTimes(2);
    const requests = gateway.complete.mock.calls.map(([request]) => request as CompletionRequest);
    expect(requests[0]).toMatchObject({ model: 'openai/gpt-5.6-luna', schema: undefined, maxTokens: 8_000 });
    expect(requests[0]!.tools?.map((tool) => tool.function.name)).toContain(generateImageTagsTool.function.name);
    expect(requests[0]!.messages.at(-1)).toEqual({ role: 'user', content: requestContent });
    const renderedUser = requests[0]!.messages[1]!.content;
    expect(typeof renderedUser).toBe('string');
    const catalogPrefix = '조회 가능한 항목 목록(ID, 분류, revision, 상태): ';
    const catalogStart = (renderedUser as string).indexOf(catalogPrefix);
    expect(catalogStart).toBeGreaterThanOrEqual(0);
    const catalogText = (renderedUser as string).slice(catalogStart + catalogPrefix.length).split('\n\n이후 대화')[0]!;
    const catalog = JSON.parse(catalogText) as Array<Record<string, unknown>>;
    expect(catalog).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'CANON', id: appearance.id, category: 'CHARACTER_APPEARANCE', status: 'ACTIVE' }),
      expect.objectContaining({ kind: 'CANON', id: location.id, category: 'LOCATION', status: 'ACTIVE' }),
    ]));
    expect(requests[1]).toMatchObject({ model: 'openai/gpt-5.6-luna', schema: { name: 'image_tags' }, tools: undefined });
    expect(requests.some((request) => request.schema?.name === 'project_chat_reply' || request.messages.some((message) => message.role === 'tool'))).toBe(false);
    const runs = database.connection.prepare(
      'SELECT id, task, model, status, input_tokens AS inputTokens, output_tokens AS outputTokens FROM ai_runs ORDER BY rowid',
    ).all() as Array<Record<string, unknown>>;
    expect(runs.map(({ id: _id, ...run }) => run)).toEqual([
      { task: 'project_chat', model: 'openai/gpt-5.6-luna', status: 'SUCCEEDED', inputTokens: 1, outputTokens: 1 },
      { task: 'image_tag_generation', model: 'openai/gpt-5.6-luna', status: 'SUCCEEDED', inputTokens: 3, outputTokens: 2 },
    ]);
    expect(new Set(runs.map((run) => run.id)).size).toBe(2);
  });

  it('bounds repeated reads and rejects episode-changing structured output after one retry', async () => {
    let requests = 0;
    const gateway = { complete: vi.fn(async () => {
      requests += 1;
      return requests <= 4
        ? { content: '', model: 'luna', toolCalls: Array.from({ length: 3 }, (_, index) => ({ id: `${requests}-${index}`, type: 'function', function: { name: 'read', arguments: '{}' } })), usage: {} }
        : { content: JSON.stringify({ reply: '집필', proposals: [{ kind: 'EPISODE', operation: 'UPDATE', title: '금지', targetId: 'episode', changesJson: '{}' }] }), model: 'luna', toolCalls: [], usage: {} };
    }) };
    const registry = new PromptRegistryService();
    const readTool = vi.fn(async () => ({ content: '자료' }));
    const runner = new AiRunnerService(database, registry, gateway as never, { isConfigured: () => false } as never);
    await expect(runner.completeChat({ task: 'project_chat', promptId: 'project-chat', variables: Object.fromEntries(registry.get('project-chat').requiredVariables.map((key) => [key, '[]'])),
      validator: chatOutputValidator, schema: { name: 'project_chat_reply', value: chatOutputSchema }, readTools: [], readTool })).rejects.toBeInstanceOf(BadGatewayException);
    expect(readTool).toHaveBeenCalledTimes(8);
    expect(gateway.complete).toHaveBeenCalledTimes(5);
    expect(database.connection.prepare('SELECT status FROM ai_runs').get()).toEqual({ status: 'FAILED' });
  });
});
