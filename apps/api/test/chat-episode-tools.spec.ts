import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { ChatEpisodeTask, ChatHistory, ConversationStreamEvent } from '@paranovel/contracts';
import { AiRunnerService } from '../src/ai/ai-runner.service';
import { ChatEpisodeToolsService } from '../src/chat/chat-episode-tools.service';
import { DatabaseService } from '../src/database/database.service';
import { chatEpisodeTasks, chatMessages } from '../src/database/schema';
import { EditorAiService } from '../src/episodes/editor-ai.service';
import { EpisodesService } from '../src/episodes/episodes.service';
import { MemoryService } from '../src/memory/memory.service';
import { ProjectsService } from '../src/projects/projects.service';

describe('project chat episode subagents', () => {
  let database: DatabaseService;
  let projects: ProjectsService;
  let episodes: EpisodesService;
  let editor: EditorAiService;
  let tools: ChatEpisodeToolsService;
  let projectId: string;
  let messageId: string;
  const completeChat = vi.fn();
  const completeJson = vi.fn();
  const streamText = vi.fn();
  const original = '앞 문장.\n하린은 😀 숨을 삼켰다.\n뒤 문장.';
  const passage = '하린은 😀 숨을 삼켰다.';
  const replacement = '하린의 손끝이 차갑게 굳었다.';
  const writeInput = { title: '닫힌 문', direction: '기록관이 문을 열고 비밀을 찾는다.', targetChars: null };

  beforeEach(() => {
    vi.stubEnv('DB_PATH', ':memory:');
    vi.stubEnv('OPENROUTER_EMBEDDING_DIMENSIONS', '4');
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    completeChat.mockReset();
    completeJson.mockReset();
    streamText.mockReset();
    database = new DatabaseService();
    projects = new ProjectsService(database);
    const memory = new MemoryService(database, { embeddings: async (texts: string[]) => texts.map(() => [0, 1, 0, 1]) } as never);
    const ai = { completeChat, completeJson, streamText } as unknown as AiRunnerService;
    episodes = new EpisodesService(database, projects, memory, ai);
    editor = new EditorAiService(database, episodes, memory, ai);
    tools = new ChatEpisodeToolsService(database, episodes, editor);
    projectId = projects.createInternal({
      title: '문 앞에서', logline: '기억을 읽는 기록관', genreTags: ['판타지'],
      writingDirection: '하린의 1인칭 시점과 절제된 문체를 유지한다.',
    }).id;
    messageId = parentMessage('first-turn');
  });

  afterEach(() => {
    database.onApplicationShutdown();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  function parentMessage(clientMessageId: string, owner = projectId) {
    const stamp = new Date().toISOString();
    const assistantId = `${owner}-${clientMessageId}-assistant`;
    database.orm.insert(chatMessages).values([
      { id: `${owner}-${clientMessageId}-user`, projectId: owner, clientMessageId, role: 'user', content: '회차를 작성해 줘', status: 'COMPLETE', createdAt: stamp },
      { id: assistantId, projectId: owner, clientMessageId, role: 'assistant', content: '', status: 'PENDING', createdAt: stamp },
    ]).run();
    return assistantId;
  }

  async function call(name: string, args: unknown, parent = messageId) {
    return await tools.call(projectId, parent, name, JSON.stringify(args)) as ChatEpisodeTask;
  }

  function writeAnswer(content: string) {
    streamText.mockImplementationOnce(async (_input: unknown, onDelta: (text: string) => void) => {
      onDelta(content);
      return { runId: 'write-run', result: { content, toolCalls: [], usage: {}, model: 'test/writer' } };
    });
    completeJson.mockResolvedValueOnce({ value: { issues: [] } });
  }

  it('plans and refines through the same direction services without allocating an episode', async () => {
    const plan = { title: '문 너머의 기억', direction: '문을 열어 동료의 기억을 읽는다.', conflicts: [] };
    completeJson.mockResolvedValueOnce({ value: plan });
    const first = await call('plan_episode', { instruction: '동료와 재회하는 회차를 구상해 줘', title: null, direction: null });
    expect(first).toMatchObject({ kind: 'DIRECTION', status: 'COMPLETE', episodeId: null, title: plan.title, direction: plan.direction });
    expect(completeJson.mock.calls[0]![0]).toMatchObject({
      task: 'episode_direction', promptId: 'episode-direction', projectId,
      variables: { user_request: '동료와 재회하는 회차를 구상해 줘', writing_direction: '하린의 1인칭 시점과 절제된 문체를 유지한다.' },
    });
    const refined = { ...plan, direction: '문 너머의 동료가 검을 겨누는 장면으로 끝낸다.' };
    completeJson.mockResolvedValueOnce({ value: refined });
    const second = await call('plan_episode', { instruction: '마지막 장면을 긴장되게 바꿔 줘', title: plan.title, direction: plan.direction }, parentMessage('refine-turn'));
    expect(second).toMatchObject({ status: 'COMPLETE', title: refined.title, direction: refined.direction });
    expect(completeJson.mock.calls[1]![0]).toMatchObject({
      task: 'episode_direction_refine', promptId: 'episode-direction-refine', projectId,
      variables: { episode_title: plan.title, episode_direction: plan.direction, refinement_instruction: '마지막 장면을 긴장되게 바꿔 줘' },
    });
    expect(episodes.list(projectId)).toEqual([]);
    expect(projects.get(projectId).nextEpisodeNumber).toBe(1);
    expect(tools.history(projectId, messageId)).toEqual([first]);
  });

  it('streams the usual writing and continuity review stages, preserving the exact draft and blocking issues', async () => {
    const content = '\n  문이 열렸다.\n\n“하린?” 😀\n';
    const issue = { category: 'CANON', severity: 'BLOCKING', excerpt: '문이 열렸다.', explanation: '봉인을 풀지 않았다.', evidenceRefs: [], repairInstruction: '봉인을 먼저 푼다.' };
    writeAnswer(content);
    completeJson.mockReset();
    completeJson.mockResolvedValueOnce({ value: { issues: [issue] } });
    const events: ConversationStreamEvent<ChatHistory>[] = [];
    const task = await tools.call(projectId, messageId, 'write_episode', JSON.stringify({ ...writeInput, targetChars: 3500 }), undefined, (event) => events.push(event)) as ChatEpisodeTask;

    expect(task).toMatchObject({ kind: 'WRITE', status: 'COMPLETE', content, blocked: true, issues: [issue] });
    expect(task.episodeId).toEqual(expect.any(String));
    expect(episodes.get(projectId, task.episodeId!)).toMatchObject({ title: writeInput.title, direction: writeInput.direction, content, status: 'NEEDS_REVIEW', revision: 2 });
    expect(streamText.mock.calls[0]![0]).toMatchObject({
      task: 'episode_draft', promptId: 'episode-draft', projectId, episodeId: task.episodeId, baseRevision: 1,
      variables: { target_length: 3500, writing_direction: '하린의 1인칭 시점과 절제된 문체를 유지한다.' },
    });
    expect(completeJson.mock.calls[0]![0]).toMatchObject({ task: 'continuity_review', episodeId: task.episodeId, variables: { draft_text: content } });
    const updates = events.filter((event) => event.type === 'episode_task').map((event) => event.task);
    expect(updates[0]).toMatchObject({ kind: 'WRITE', status: 'PENDING', content: '' });
    expect(updates.map((update) => update.stage)).toEqual(expect.arrayContaining(['MEMORY', 'WRITING', 'CHECKING']));
    expect(updates.at(-1)).toEqual(task);
    expect(tools.history(projectId, messageId)).toEqual([task]);
  });

  it('replays a completed write once and rejects changed arguments in the same turn', async () => {
    writeAnswer('문이 열리고 새로운 이야기가 시작되었다.');
    const task = await call('write_episode', writeInput);
    expect(await call('write_episode', writeInput)).toEqual(task);
    await expect(call('write_episode', { ...writeInput, title: '다른 제목' })).resolves.toMatchObject({ error: 'CONFLICT' });
    expect(streamText).toHaveBeenCalledTimes(1);
    expect(episodes.list(projectId)).toHaveLength(1);
    expect(projects.get(projectId).nextEpisodeNumber).toBe(2);
  });

  it('uses editing AI history and the existing explicit apply flow for chat edit previews', async () => {
    const episode = await episodes.create(projectId, { title: '닫힌 문', direction: '비밀을 찾는다.', content: original });
    completeChat.mockImplementationOnce(async (input) => {
      expect(input.variables.episode_context.editingMode).toBe('AUTO');
      expect(input.variables.episode_context.selection).toEqual({ start: original.length, end: original.length, text: '' });
      await input.readTool('replace_text', JSON.stringify({ title: '반응 수정', original: passage, replacement }));
      return { runId: 'edit-run', value: { reply: '하린의 반응을 구체적으로 다듬었어요.' } };
    });
    const args = { episodeId: episode.id, expectedRevision: episode.revision, instruction: '하린의 반응에 긴장감을 높여 줘' };
    const task = await call('edit_episode', args);
    const history = editor.history(projectId, episode.id);
    expect(task).toMatchObject({ kind: 'EDIT', status: 'COMPLETE', episodeId: episode.id, editorMessage: history.messages[1] });
    expect(task.editorMessage?.edit).toMatchObject({ original: passage, replacement, status: 'PENDING', baseRevision: episode.revision });
    expect(history.messages[0]?.request).toMatchObject({ content: args.instruction, expectedRevision: episode.revision });
    expect(episodes.get(projectId, episode.id)).toMatchObject({ content: original, revision: episode.revision });
    expect(completeChat.mock.calls[0]![0]).toMatchObject({ modelRole: 'WRITING', promptId: 'episode-editor', episodeId: episode.id });

    const applied = editor.apply(projectId, episode.id, task.editorMessage!.id);
    expect(applied.episode).toMatchObject({ content: original.replace(passage, replacement), revision: episode.revision + 1 });
    expect(tools.history(projectId, messageId)[0]?.editorMessage?.edit?.status).toBe('APPLIED');
    expect((await call('edit_episode', args)).editorMessage?.edit?.status).toBe('APPLIED');
    expect(completeChat).toHaveBeenCalledTimes(1);
    expect(editor.history(projectId, episode.id).messages).toHaveLength(2);
  });

  it('keeps child results in execution order when the same turn writes then edits a draft', async () => {
    writeAnswer(original);
    const written = await call('write_episode', writeInput);
    completeChat.mockImplementationOnce(async (input) => {
      await input.readTool('replace_text', JSON.stringify({ title: '긴장감 높이기', original: passage, replacement }));
      return { runId: 'edit-written-run', value: { reply: '수정안을 준비했습니다.' } };
    });
    const edited = await call('edit_episode', { episodeId: written.episodeId, expectedRevision: 2, instruction: '긴장감을 높여 줘' });
    expect(edited.status).toBe('COMPLETE');
    expect(tools.history(projectId, messageId).map((task) => task.kind)).toEqual(['WRITE', 'EDIT']);
    expect(tools.recoveryContext(projectId, messageId).map((task) => task.kind)).toEqual(['WRITE', 'EDIT']);
  });

  it('rejects another project’s episode, a stale revision and a foreign parent turn before AI work', async () => {
    const otherId = projects.createInternal({ title: '다른 작품', logline: '다른 세계', genreTags: ['SF'] }).id;
    const foreign = await episodes.create(otherId, { title: '다른 회차', direction: '다른 이야기', content: original });
    const local = await episodes.create(projectId, { title: '현재 회차', direction: '문을 연다.', content: original });
    await expect(call('edit_episode', { episodeId: foreign.id, expectedRevision: foreign.revision, instruction: '반응을 고쳐 줘' })).resolves.toMatchObject({ error: 'NOT_FOUND' });
    await expect(call('edit_episode', { episodeId: local.id, expectedRevision: local.revision + 1, instruction: '반응을 고쳐 줘' }, parentMessage('stale-turn'))).resolves.toMatchObject({ error: 'CONFLICT' });
    const foreignParent = parentMessage('foreign-turn', otherId);
    await expect(call('write_episode', writeInput, foreignParent)).resolves.toMatchObject({ error: 'NOT_FOUND' });
    expect(completeChat).not.toHaveBeenCalled();
    expect(streamText).not.toHaveBeenCalled();
    expect(editor.history(projectId, local.id).messages).toEqual([]);
    expect(episodes.list(projectId)).toHaveLength(1);
  });

  it('retries a failed empty draft using its allocated episode and preserves its number', async () => {
    streamText.mockRejectedValueOnce(new Error('provider temporarily unavailable'));
    await expect(call('write_episode', writeInput)).resolves.toMatchObject({ error: 'EPISODE_TASK_FAILED' });
    const failed = tools.history(projectId, messageId)[0]!;
    expect(failed).toMatchObject({ kind: 'WRITE', status: 'FAILED', content: '' });
    expect(episodes.get(projectId, failed.episodeId!)).toMatchObject({ content: '', status: 'INCOMPLETE', number: 1 });
    writeAnswer('다시 시도한 문이 열렸다.');
    const retried = await call('write_episode', writeInput);
    expect(retried).toMatchObject({ id: failed.id, episodeId: failed.episodeId, status: 'COMPLETE', content: '다시 시도한 문이 열렸다.' });
    expect(episodes.list(projectId)).toHaveLength(1);
    expect(projects.get(projectId).nextEpisodeNumber).toBe(2);
    expect(streamText).toHaveBeenCalledTimes(2);
  });

  it('retains a partial draft for review after failure and refuses to overwrite it on retry', async () => {
    const partial = '\n작성 중이던 본문. 😀\n';
    streamText.mockImplementationOnce(async (_input: unknown, onDelta: (text: string) => void) => {
      onDelta(partial);
      throw new Error('connection lost');
    });
    await expect(call('write_episode', writeInput)).resolves.toMatchObject({ error: 'EPISODE_TASK_FAILED' });
    const failed = tools.history(projectId, messageId)[0]!;
    expect(failed).toMatchObject({ kind: 'WRITE', status: 'FAILED', content: partial });
    const saved = episodes.get(projectId, failed.episodeId!);
    expect(saved).toMatchObject({ content: partial, status: 'NEEDS_REVIEW' });
    await expect(call('write_episode', writeInput)).resolves.toMatchObject({ error: 'CONFLICT' });
    expect(episodes.get(projectId, failed.episodeId!)).toEqual(saved);
    expect(episodes.list(projectId)).toHaveLength(1);
    expect(streamText).toHaveBeenCalledTimes(1);
  });

  it('preserves a concurrent manual edit when a failing writer tries to save partial text', async () => {
    streamText.mockImplementationOnce(async (input, onDelta: (text: string) => void) => {
      const episode = episodes.get(projectId, input.episodeId);
      episodes.updateSavedDraft(projectId, episode.id, { expectedRevision: episode.revision, content: '사용자가 직접 쓴 새 본문.' });
      onDelta('이 부분 초안으로 덮어쓰면 안 된다.');
      throw new Error('connection lost');
    });
    await expect(call('write_episode', writeInput)).resolves.toMatchObject({ error: 'EPISODE_TASK_FAILED' });
    const [saved] = episodes.list(projectId);
    expect(saved).toMatchObject({ content: '사용자가 직접 쓴 새 본문.', revision: 2, status: 'DRAFT' });
    await expect(call('write_episode', writeInput)).resolves.toMatchObject({ error: 'CONFLICT' });
    expect(episodes.list(projectId)).toEqual([saved]);
    expect(streamText).toHaveBeenCalledTimes(1);
  });

  it('propagates cancellation and keeps the already streamed manuscript for review', async () => {
    const controller = new AbortController();
    const partial = '중단하기 전에 작성된 본문.';
    streamText.mockImplementationOnce(async (_input: unknown, onDelta: (text: string) => void) => {
      onDelta(partial);
      controller.abort();
      return { runId: 'cancelled-write', result: { content: partial, toolCalls: [], usage: {}, model: 'test/writer' } };
    });
    await expect(tools.call(projectId, messageId, 'write_episode', JSON.stringify(writeInput), controller.signal)).rejects.toThrow();
    const task = tools.history(projectId, messageId)[0]!;
    expect(task).toMatchObject({ kind: 'WRITE', status: 'FAILED', content: partial, error: '회차 작업이 중단되었습니다.' });
    expect(episodes.get(projectId, task.episodeId!)).toMatchObject({ content: partial, status: 'NEEDS_REVIEW' });
    expect(completeJson).not.toHaveBeenCalled();
  });

  it('recovers interrupted task history at startup while preserving completed tasks and saved manuscripts', async () => {
    writeAnswer('완료한 회차 본문.');
    const completed = await call('write_episode', writeInput);
    const interruptedParent = parentMessage('interrupted-turn');
    const partial = '중단된 다음 회차의 본문.';
    streamText.mockImplementationOnce(async (_input: unknown, onDelta: (text: string) => void) => {
      onDelta(partial);
      throw new Error('interrupted writer');
    });
    await call('write_episode', writeInput, interruptedParent);
    const [row] = database.orm.select().from(chatEpisodeTasks).where(eq(chatEpisodeTasks.messageId, interruptedParent)).all();
    const interrupted = { ...JSON.parse(row!.taskJson), status: 'PENDING', error: null };
    database.orm.update(chatEpisodeTasks).set({ status: 'PENDING', taskJson: JSON.stringify(interrupted) }).where(eq(chatEpisodeTasks.id, row!.id)).run();
    const before = episodes.list(projectId);

    const restarted = new ChatEpisodeToolsService(database, episodes, editor);
    restarted.onModuleInit();

    expect(restarted.history(projectId, messageId)).toEqual([completed]);
    expect(restarted.history(projectId, interruptedParent)).toEqual([expect.objectContaining({
      id: interrupted.id, episodeId: interrupted.episodeId, status: 'FAILED', content: partial, error: expect.stringContaining('서버가 재시작'),
    })]);
    expect(episodes.list(projectId)).toEqual(before);
    expect(episodes.get(projectId, interrupted.episodeId)).toMatchObject({ content: partial, status: 'NEEDS_REVIEW' });
  });

  it('saves the checkpointed partial draft after a process crash and prevents retries from discarding it', async () => {
    const episode = await episodes.create(projectId, { ...writeInput, incomplete: true });
    const partial = '프로세스가 중단되기 전에 기록된 본문.';
    const task = { id: 'crashed-write', projectId, messageId, kind: 'WRITE', status: 'PENDING',
      episodeId: episode.id, title: episode.title, direction: episode.direction, content: partial,
      error: null, editorMessage: null, issues: [], blocked: false, baseRevision: episode.revision };
    database.orm.insert(chatEpisodeTasks).values({ id: task.id, projectId, messageId, kind: task.kind,
      requestJson: JSON.stringify(writeInput), status: task.status, taskJson: JSON.stringify(task) }).run();

    const restarted = new ChatEpisodeToolsService(database, episodes, editor);
    restarted.onModuleInit();

    expect(episodes.get(projectId, episode.id)).toMatchObject({ content: partial, status: 'NEEDS_REVIEW', revision: 2 });
    expect(restarted.history(projectId, messageId)[0]).toMatchObject({ status: 'FAILED', content: partial, blocked: true });
    await expect(restarted.call(projectId, messageId, 'write_episode', JSON.stringify(writeInput)))
      .resolves.toMatchObject({ error: 'CONFLICT' });
    expect(restarted.history(projectId, messageId)[0]?.content).toBe(partial);
    expect(episodes.list(projectId)).toHaveLength(1);
    expect(streamText).not.toHaveBeenCalled();
  });
});
