import { BadGatewayException, BadRequestException, ConflictException, Logger, NotFoundException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { EditorAiInput } from '@paranovel/contracts';
import { AiRunnerService } from '../src/ai/ai-runner.service';
import type { CompletionRequest } from '../src/ai/ai.types';
import { DatabaseService } from '../src/database/database.service';
import { chatMessages, editorAiMessages, episodeSummaries } from '../src/database/schema';
import { EditorAiService } from '../src/episodes/editor-ai.service';
import { EpisodesService } from '../src/episodes/episodes.service';
import { MemoryService } from '../src/memory/memory.service';
import { ProjectsService } from '../src/projects/projects.service';
import { PromptRegistryService } from '../src/prompts/prompt-registry.service';

describe('episode editing AI', () => {
  let database: DatabaseService;
  let projects: ProjectsService;
  let episodes: EpisodesService;
  let memory: MemoryService;
  let editor: EditorAiService;
  let projectId: string;
  let episodeId: string;
  const original = '앞 문장.\n하린은 😀 숨을 삼켰다.\n뒤 문장.';
  const selected = '하린은 😀 숨을 삼켰다.';
  const replacement = '하린의 손끝이 차갑게 굳었다.';
  const completeChat = vi.fn();

  beforeEach(async () => {
    vi.stubEnv('DB_PATH', ':memory:');
    vi.stubEnv('OPENROUTER_EMBEDDING_DIMENSIONS', '4');
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    completeChat.mockReset();
    database = new DatabaseService();
    projects = new ProjectsService(database);
    memory = new MemoryService(database, { embeddings: async (texts: string[]) => texts.map(() => [0, 1, 0, 1]) } as never);
    const ai = { completeChat } as unknown as AiRunnerService;
    episodes = new EpisodesService(database, projects, memory, ai);
    editor = new EditorAiService(database, episodes, memory, ai);
    projectId = projects.createInternal({ title: '문 앞에서', logline: '기억을 읽는 기록관', genreTags: ['판타지'] }).id;
    episodeId = (await episodes.create(projectId, { title: '닫힌 문', direction: '비밀을 찾는다.', content: original })).id;
  });

  afterEach(() => { database.onApplicationShutdown(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

  function request(overrides: Partial<EditorAiInput> = {}): EditorAiInput {
    return {
      content: '선택한 문장의 긴장감을 높여줘', clientMessageId: 'first-turn', expectedRevision: 1,
      selection: { start: original.indexOf(selected), end: original.indexOf(selected) + selected.length, text: selected },
      ...overrides,
    };
  }

  function answer(text = replacement) {
    completeChat.mockImplementationOnce(async (input) => {
      await input.readTool(input.readTools[0].function.name, JSON.stringify({ title: '긴장감을 높인 문장', replacement: text }));
      return { runId: 'edit-run', value: { reply: '인물의 반응을 구체적으로 다듬었어요.' } };
    });
  }

  it('stages an exact Korean/emoji selection, then applies it once with normal memory invalidation', async () => {
    database.orm.insert(episodeSummaries).values({ episodeId, synopsis: '이전 기억', eventsJson: '[]', emotionalChangesJson: '[]',
      foreshadowingIntroducedJson: '[]', foreshadowingResolvedJson: '[]', sourceRevision: 1, sourceHash: 'old', updatedAt: new Date().toISOString() }).run();
    answer();
    const history = await editor.send(projectId, episodeId, request());
    const message = history.messages[1]!;
    expect(message.edit).toMatchObject({ start: request().selection.start, end: request().selection.end, original: selected, replacement, status: 'PENDING', baseRevision: 1 });
    expect(episodes.get(projectId, episodeId).content).toBe(original);
    expect(completeChat.mock.calls[0]![0]).toMatchObject({ modelRole: 'WRITING', episodeId, promptId: 'episode-editor' });
    expect(completeChat.mock.calls[0]![0].variables.episode_context.selection).toEqual(request().selection);
    const applied = editor.apply(projectId, episodeId, message.id);
    expect(applied.episode.content).toBe(original.replace(selected, replacement));
    expect(applied.episode.revision).toBe(2);
    expect(applied.message.edit?.status).toBe('APPLIED');
    expect(applied.episode.summary).toMatchObject({ sourceRevision: 1, stale: true });
    expect(editor.apply(projectId, episodeId, message.id)).toEqual(applied);
    expect(await editor.send(projectId, episodeId, request())).toEqual(editor.history(projectId, episodeId));
    expect(completeChat).toHaveBeenCalledTimes(1);
  });

  it('supports dialogue without edits and refines the previous proposal with its application state', async () => {
    answer();
    const first = await editor.send(projectId, episodeId, request());
    answer('하린은 움찔했다.');
    await editor.send(projectId, episodeId, request({ clientMessageId: 'shorter', content: '좀 더 짧게' }));
    const followup = completeChat.mock.calls.at(-1)![0].history;
    expect(JSON.stringify(followup)).toContain(replacement);
    expect(JSON.stringify(followup)).toContain('PENDING');
    editor.apply(projectId, episodeId, first.messages[1]!.id);
    completeChat.mockResolvedValueOnce({ runId: 'discussion', value: { reply: '다음 장면에서는 문 안쪽의 소리로 갈등을 이어갈 수 있어요.' } });
    const current = episodes.get(projectId, episodeId);
    const result = await editor.send(projectId, episodeId, request({ content: '다음 전개는 어떻게 할까?', clientMessageId: 'discuss', expectedRevision: current.revision,
      selection: { start: current.content.length, end: current.content.length, text: '' } }));
    expect(result.messages.at(-1)?.edit).toBeNull();
    expect(JSON.stringify(completeChat.mock.calls.at(-1)![0].history)).toContain('APPLIED');
    expect(episodes.get(projectId, episodeId)).toEqual(current);
  });

  it('writes into an empty episode and inserts at an explicit cursor without changing the suffix', async () => {
    const empty = await episodes.create(projectId, { title: '첫 장면', direction: '', content: '' });
    answer('첫 문장.');
    const written = await editor.send(projectId, empty.id, request({ selection: { start: 0, end: 0, text: '' } }));
    expect(completeChat.mock.calls[0]![0].readTools[0].function.name).toBe('insert_at_cursor');
    expect(editor.apply(projectId, empty.id, written.messages[1]!.id).episode.content).toBe('첫 문장.');
    answer('새 장면.\n');
    const inserted = await editor.send(projectId, episodeId, request({ selection: { start: 6, end: 6, text: '' } }));
    expect(editor.apply(projectId, episodeId, inserted.messages[1]!.id).episode.content).toBe(original.slice(0, 6) + '새 장면.\n' + original.slice(6));
  });

  it('allows explicit deletion of a selected passage', async () => {
    answer('');
    const result = await editor.send(projectId, episodeId, request());
    expect(editor.apply(projectId, episodeId, result.messages[1]!.id).episode.content).toBe(original.replace(selected, ''));
  });

  it('isolates history from other episodes and project chat, and rejects foreign ownership', async () => {
    answer();
    const first = await editor.send(projectId, episodeId, request());
    const otherEpisode = await episodes.create(projectId, { title: '다른 회차', direction: '', content: '다른 원고' });
    expect(editor.history(projectId, otherEpisode.id).messages).toEqual([]);
    expect(database.orm.select().from(chatMessages).all()).toEqual([]);
    expect(() => editor.apply(projectId, otherEpisode.id, first.messages[1]!.id)).toThrow(NotFoundException);
    const foreign = projects.createInternal({ title: '다른 작품', logline: '다른 이야기', genreTags: ['SF'] }).id;
    expect(() => editor.history(foreign, episodeId)).toThrow(NotFoundException);
    expect(() => editor.apply(foreign, episodeId, first.messages[1]!.id)).toThrow(NotFoundException);
    await expect(editor.send(foreign, episodeId, request())).rejects.toThrow(NotFoundException);
    completeChat.mockResolvedValueOnce({ runId: 'other', value: { reply: '새 회차입니다.' } });
    await editor.send(projectId, otherEpisode.id, request({ content: '새 회차를 구상해줘', selection: { start: 0, end: 0, text: '' } }));
    expect(JSON.stringify(completeChat.mock.calls.at(-1)![0].history)).not.toContain(selected);
  });

  it('rejects stale revisions, forged ranges, split surrogate pairs and altered idempotent requests', async () => {
    await expect(editor.send(projectId, episodeId, request({ expectedRevision: 2 }))).rejects.toThrow(ConflictException);
    await expect(editor.send(projectId, episodeId, request({ selection: { start: 0, end: 3, text: selected } }))).rejects.toThrow(BadRequestException);
    const emoji = original.indexOf('😀');
    await expect(editor.send(projectId, episodeId, request({ selection: { start: emoji + 1, end: emoji + 1, text: '' } }))).rejects.toThrow(BadRequestException);
    expect(editor.history(projectId, episodeId).messages).toEqual([]);
    answer();
    const history = await editor.send(projectId, episodeId, request());
    await expect(editor.send(projectId, episodeId, request({ content: '다른 요청' }))).rejects.toThrow(ConflictException);
    await episodes.update(projectId, episodeId, { expectedRevision: 1, content: `추가한 문장. ${original}` });
    expect(() => editor.apply(projectId, episodeId, history.messages[1]!.id)).toThrow(ConflictException);
    expect(episodes.get(projectId, episodeId).content).toBe(`추가한 문장. ${original}`);
    expect(editor.history(projectId, episodeId).messages[1]!.edit?.status).toBe('PENDING');
  });

  it('keeps edits unapplied if the manuscript changes while the model is replying', async () => {
    completeChat.mockImplementationOnce(async (input) => {
      await input.readTool('replace_selection', JSON.stringify({ title: '이전 원고의 수정안', replacement }));
      await episodes.update(projectId, episodeId, { expectedRevision: 1, content: '직접 고친 원고' });
      return { runId: 'late', value: { reply: '수정안을 준비했어요.' } };
    });
    const result = await editor.send(projectId, episodeId, request());
    expect(() => editor.apply(projectId, episodeId, result.messages[1]!.id)).toThrow(ConflictException);
    expect(episodes.get(projectId, episodeId).content).toBe('직접 고친 원고');
  });

  it('rejects unknown tools and range overrides while permitting one valid edit', async () => {
    completeChat.mockImplementationOnce(async (input) => {
      expect(await input.readTool('delete_episode', '{}')).toHaveProperty('error');
      expect(await input.readTool('replace_selection', JSON.stringify({ title: '전체 변경', replacement, start: 0, end: original.length }))).toHaveProperty('error');
      expect(await input.readTool('replace_selection', '{invalid')).toHaveProperty('error');
      expect(await input.readTool('replace_selection', JSON.stringify({ title: '그대로', replacement: selected }))).toHaveProperty('error');
      expect(await input.readTool('replace_selection', JSON.stringify({ title: '선택문 수정', replacement }))).toHaveProperty('status', 'PREVIEW_READY');
      expect(await input.readTool('replace_selection', JSON.stringify({ title: '중복 수정', replacement: '다른 문장' }))).toHaveProperty('error');
      return { runId: 'tools', value: { reply: '선택문만 다듬었어요.' } };
    });
    const history = await editor.send(projectId, episodeId, request());
    expect(history.messages[1]!.edit?.replacement).toBe(replacement);
    expect(episodes.get(projectId, episodeId).content).toBe(original);
  });

  it('rejects overlapping sends and retries a failed turn without duplicating history', async () => {
    let fail!: (error: Error) => void;
    completeChat.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
    const pending = editor.send(projectId, episodeId, request());
    const failure = expect(pending).rejects.toThrow(BadGatewayException);
    await vi.waitFor(() => expect(fail).toBeDefined());
    await expect(editor.send(projectId, episodeId, request({ clientMessageId: 'overlapping' }))).rejects.toThrow(ConflictException);
    fail(new Error('Temporary provider failure'));
    await failure;
    expect(editor.history(projectId, episodeId).messages[1]?.status).toBe('FAILED');
    answer();
    const retried = await editor.send(projectId, episodeId, request());
    expect(retried.messages).toHaveLength(2);
    expect(retried.messages[1]?.status).toBe('COMPLETE');
  });

  it('discards staged edits on abort and makes interrupted turns retryable at startup', async () => {
    const controller = new AbortController();
    completeChat.mockImplementationOnce(async (input) => {
      await input.readTool('replace_selection', JSON.stringify({ title: '취소될 수정', replacement }));
      controller.abort();
      return { runId: 'aborted', value: { reply: '취소된 답변' } };
    });
    await expect(editor.send(projectId, episodeId, request(), controller.signal)).rejects.toThrow(BadGatewayException);
    expect(editor.history(projectId, episodeId).messages[1]).toMatchObject({ status: 'FAILED', edit: null });
    database.orm.update(editorAiMessages).set({ status: 'PENDING' }).where(eq(editorAiMessages.role, 'assistant')).run();
    editor.onModuleInit();
    expect(editor.history(projectId, episodeId).messages[1]?.status).toBe('FAILED');
    expect(episodes.get(projectId, episodeId).content).toBe(original);
  });

  it('places a retried older request after later completed discussion in the model context', async () => {
    completeChat.mockRejectedValueOnce(new Error('Temporary failure'));
    await expect(editor.send(projectId, episodeId, request())).rejects.toThrow(BadGatewayException);
    completeChat.mockResolvedValueOnce({ runId: 'discussion', value: { reply: '다음 장면의 전개를 함께 고민해 볼게요.' } });
    await editor.send(projectId, episodeId, request({ clientMessageId: 'later-turn', content: '다음 장면은 어떻게 할까?' }));
    answer();
    await editor.send(projectId, episodeId, request());
    const context = completeChat.mock.calls.at(-1)![0].history;
    expect(JSON.parse(context.at(-1).content).request).toBe(request().content);
    expect(context.filter((message: { content: string }) => message.content.includes(request().content))).toHaveLength(1);
    expect(context[0].content).toContain('다음 장면은 어떻게 할까?');
  });

  it('rolls back manuscript changes if persisting the application receipt fails', async () => {
    answer();
    const result = await editor.send(projectId, episodeId, request());
    database.connection.exec("CREATE TRIGGER fail_editor_receipt BEFORE UPDATE OF applied_at ON editor_ai_messages BEGIN SELECT RAISE(ABORT, 'receipt failure'); END;");
    expect(() => editor.apply(projectId, episodeId, result.messages[1]!.id)).toThrow('receipt failure');
    expect(episodes.get(projectId, episodeId)).toMatchObject({ content: original, revision: 1 });
    expect(editor.history(projectId, episodeId).messages[1]?.edit?.status).toBe('PENDING');
  });

  it('runs real tool orchestration with the writing model, prompt context and enough tokens for prose', async () => {
    vi.stubEnv('AI_WRITING_MODEL', 'test/writer');
    vi.stubEnv('AI_CHAT_MODEL', 'test/project-chat');
    const complete = vi.fn(async (input: CompletionRequest) => {
      if (input.tools && !input.messages.some((message) => message.role === 'tool')) return {
        model: input.model, usage: {}, content: '',
        toolCalls: [{ id: 'edit-call', type: 'function', function: { name: 'replace_selection', arguments: JSON.stringify({ title: '긴장감', replacement }) } }],
      };
      return { model: input.model, usage: {}, content: JSON.stringify({ reply: '선택한 부분의 수정안을 준비했어요.' }), toolCalls: [] };
    });
    const runner = new AiRunnerService(database, new PromptRegistryService(), { complete } as never, { isConfigured: () => false } as never);
    const integrated = new EditorAiService(database, episodes, memory, runner);
    const result = await integrated.send(projectId, episodeId, request());
    expect(result.messages[1]?.edit?.replacement).toBe(replacement);
    expect(complete.mock.calls.every(([input]) => input.model === 'test/writer')).toBe(true);
    expect(complete.mock.calls[0]![0].maxTokens).toBe(16_000);
    expect(complete.mock.calls[0]![0].messages[0]?.content).toContain('편집 AI');
    expect(complete.mock.calls.at(-1)![0].messages.some((message) => message.role === 'tool' && message.content?.includes('PREVIEW_READY'))).toBe(true);
    expect(database.connection.prepare('SELECT model, status FROM ai_runs').get()).toEqual({ model: 'test/writer', status: 'SUCCEEDED' });
  });
});
