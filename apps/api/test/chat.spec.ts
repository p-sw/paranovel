import { BadGatewayException, ConflictException, NotFoundException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { AiRunnerService } from '../src/ai/ai-runner.service';
import { OpenRouterGateway } from '../src/ai/openrouter.gateway';
import type { CompletionRequest } from '../src/ai/ai.types';
import { ArcsService } from '../src/arcs/arcs.service';
import { CanonService } from '../src/canon/canon.service';
import { ChatReadToolsService } from '../src/chat/chat-read-tools.service';
import { ChatService } from '../src/chat/chat.service';
import { chatOutputSchema, chatOutputValidator, type ChatOutput } from '../src/chat/chat.schemas';
import { DatabaseService } from '../src/database/database.service';
import { chatMessages, chatProposals, episodes } from '../src/database/schema';
import { ImprovementsService } from '../src/improvements/improvements.service';
import { MemoryService } from '../src/memory/memory.service';
import { ProjectsService } from '../src/projects/projects.service';
import { PromptRegistryService } from '../src/prompts/prompt-registry.service';

const canonFields = { category: 'CHARACTER', name: '하린', content: '기억을 읽는 기록관' };
const arcFields = { title: '기록관의 비밀', startEpisodeNumber: 1, endEpisodeNumber: 8, goal: '기록을 찾는다', conflict: '왕실의 추적' };
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
  let chat: ChatService;
  let projectId: string;
  const completeChat = vi.fn();
  const embeddings = vi.fn(async (texts: string[]) => texts.map(() => [0, 1, 0, 1]));

  beforeEach(() => {
    vi.stubEnv('DB_PATH', ':memory:');
    vi.stubEnv('OPENROUTER_EMBEDDING_DIMENSIONS', '4');
    database = new DatabaseService();
    memory = new MemoryService(database, { embeddings } as never);
    projects = new ProjectsService(database);
    const ai = { completeChat } as unknown as AiRunnerService;
    canon = new CanonService(database, memory, ai);
    arcs = new ArcsService(database, memory, ai);
    improvements = new ImprovementsService(database, ai, memory);
    reads = new ChatReadToolsService(database, projects, canon, arcs, improvements, memory, { isConfigured: () => false } as never);
    chat = new ChatService(database, ai, projects, canon, arcs, improvements, memory, reads);
    projectId = projects.createInternal({ title: '기록의 문', logline: '기억을 읽는 기록관', genreTags: ['판타지'] }).id;
    completeChat.mockReset();
    embeddings.mockClear();
  });

  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); database.onApplicationShutdown(); });

  async function ask(proposals: ChatOutput['proposals'], clientMessageId = 'turn-1', content = '작품을 개선해 줘') {
    completeChat.mockResolvedValueOnce({ runId: 'chat-run', value: { reply: '검토할 내용을 준비했습니다.', proposals } });
    return chat.send(projectId, { content, clientMessageId });
  }

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
    const service = new ChatService(database, runner, projects, canon, arcs, improvements, memory, reads);
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
      proposal('PROJECT', 'UPDATE', { title: '새 작품명' }, projectId),
      proposal('IMPROVEMENT', 'CREATE', { title: '간결성', rule: '문장을 간결하게 쓴다' }),
    ]);
    for (const item of history.messages[1]!.proposals) await chat.apply(projectId, item.id);
    expect(projects.get(projectId).title).toBe('새 작품명');
    expect(improvements.list(projectId)[0]).toMatchObject({ scope: 'PROJECT', projectId, rule: '문장을 간결하게 쓴다', active: true });
  });

  it('shows arc archival effects and applies the activation with those effects atomically', async () => {
    const oldArc = await arcs.create(projectId, { ...arcFields, status: 'ACTIVE' });
    const history = await ask([proposal('ARC', 'CREATE', { ...arcFields, title: '다음 아크', startEpisodeNumber: 9, endEpisodeNumber: 16, status: 'ACTIVE' })]);
    const item = history.messages[1]!.proposals[0]!;
    expect(item.effects[0]).toMatchObject({ label: expect.stringContaining(oldArc.title), before: { id: oldArc.id, status: 'ACTIVE' }, after: { status: 'ARCHIVED' } });
    await chat.apply(projectId, item.id);
    expect(arcs.current(projectId)?.title).toBe('다음 아크');
    expect(arcs.get(projectId, oldArc.id)).toMatchObject({ status: 'ARCHIVED', revision: 2 });
  });

  it('rejects arc activation if the reviewed active arc changed', async () => {
    const old = await arcs.create(projectId, { ...arcFields, status: 'ACTIVE' });
    const history = await ask([proposal('ARC', 'CREATE', { ...arcFields, title: '다음', status: 'ACTIVE' })]);
    await arcs.update(projectId, old.id, { expectedRevision: old.revision, title: '수정한 아크' });
    await expect(chat.apply(projectId, history.messages[1]!.proposals[0]!.id)).rejects.toBeInstanceOf(ConflictException);
    expect(arcs.list(projectId)).toHaveLength(1);
    expect(arcs.current(projectId)?.title).toBe('수정한 아크');
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
    database.orm.insert(chatMessages).values({ id: 'interrupted', projectId, clientMessageId: 'old', role: 'assistant', content: '', status: 'PENDING', createdAt: new Date().toISOString() }).run();
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
