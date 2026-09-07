import { BadGatewayException, BadRequestException, ConflictException, Logger, NotFoundException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { ConversationStreamEvent, EditorAiHistory, EditorAiInput } from '@paranovel/contracts';
import { AiRunnerService } from '../src/ai/ai-runner.service';
import type { CompletionRequest } from '../src/ai/ai.types';
import { DatabaseService } from '../src/database/database.service';
import { chatMessages, editorAiMessages, episodeSummaries } from '../src/database/schema';
import { EditorAiService } from '../src/episodes/editor-ai.service';
import { EpisodesService } from '../src/episodes/episodes.service';
import { MemoryService } from '../src/memory/memory.service';
import { ProjectsService } from '../src/projects/projects.service';
import { PromptRegistryService } from '../src/prompts/prompt-registry.service';
import { SideStoriesService } from '../src/side-stories/side-stories.service';

describe('episode editing AI', () => {
  let database: DatabaseService;
  let projects: ProjectsService;
  let episodes: EpisodesService;
  let memory: MemoryService;
  let editor: EditorAiService;
  let sideStories: SideStoriesService;
  let projectId: string;
  let episodeId: string;
  const original = '앞 문장.\n하린은 😀 숨을 삼켰다.\n뒤 문장.';
  const selected = '하린은 😀 숨을 삼켰다.';
  const replacement = '하린의 손끝이 차갑게 굳었다.';
  const completeChat = vi.fn();
  const completeJson = vi.fn();

  beforeEach(async () => {
    vi.stubEnv('DB_PATH', ':memory:');
    vi.stubEnv('OPENROUTER_EMBEDDING_DIMENSIONS', '4');
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    completeChat.mockReset();
    completeJson.mockReset();
    database = new DatabaseService();
    projects = new ProjectsService(database);
    memory = new MemoryService(database, { embeddings: async (texts: string[]) => texts.map(() => [0, 1, 0, 1]) } as never);
    const ai = { completeChat, completeJson } as unknown as AiRunnerService;
    episodes = new EpisodesService(database, projects, memory, ai);
    editor = new EditorAiService(database, episodes, memory, ai);
    sideStories = new SideStoriesService(database, memory);
    projectId = projects.createInternal({
      title: '문 앞에서', logline: '기억을 읽는 기록관', genreTags: ['판타지'],
      writingDirection: '하린의 1인칭 시점과 절제된 문체를 유지한다.',
    }).id;
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

  async function groupedSideStory(withPredecessor = false) {
    const group = sideStories.createGroup(projectId, {
      title: '문 너머의 기록',
      description: '분기점에서 시작한 외전',
      branchFromEpisodeId: episodeId,
      canon: '이 외전에서는 문이 기억을 보관한다.',
      arc: {
        title: '잃어버린 기록',
        goal: '사라진 기억을 되찾는다.',
        conflict: '문이 기억을 돌려주지 않는다.',
        endEpisodeNumber: 3,
        reversalPlan: [],
      },
    });
    const predecessor = withPredecessor
      ? await sideStories.create(projectId, {
          title: '외전의 분기 기억',
          direction: '문에 남은 기억을 조사한다.',
          content: '문에는 먼저 다녀간 사람의 기억이 남아 있었다.',
          groupId: group.id,
          branchFromEpisodeId: null,
        })
      : undefined;
    const target = await sideStories.create(projectId, {
      title: '외전 첫 장면',
      direction: '문 너머로 들어간다.',
      content: original,
      groupId: group.id,
      branchFromEpisodeId: null,
    });
    return { group, predecessor, target };
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
    expect(completeChat.mock.calls[0]![0].variables.writing_direction).toBe('하린의 1인칭 시점과 절제된 문체를 유지한다.');
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

  it('lets the AI choose an exact passage without a selection and only changes it after acceptance', async () => {
    const unselected = request({ content: '하린의 반응에 긴장감을 높여줘', selection: { start: original.length, end: original.length, text: '' } });
    completeChat.mockImplementationOnce(async (input) => {
      expect(input.variables.episode_context.editingMode).toBe('AUTO');
      expect(input.readTools.map((tool: { function: { name: string } }) => tool.function.name)).toEqual(['insert_at_cursor', 'replace_text', 'read_manuscript']);
      expect(await input.readTool('replace_text', JSON.stringify({ title: '반응 수정', original: selected, replacement }))).toMatchObject({
        status: 'PREVIEW_READY', start: original.indexOf(selected), end: original.indexOf(selected) + selected.length,
      });
      expect(await input.readTool('replace_text', JSON.stringify({ title: '중복 수정', original: selected, replacement: '새 문장' }))).toHaveProperty('error');
      return { runId: 'auto-range', value: { reply: '하린의 반응을 다듬는 수정안을 준비했어요.' } };
    });
    const history = await editor.send(projectId, episodeId, unselected);
    const message = history.messages[1]!;
    expect(message.edit).toEqual({ title: '반응 수정', start: original.indexOf(selected), end: original.indexOf(selected) + selected.length,
      original: selected, replacement, baseRevision: 1, status: 'PENDING' });
    expect(episodes.get(projectId, episodeId)).toMatchObject({ content: original, revision: 1 });
    expect(editor.history(projectId, episodeId)).toEqual(history);
    const applied = editor.apply(projectId, episodeId, message.id);
    expect(applied.episode).toMatchObject({ content: original.replace(selected, replacement), revision: 2 });
    expect(applied.message.edit?.status).toBe('APPLIED');
    expect(editor.apply(projectId, episodeId, message.id)).toEqual(applied);
    expect(await editor.send(projectId, episodeId, unselected)).toEqual(editor.history(projectId, episodeId));
    expect(completeChat).toHaveBeenCalledTimes(1);
  });

  it('rejects invented, empty, unchanged, overridden and split-character automatic ranges', async () => {
    completeChat.mockImplementationOnce(async (input) => {
      for (const args of [
        { original: '원고에 없는 문장', replacement },
        { original: '', replacement },
        { original: selected, replacement: selected },
        { original: selected, replacement, start: 0 },
        { original: '\uD83D', replacement },
        { original: '\uDE00', replacement },
      ]) {
        expect(await input.readTool('replace_text', JSON.stringify({ title: '잘못된 범위', ...args }))).toHaveProperty('error');
      }
      return { runId: 'invalid-ranges', value: { reply: '수정안을 준비하지 못했어요.' } };
    });
    const history = await editor.send(projectId, episodeId, request({ selection: { start: 0, end: 0, text: '' } }));
    expect(history.messages[1]?.edit).toBeNull();
    expect(episodes.get(projectId, episodeId)).toMatchObject({ content: original, revision: 1 });
  });

  it('combines multiple edits in manuscript order while preserving the untouched gap', async () => {
    completeChat.mockImplementationOnce(async (input) => {
      expect(input.parallelToolNames).toEqual(['read_manuscript']);
      const results = await Promise.all([
        input.readTool('replace_text', JSON.stringify({ title: '끝 문장', original: '뒤 문장.', replacement: '닫힌 문 너머에서 소리가 났다.' })),
        input.readTool('read_manuscript', JSON.stringify({ start: 0, length: original.length })),
        input.readTool('replace_text', JSON.stringify({ title: '첫 문장', original: '앞 문장.', replacement: '복도는 고요했다.' })),
      ]);
      expect(results[0]).toMatchObject({ status: 'PREVIEW_READY', editCount: 1 });
      expect(results[1]).toMatchObject({ text: original });
      expect(results[2]).toMatchObject({ status: 'PREVIEW_READY', editCount: 2 });
      return { runId: 'multiple-edits', value: { reply: '처음과 끝의 두 문장을 다듬었어요.' } };
    });
    const history = await editor.send(projectId, episodeId, request({ selection: { start: 0, end: 0, text: '' } }));
    const combined = `복도는 고요했다.\n${selected}\n닫힌 문 너머에서 소리가 났다.`;
    expect(history.messages[1]?.edit).toEqual({
      title: '2곳 수정', start: 0, end: original.length, original, replacement: combined, baseRevision: 1, status: 'PENDING',
    });
    expect(episodes.get(projectId, episodeId).content).toBe(original);
    const applied = editor.apply(projectId, episodeId, history.messages[1]!.id);
    expect(applied.episode).toMatchObject({ content: combined, revision: 2 });
    expect(editor.apply(projectId, episodeId, history.messages[1]!.id)).toEqual(applied);
  });

  it.each([0, 2, 4])('orders adjacent replacements and a boundary insertion deterministically at cursor %s', async (cursor) => {
    const content = '가나다라';
    const adjacent = await episodes.create(projectId, { title: '인접한 문장', direction: '', content });
    completeChat.mockImplementationOnce(async (input) => {
      for (const [name, args] of [
        ['replace_text', { title: '뒤 수정', original: '다라', replacement: '뒤' }],
        ['insert_at_cursor', { title: '삽입', replacement: '새' }],
        ['replace_text', { title: '앞 수정', original: '가나', replacement: '앞' }],
      ]) {
        expect(await input.readTool(name, JSON.stringify(args))).toHaveProperty('status', 'PREVIEW_READY');
      }
      return { runId: 'adjacent-edits', value: { reply: '두 부분을 다듬고 새 본문을 추가했어요.' } };
    });
    const history = await editor.send(projectId, adjacent.id, request({ selection: { start: cursor, end: cursor, text: '' } }));
    const combined = cursor === 0 ? '새앞뒤' : cursor === 2 ? '앞새뒤' : '앞뒤새';
    expect(editor.apply(projectId, adjacent.id, history.messages[1]!.id).episode.content).toBe(combined);
  });

  it('rejects nested or partially overlapping replacements without discarding valid independent edits', async () => {
    completeChat.mockImplementationOnce(async (input) => {
      await input.readTool('replace_text', JSON.stringify({ title: '반응', original: selected, replacement }));
      for (const overlapping of ['숨을 삼켰다.', original, `${selected}\n뒤 문장.`]) {
        expect(await input.readTool('replace_text', JSON.stringify({ title: '겹친 수정', original: overlapping, replacement: '겹친 문장' }))).toHaveProperty('error');
      }
      expect(await input.readTool('replace_text', JSON.stringify({ title: '끝 문장', original: '뒤 문장.', replacement: '끝.' }))).toHaveProperty('status', 'PREVIEW_READY');
      return { runId: 'overlapping-edits', value: { reply: '반응과 끝 문장을 다듬었어요.' } };
    });
    const history = await editor.send(projectId, episodeId, request({ selection: { start: 0, end: 0, text: '' } }));
    expect(editor.apply(projectId, episodeId, history.messages[1]!.id).episode.content).toBe(`앞 문장.\n${replacement}\n끝.`);
  });

  it.each([true, false])('rejects an insertion inside a replacement regardless of call order (replacement first: %s)', async (replaceFirst) => {
    const cursor = original.indexOf(selected) + 1;
    completeChat.mockImplementationOnce(async (input) => {
      const calls: [string, Record<string, string>][] = [
        ['replace_text', { title: '반응', original: selected, replacement }],
        ['insert_at_cursor', { title: '삽입', replacement: '추가' }],
      ];
      if (!replaceFirst) calls.reverse();
      expect(await input.readTool(calls[0]![0], JSON.stringify(calls[0]![1]))).toHaveProperty('status', 'PREVIEW_READY');
      expect(await input.readTool(calls[1]![0], JSON.stringify(calls[1]![1]))).toHaveProperty('error');
      return { runId: 'interior-insertion', value: { reply: '겹치지 않는 수정안만 준비했어요.' } };
    });
    const history = await editor.send(projectId, episodeId, request({ selection: { start: cursor, end: cursor, text: '' } }));
    const expected = replaceFirst ? original.replace(selected, replacement) : original.slice(0, cursor) + '추가' + original.slice(cursor);
    expect(editor.apply(projectId, episodeId, history.messages[1]!.id).episode.content).toBe(expected);
  });

  it('rejects multiple insertions at the same cursor while retaining an independent replacement', async () => {
    completeChat.mockImplementationOnce(async (input) => {
      await input.readTool('insert_at_cursor', JSON.stringify({ title: '삽입', replacement: '새 장면.\n' }));
      expect(await input.readTool('insert_at_cursor', JSON.stringify({ title: '중복 삽입', replacement: '추가 장면.\n' }))).toHaveProperty('error');
      expect(await input.readTool('replace_text', JSON.stringify({ title: '반응', original: selected, replacement }))).toHaveProperty('status', 'PREVIEW_READY');
      return { runId: 'duplicate-insertion', value: { reply: '새 장면과 반응의 수정안을 준비했어요.' } };
    });
    const history = await editor.send(projectId, episodeId, request({ selection: { start: 0, end: 0, text: '' } }));
    expect(editor.apply(projectId, episodeId, history.messages[1]!.id).episode.content).toBe('새 장면.\n' + original.replace(selected, replacement));
  });

  it('enforces the manuscript limit on the combined changes and retains the valid preview', async () => {
    const content = '앞' + '중'.repeat(999_988) + '뒤';
    const long = await episodes.create(projectId, { title: '한계 원고', direction: '', content });
    completeChat.mockImplementationOnce(async (input) => {
      expect(await input.readTool('replace_text', JSON.stringify({ title: '도입', original: '앞', replacement: '처'.repeat(6) }))).toHaveProperty('status', 'PREVIEW_READY');
      expect(await input.readTool('replace_text', JSON.stringify({ title: '끝', original: '뒤', replacement: '끝'.repeat(7) }))).toEqual({ error: '원고는 1,000,000자 이하여야 합니다.' });
      expect(await input.readTool('replace_text', JSON.stringify({ title: '끝', original: '뒤', replacement: '끝'.repeat(6) }))).toHaveProperty('status', 'PREVIEW_READY');
      expect(await input.readTool('insert_at_cursor', JSON.stringify({ title: '넘치는 삽입', replacement: '추가' }))).toEqual({ error: '원고는 1,000,000자 이하여야 합니다.' });
      return { runId: 'combined-limit', value: { reply: '분량 제한 내에서 두 부분을 다듬었어요.' } };
    });
    const history = await editor.send(projectId, long.id, request({ selection: { start: 0, end: 0, text: '' } }));
    const applied = editor.apply(projectId, long.id, history.messages[1]!.id);
    expect(applied.episode.content).toBe('처'.repeat(6) + '중'.repeat(999_988) + '끝'.repeat(6));
    expect(applied.episode.content.length).toBe(1_000_000);
  });

  it('emits the persisted message ID before forwarding streaming events and reuses it on replay', async () => {
    const events: ConversationStreamEvent<EditorAiHistory>[] = [];
    completeChat.mockImplementationOnce(async (input) => {
      expect(events).toEqual([{ type: 'start', messageId: editor.history(projectId, episodeId).messages[1]!.id }]);
      input.onEvent({ type: 'tool_start', callId: 'edit-call', name: 'replace_selection' });
      await input.readTool('replace_selection', JSON.stringify({ title: '반응', replacement }));
      input.onEvent({ type: 'tool_end', callId: 'edit-call', name: 'replace_selection' });
      input.onEvent({ type: 'delta', text: '반응을 ' });
      input.onEvent({ type: 'delta', text: '다듬었어요.' });
      return { runId: 'streaming-edit', value: { reply: '반응을 다듬었어요.' } };
    });
    const history = await editor.send(projectId, episodeId, request(), undefined, (event) => events.push(event));
    expect(events).toEqual([
      { type: 'start', messageId: history.messages[1]!.id },
      { type: 'tool_start', callId: 'edit-call', name: 'replace_selection' },
      { type: 'tool_end', callId: 'edit-call', name: 'replace_selection' },
      { type: 'delta', text: '반응을 ' }, { type: 'delta', text: '다듬었어요.' },
    ]);
    events.length = 0;
    expect(await editor.send(projectId, episodeId, request(), undefined, (event) => events.push(event))).toEqual(history);
    expect(events).toEqual([{ type: 'start', messageId: history.messages[1]!.id }]);
    expect(completeChat).toHaveBeenCalledTimes(1);
  });

  it('requires enough original context to distinguish repeated passages and replaces only the intended occurrence', async () => {
    const content = `첫 장면.\n${selected}\n중간 장면.\n${selected}\n끝 장면.`;
    const repeated = await episodes.create(projectId, { title: '반복', direction: '', content });
    const target = `중간 장면.\n${selected}`;
    completeChat.mockImplementationOnce(async (input) => {
      expect(await input.readTool('replace_text', JSON.stringify({ title: '모호한 범위', original: selected, replacement }))).toHaveProperty('error');
      expect(await input.readTool('replace_text', JSON.stringify({ title: '두 번째 반응', original: target, replacement: `중간 장면.\n${replacement}` }))).toHaveProperty('status', 'PREVIEW_READY');
      return { runId: 'repeated', value: { reply: '두 번째 반응의 수정안을 준비했어요.' } };
    });
    const history = await editor.send(projectId, repeated.id, request({ selection: { start: 0, end: 0, text: '' } }));
    expect(episodes.get(projectId, repeated.id).content).toBe(content);
    const applied = editor.apply(projectId, repeated.id, history.messages[1]!.id);
    expect(applied.episode.content).toBe(`첫 장면.\n${selected}\n중간 장면.\n${replacement}\n끝 장면.`);
  });

  it('reads omitted manuscript text with bounded, intact Unicode ranges before proposing a distant edit', async () => {
    const content = original + '\n긴 원고의 다른 장면.'.repeat(6_000);
    const long = await episodes.create(projectId, { title: '긴 원고', direction: '', content });
    completeChat.mockImplementationOnce(async (input) => {
      expect(input.variables.episode_context.omittedBefore).toBeGreaterThan(0);
      expect(input.variables.episode_context.textBefore).not.toContain(selected);
      const read = await input.readTool('read_manuscript', JSON.stringify({ start: 0, length: original.length }));
      expect(read).toEqual({ start: 0, end: original.length, text: original, totalCharacters: content.length });
      const emoji = original.indexOf('😀');
      expect(await input.readTool('read_manuscript', JSON.stringify({ start: emoji + 1, length: 1 }))).toMatchObject({ start: emoji, end: emoji + 2, text: '😀' });
      expect(await input.readTool('read_manuscript', JSON.stringify({ start: emoji, length: 1 }))).toMatchObject({ start: emoji, end: emoji + 2, text: '😀' });
      for (const range of [{ start: -1, length: 10 }, { start: content.length + 1, length: 10 }, { start: 0, length: 20_001 }]) {
        expect(await input.readTool('read_manuscript', JSON.stringify(range))).toHaveProperty('error');
      }
      await input.readTool('replace_text', JSON.stringify({ title: '도입부 수정', original: selected, replacement }));
      return { runId: 'distant', value: { reply: '도입부에서 반응을 다듬었어요. 수락하면 적용됩니다.' } };
    });
    const history = await editor.send(projectId, long.id, request({ selection: { start: content.length, end: content.length, text: '' } }));
    expect(editor.apply(projectId, long.id, history.messages[1]!.id).episode.content).toBe(content.replace(selected, replacement));
  });

  it('allows deletion of an AI-chosen passage only after acceptance', async () => {
    completeChat.mockImplementationOnce(async (input) => {
      await input.readTool('replace_text', JSON.stringify({ title: '반응 삭제', original: selected, replacement: '' }));
      return { runId: 'delete-range', value: { reply: '반응을 덜어내는 수정안을 준비했어요.' } };
    });
    const history = await editor.send(projectId, episodeId, request({ selection: { start: 0, end: 0, text: '' } }));
    expect(episodes.get(projectId, episodeId).content).toBe(original);
    expect(history.messages[1]?.edit).toMatchObject({ original: selected, replacement: '', status: 'PENDING' });
    expect(editor.apply(projectId, episodeId, history.messages[1]!.id).episode.content).toBe(original.replace(selected, ''));
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

  it.each([true, false])('keeps edits unapplied if the manuscript changes while the model is replying (selected: %s)', async (hasSelection) => {
    completeChat.mockImplementationOnce(async (input) => {
      await input.readTool(hasSelection ? 'replace_selection' : 'replace_text', JSON.stringify({ title: '이전 원고의 수정안', replacement, ...(!hasSelection && { original: selected }) }));
      await episodes.update(projectId, episodeId, { expectedRevision: 1, content: '직접 고친 원고' });
      return { runId: 'late', value: { reply: '수정안을 준비했어요.' } };
    });
    const result = await editor.send(projectId, episodeId, request(hasSelection ? {} : { selection: { start: 0, end: 0, text: '' } }));
    expect(() => editor.apply(projectId, episodeId, result.messages[1]!.id)).toThrow(ConflictException);
    expect(episodes.get(projectId, episodeId).content).toBe('직접 고친 원고');
  });

  it.each([
    ['anchor scene', ({ target }: Awaited<ReturnType<typeof groupedSideStory>>) => {
      episodes.updateScene(projectId, episodeId, { expectedRevision: 1, location: '바뀐 본편 장면' });
      expect(episodes.get(projectId, target.id).revision).toBe(1);
    }],
    ['group metadata', ({ group, target }: Awaited<ReturnType<typeof groupedSideStory>>) => {
      sideStories.updateGroup(projectId, group.id, { expectedRevision: group.revision, description: '사용자가 바꾼 설명' });
      expect(episodes.get(projectId, target.id).revision).toBe(1);
    }],
    ['target scene', ({ target }: Awaited<ReturnType<typeof groupedSideStory>>) => {
      episodes.updateScene(projectId, target.id, { expectedRevision: 1, location: '바뀐 외전 장면' });
      expect(episodes.get(projectId, target.id).revision).toBe(1);
    }],
  ])('rejects a grouped side-story preview after its %s changes without a target revision', async (_label, mutate) => {
    const context = await groupedSideStory();
    answer();
    const history = await editor.send(projectId, context.target.id, request());
    const message = history.messages[1]!;
    expect(message.edit).not.toHaveProperty('baseFlowRevision');
    const raw = database.orm.select({ editJson: editorAiMessages.editJson })
      .from(editorAiMessages).where(eq(editorAiMessages.id, message.id)).get();
    expect(JSON.parse(raw!.editJson!)).toMatchObject({ baseFlowRevision: expect.any(String) });

    mutate(context);

    expect(() => editor.apply(projectId, context.target.id, message.id)).toThrow(ConflictException);
    expect(episodes.get(projectId, context.target.id)).toMatchObject({ content: original, revision: 1 });
    expect(editor.history(projectId, context.target.id).messages[1]?.edit?.status).toBe('PENDING');
  });

  it('retains the side-story flow guard when combining edits and rejects a changed predecessor', async () => {
    const { predecessor, target } = await groupedSideStory(true);
    completeChat.mockImplementationOnce(async (input) => {
      expect(await input.readTool('replace_text', JSON.stringify({
        title: '끝 문장', original: '뒤 문장.', replacement: '문 너머에서 소리가 났다.',
      }))).toMatchObject({ status: 'PREVIEW_READY', editCount: 1 });
      expect(await input.readTool('replace_text', JSON.stringify({
        title: '첫 문장', original: '앞 문장.', replacement: '복도는 고요했다.',
      }))).toMatchObject({ status: 'PREVIEW_READY', editCount: 2 });
      return { runId: 'side-story-multiple-edits', value: { reply: '외전의 처음과 끝을 다듬었어요.' } };
    });
    const history = await editor.send(projectId, target.id, request({ selection: { start: 0, end: 0, text: '' } }));
    const message = history.messages[1]!;
    expect(message.edit).toEqual({
      title: '2곳 수정', start: 0, end: original.length, original,
      replacement: `복도는 고요했다.\n${selected}\n문 너머에서 소리가 났다.`,
      baseRevision: 1, status: 'PENDING',
    });
    const raw = database.orm.select({ editJson: editorAiMessages.editJson })
      .from(editorAiMessages).where(eq(editorAiMessages.id, message.id)).get();
    expect(JSON.parse(raw!.editJson!)).toMatchObject({ baseFlowRevision: expect.any(String) });

    episodes.updateScene(projectId, predecessor!.id, {
      expectedRevision: predecessor!.revision, location: '앞선 외전에서 바뀐 장소',
    });

    expect(() => editor.apply(projectId, target.id, message.id)).toThrow(ConflictException);
    expect(episodes.get(projectId, target.id)).toMatchObject({ content: original, revision: 1 });
    expect(editor.history(projectId, target.id).messages[1]?.edit?.status).toBe('PENDING');
  });

  it.each(['memory', 'model'] as const)('fails a grouped side-story reply when the flow changes during %s work', async (stage) => {
    const { target } = await groupedSideStory();
    let release!: () => void;
    if (stage === 'memory') {
      const assemble = memory.assemble.bind(memory);
      vi.spyOn(memory, 'assemble').mockImplementationOnce(async (...args) => {
        const result = await assemble(...args);
        await new Promise<void>((resolve) => { release = resolve; });
        return result;
      });
    } else {
      completeChat.mockImplementationOnce(async (input) => {
        await input.readTool(input.readTools[0].function.name, JSON.stringify({ title: '폐기될 수정안', replacement }));
        await new Promise<void>((resolve) => { release = resolve; });
        return { runId: 'stale-side-flow', value: { reply: '이 답변은 저장되면 안 됩니다.' } };
      });
    }

    const pending = editor.send(projectId, target.id, request());
    const rejected = expect(pending).rejects.toBeInstanceOf(ConflictException);
    await vi.waitFor(() => expect(release).toBeDefined());
    episodes.updateScene(projectId, target.id, {
      expectedRevision: target.revision,
      location: `사용자가 ${stage} 중 고친 장면`,
    });
    expect(episodes.get(projectId, target.id).revision).toBe(target.revision);
    release();
    await rejected;

    expect(editor.history(projectId, target.id).messages[1]).toMatchObject({
      status: 'FAILED',
      edit: null,
    });
    expect(episodes.get(projectId, target.id).content).toBe(original);
    expect(completeChat).toHaveBeenCalledTimes(stage === 'model' ? 1 : 0);
  });

  it('refreshes stale side-story predecessors before assembling editor context', async () => {
    const { predecessor, target } = await groupedSideStory(true);
    const extraction = (event: string) => ({
      events: [event],
      emotionalChanges: [],
      newForeshadowing: [],
      resolvedForeshadowing: [],
      endScene: {
        location: '기억의 문',
        time: null,
        pointOfView: null,
        characters: [],
        goal: null,
      },
      canonCandidates: [],
    });
    completeJson.mockResolvedValueOnce({ value: extraction('예전 분기 기억') });
    await episodes.finalize(projectId, predecessor!.id, { expectedRevision: predecessor!.revision });
    await episodes.update(projectId, predecessor!.id, {
      expectedRevision: predecessor!.revision,
      content: '사용자가 분기 기억을 고쳤다.',
    });
    expect(episodes.get(projectId, predecessor!.id)).toMatchObject({
      revision: predecessor!.revision + 1,
      status: 'MEMORY_STALE',
    });
    completeJson.mockResolvedValueOnce({ value: extraction('새로 확정한 분기 기억') });
    completeChat.mockImplementationOnce(async (input) => {
      const recent = JSON.parse(input.variables.recent_summaries) as Array<{
        episode_id: string;
        synopsis: string;
      }>;
      expect(recent).toEqual(expect.arrayContaining([
        expect.objectContaining({
          episode_id: predecessor!.id,
          synopsis: '새로 확정한 분기 기억',
        }),
      ]));
      return { runId: 'refreshed-editor-context', value: { reply: '최신 분기 기억을 반영했어요.' } };
    });

    await editor.send(projectId, target.id, request());

    expect(episodes.get(projectId, predecessor!.id).status).toBe('CONFIRMED');
    expect(completeJson).toHaveBeenCalledTimes(2);
  });

  it('rejects unknown tools and range overrides while permitting one valid edit', async () => {
    completeChat.mockImplementationOnce(async (input) => {
      expect(await input.readTool('delete_episode', '{}')).toHaveProperty('error');
      expect(await input.readTool('replace_text', JSON.stringify({ title: '선택 범위 밖 수정', original, replacement }))).toHaveProperty('error');
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

  it.each([true, false])('runs real tool orchestration with the writing model, prompt context and enough tokens for prose (selected: %s)', async (hasSelection) => {
    vi.stubEnv('AI_WRITING_MODEL', 'test/writer');
    vi.stubEnv('AI_CHAT_MODEL', 'test/project-chat');
    const complete = vi.fn(async (input: CompletionRequest) => {
      if (input.tools && !input.messages.some((message) => message.role === 'tool')) return {
        model: input.model, usage: {}, content: '',
        toolCalls: [{ id: 'edit-call', type: 'function', function: { name: hasSelection ? 'replace_selection' : 'replace_text', arguments: JSON.stringify({ title: '긴장감', replacement, ...(!hasSelection && { original: selected }) }) } }],
      };
      return { model: input.model, usage: {}, content: JSON.stringify({ reply: '선택한 부분의 수정안을 준비했어요.' }), toolCalls: [] };
    });
    const runner = new AiRunnerService(database, new PromptRegistryService(), { complete } as never, { isConfigured: () => false } as never);
    const integrated = new EditorAiService(database, episodes, memory, runner);
    const result = await integrated.send(projectId, episodeId, request(hasSelection ? {} : { selection: { start: 0, end: 0, text: '' } }));
    expect(result.messages[1]?.edit?.replacement).toBe(replacement);
    expect(complete.mock.calls.every(([input]) => input.model === 'test/writer')).toBe(true);
    expect(complete.mock.calls[0]![0].maxTokens).toBe(16_000);
    expect(complete.mock.calls[0]![0].messages[0]?.content).toContain('편집 AI');
    expect(complete.mock.calls.at(-1)![0].messages.some((message) => message.role === 'tool' && message.content?.includes('PREVIEW_READY'))).toBe(true);
    expect(database.connection.prepare('SELECT model, status FROM ai_runs').get()).toEqual({ model: 'test/writer', status: 'SUCCEEDED' });
  });

  it('stages every independent edit from one real model tool-call batch', async () => {
    const complete = vi.fn(async (input: CompletionRequest) => {
      if (input.tools && !input.messages.some((message) => message.role === 'tool')) return {
        model: input.model, usage: {}, content: '',
        toolCalls: [
          { id: 'last-sentence', type: 'function' as const, function: { name: 'replace_text', arguments: JSON.stringify({ title: '끝', original: '뒤 문장.', replacement: '발소리가 멎었다.' }) } },
          { id: 'first-sentence', type: 'function' as const, function: { name: 'replace_text', arguments: JSON.stringify({ title: '도입', original: '앞 문장.', replacement: '어둠이 짙어졌다.' }) } },
        ],
      };
      return { model: input.model, usage: {}, content: JSON.stringify({ reply: '두 문장의 수정안을 준비했어요.' }), toolCalls: [] };
    });
    const runner = new AiRunnerService(database, new PromptRegistryService(), { complete } as never, { isConfigured: () => false } as never);
    const integrated = new EditorAiService(database, episodes, memory, runner);
    const result = await integrated.send(projectId, episodeId, request({ selection: { start: 0, end: 0, text: '' } }));
    const finalRequest = complete.mock.calls.at(-1)![0];
    const results = finalRequest.messages.filter((message) => message.role === 'tool');
    expect(results).toHaveLength(2);
    expect(results.map((message) => JSON.parse(message.content!).status)).toEqual(['PREVIEW_READY', 'PREVIEW_READY']);
    expect(integrated.apply(projectId, episodeId, result.messages[1]!.id).episode.content).toBe(`어둠이 짙어졌다.\n${selected}\n발소리가 멎었다.`);
  });
});
