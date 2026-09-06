import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AiRunnerService } from '../src/ai/ai-runner.service';
import { chatOutputSchema, chatOutputValidator } from '../src/chat/chat.schemas';
import { DatabaseService } from '../src/database/database.service';
import { aiRuns } from '../src/database/schema';
import { ProjectsService } from '../src/projects/projects.service';
import { PromptRegistryService } from '../src/prompts/prompt-registry.service';

describe('AI runner failure logging', () => {
  let database: DatabaseService;
  let runner: AiRunnerService;
  let registry: PromptRegistryService;
  let projectId: string;
  const complete = vi.fn();
  const errorLog = vi.fn();

  beforeEach(() => {
    vi.stubEnv('DB_PATH', ':memory:');
    vi.stubEnv('AI_CHAT_MODEL', 'test-chat-model');
    complete.mockReset();
    errorLog.mockReset();
    vi.spyOn(Logger.prototype, 'error').mockImplementation(errorLog);
    database = new DatabaseService();
    registry = new PromptRegistryService();
    runner = new AiRunnerService(database, registry, { complete } as never, { isConfigured: () => false } as never);
    projectId = new ProjectsService(database).createInternal({
      title: 'Test project', logline: 'Test premise', genreTags: ['판타지'],
    }).id;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    database.onApplicationShutdown();
  });

  function runChat(signal?: AbortSignal) {
    return runner.completeChat({
      task: 'project_chat', promptId: 'project-chat', projectId, signal,
      variables: Object.fromEntries(registry.get('project-chat').requiredVariables.map((key) => [key, '[]'])),
      history: [{ role: 'user', content: 'private chat content' }],
      schema: { name: 'project_chat_reply', value: chatOutputSchema }, validator: chatOutputValidator,
      readTools: [], readTool: vi.fn(),
    });
  }

  it('logs the original error with the real run ID before persisting FAILED', async () => {
    const original = new Error('Provider request failed');
    complete.mockRejectedValueOnce(original);
    let statusWhenLogged: string | undefined;
    errorLog.mockImplementationOnce(() => {
      statusWhenLogged = database.orm.select().from(aiRuns).get()?.status;
    });

    await expect(runChat()).rejects.toBe(original);

    const run = database.orm.select().from(aiRuns).get()!;
    expect(statusWhenLogged).toBe('RUNNING');
    expect(run).toMatchObject({ status: 'FAILED', error: original.message });
    expect(errorLog).toHaveBeenCalledOnce();
    expect(errorLog).toHaveBeenCalledWith(expect.objectContaining({
      event: 'ai_run_failed', runId: run.id, task: 'project_chat', model: 'test-chat-model',
      projectId, episodeId: null, elapsedMs: expect.any(Number),
      error: expect.objectContaining({ name: 'Error', message: original.message, stack: expect.any(String) }),
    }));
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain('private chat content');
  });

  it('logs both failures in order and rethrows the provider error when FAILED cannot be saved', async () => {
    database.connection.exec("CREATE TEMP TRIGGER reject_failed_run BEFORE UPDATE ON ai_runs WHEN NEW.status = 'FAILED' BEGIN SELECT RAISE(FAIL, 'Synthetic AI run status storage failure'); END");
    vi.stubEnv('OPENROUTER_API_KEY', 'private-runner-api-key');
    const original = new Error('Provider request failed Authorization: Bearer private-runner-api-key');
    complete.mockRejectedValueOnce(original);

    await expect(runChat()).rejects.toBe(original);

    const run = database.orm.select().from(aiRuns).get()!;
    expect(run.status).toBe('RUNNING');
    expect(errorLog.mock.calls.map(([entry]) => entry.event)).toEqual([
      'ai_run_failed', 'ai_run_failure_status_write_failed',
    ]);
    for (const [entry] of errorLog.mock.calls) {
      expect(entry).toMatchObject({ runId: run.id, task: 'project_chat', projectId,
        model: 'test-chat-model', episodeId: null, elapsedMs: expect.any(Number) });
    }
    expect(errorLog.mock.calls[0]![0].error.message).toContain('Provider request failed');
    const logs = JSON.stringify(errorLog.mock.calls);
    expect(logs).toContain('Synthetic AI run status storage failure');
    expect(logs).not.toContain('private-runner-api-key');
    expect(logs).not.toContain('private chat content');
    expect(logs).not.toContain('update "ai_runs"');
  });

  it('retains CANCELLED persistence and the original abort error', async () => {
    const controller = new AbortController();
    const original = new Error('Request cancelled');
    controller.abort(original);

    await expect(runChat(controller.signal)).rejects.toBe(original);

    const run = database.orm.select().from(aiRuns).get()!;
    expect(run).toMatchObject({ status: 'CANCELLED', error: original.message });
    expect(errorLog).toHaveBeenCalledWith(expect.objectContaining({
      event: 'ai_run_failed', runId: run.id, error: expect.objectContaining({ message: original.message }),
    }));
    expect(complete).not.toHaveBeenCalled();
  });
});
