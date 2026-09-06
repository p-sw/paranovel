import { BadGatewayException, BadRequestException, ConflictException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { DatabaseService } from '../src/database/database.service';
import { arcs, projectCreationSessions } from '../src/database/schema';
import { ProjectWizardService, type SetupQuestion } from '../src/projects/project-wizard.service';
import { ProjectsService } from '../src/projects/projects.service';

const titleQuestion: SetupQuestion = { id: 'shared', field: 'title', prompt: '제목은?', inputType: 'text', options: [], required: true, suggestedAnswer: '달 없는 밤' };
const targetQuestion: SetupQuestion = { id: 'target-episode', field: 'targetEpisode', prompt: '몇 화에 완결하는 것을 목표로 할까요?', inputType: 'text', options: [], required: false };
const toneQuestion: SetupQuestion = { id: 'shared', field: 'tone', prompt: '분위기는?', inputType: 'single', options: ['밝음', '어두움'], required: false };
const traitsQuestion: SetupQuestion = { id: 'shared', field: 'traits', prompt: '특성은?', inputType: 'multi', options: ['용기', '지혜'], required: false };

function toolResponse(question?: SetupQuestion) {
  return {
    runId: 'test',
    result: {
      content: '', usage: {}, model: 'test',
      toolCalls: [{ id: 'tool', type: 'function', function: {
        name: question ? 'ask_project_details' : 'complete_project_interview',
        arguments: JSON.stringify(question ?? { confirmedFacts: [], assumptions: [] }),
      } }],
    },
  };
}

function plannedArcs(targetEpisode: number) {
  const result = [];
  let startEpisode = 1;
  while (startEpisode <= targetEpisode) {
    const remaining = targetEpisode - startEpisode + 1;
    const span = remaining > 20 && remaining - 20 < 5 ? 15 : Math.min(20, remaining);
    const endEpisode = startEpisode + span - 1;
    result.push({
      title: `달의 여정 ${result.length + 1}`,
      startEpisode,
      endEpisode,
      goal: '달을 되찾는다.',
      conflict: '왕실이 방해한다.',
      reversalPlan: [],
    });
    startEpisode = endEpisode + 1;
  }
  return result;
}

describe('project interview history and custom answers', () => {
  let database: DatabaseService;
  let wizard: ProjectWizardService;
  const completeText = vi.fn();
  const completeJson = vi.fn();
  const indexSource = vi.fn();

  beforeEach(() => {
    vi.stubEnv('DB_PATH', ':memory:');
    vi.stubEnv('OPENROUTER_EMBEDDING_DIMENSIONS', '4');
    database = new DatabaseService();
    completeText.mockReset().mockImplementation(async (request) => {
      const count = request.variables.interview_answers.length;
      return toolResponse(count === 0 ? titleQuestion : count === 2 ? toneQuestion : count === 3 ? traitsQuestion : undefined);
    });
    completeJson.mockReset().mockImplementation(async (request) => {
      const targetEpisode = request.variables.target_episode_answer ? Number(request.variables.target_episode_answer) : 25;
      const value = {
        title: request.variables.project_title,
        logline: '잃어버린 달을 찾는다.', genreTags: ['판타지'], details: '', defaultTargetChars: 5000, canon: [],
        targetEpisode,
        targetEpisodeSource: request.variables.target_episode_answer ? 'USER' : 'AI',
        arcs: plannedArcs(targetEpisode),
      };
      return { value: request.validator.parse(value) };
    });
    indexSource.mockReset().mockResolvedValue(undefined);
    wizard = new ProjectWizardService(database, { completeText, completeJson } as never,
      new ProjectsService(database), { indexSource } as never);
  });

  afterEach(() => {
    database.onApplicationShutdown();
    vi.unstubAllEnvs();
  });

  const start = () => wizard.start({ logline: '잃어버린 달을 찾는다.', genreTags: ['판타지'] });
  async function answerTitle() {
    const initial = await start();
    return wizard.respond(initial.session.id, { questionId: 'shared', answer: '달 없는 밤' });
  }
  async function answerTarget() {
    const target = await answerTitle();
    return wizard.skip(target.session.id, { questionId: 'target-episode', expectedState: target.stateToken });
  }
  async function finish() {
    const tone = await answerTarget();
    const traits = await wizard.respond(tone.session.id, {
      questionId: 'shared', answer: '밝음', position: 2, expectedState: tone.stateToken,
    });
    return wizard.respond(traits.session.id, {
      questionId: 'shared', answer: ['용기'], position: 3, expectedState: traits.stateToken,
    });
  }

  it('restores full history and remains compatible with existing current-question requests', async () => {
    const target = await answerTitle();
    expect(target.history).toEqual([{ question: titleQuestion, answer: '달 없는 밤', skipped: false }]);
    expect(target.step).toEqual({ type: 'question', question: targetQuestion });
    const restored = await wizard.get(target.session.id);
    expect(restored).toEqual(target);
    expect(restored.stateToken).toMatch(/^[a-f0-9]{64}$/);
  });

  it('requires an editable AI title recommendation and asks the target episode second', async () => {
    const started = await start();
    expect(started.step).toEqual({ type: 'question', question: titleQuestion });
    expect(completeText).toHaveBeenCalledTimes(1);
    const target = await wizard.respond(started.session.id, { questionId: 'shared', answer: '추천 제목 수정본' });
    expect(target.step).toEqual({ type: 'question', question: targetQuestion });
    expect(completeText).toHaveBeenCalledTimes(1);

    completeText.mockReset().mockResolvedValue(toolResponse({ ...titleQuestion, suggestedAnswer: undefined }));
    await expect(start()).rejects.toBeInstanceOf(BadGatewayException);
  });

  it.each([
    { ...titleQuestion, id: 'duplicate-title' },
    { ...targetQuestion, id: 'duplicate-target' },
  ])('rejects a repeated reserved interview field $field', async (duplicate) => {
    const target = await answerTitle();
    completeText.mockResolvedValueOnce(toolResponse(duplicate));

    await expect(wizard.skip(target.session.id, {
      questionId: 'target-episode',
      expectedState: target.stateToken,
    })).rejects.toBeInstanceOf(BadGatewayException);
  });

  it('validates a user target and keeps it as the exact ending of the full arc plan', async () => {
    const target = await answerTitle();
    for (const answer of ['4', '2001', '10.5', '백 화']) {
      await expect(wizard.respond(target.session.id, { questionId: 'target-episode', answer }))
        .rejects.toBeInstanceOf(BadRequestException);
    }
    const tone = await wizard.respond(target.session.id, { questionId: 'target-episode', answer: '40화' });
    const traits = await wizard.respond(tone.session.id, { questionId: 'shared', answer: '밝음' });
    const ready = await wizard.respond(traits.session.id, { questionId: 'shared', answer: ['용기'] });
    expect(ready.history[1]).toMatchObject({ answer: '40', skipped: false });
    expect(ready.step).toMatchObject({
      type: 'ready',
      blueprint: { targetEpisode: 40, targetEpisodeSource: 'USER' },
    });
    if (ready.step.type === 'ready' && ready.step.blueprint) {
      expect(ready.step.blueprint.arcs.at(-1)?.endEpisode).toBe(40);
    }
  });

  it('accepts explicit Other answers and stores the input mode for restoration', async () => {
    const tone = await answerTarget();
    const traits = await wizard.respond(tone.session.id, {
      questionId: 'shared', otherAnswer: '  씁쓸하지만 희망적  ', position: 2, expectedState: tone.stateToken,
    });
    expect(traits.history[2]).toMatchObject({ answer: '씁쓸하지만 희망적', otherAnswer: '씁쓸하지만 희망적' });
    const ready = await wizard.respond(traits.session.id, {
      questionId: 'shared', otherAnswer: '끈기', position: 3, expectedState: traits.stateToken,
    });
    expect(ready.history[3]).toMatchObject({ answer: ['끈기'], otherAnswer: '끈기' });
    expect(ready.step.type).toBe('ready');
  });

  it('rejects custom text masquerading as a predefined option and mixed input modes', async () => {
    const tone = await answerTarget();
    for (const input of [
      { answer: '임의 답변' }, { answer: ['밝음'] }, { otherAnswer: ' ' },
      { answer: '밝음', otherAnswer: '다른 답변' }, { skipOptional: true, otherAnswer: '다른 답변' },
    ]) {
      await expect(wizard.respond(tone.session.id, { questionId: 'shared', ...input })).rejects.toBeInstanceOf(BadRequestException);
    }
    const traits = await wizard.respond(tone.session.id, { questionId: 'shared', answer: '밝음' });
    for (const input of [{ answer: ['없는 선택지'] }, { answer: [] }, { answer: ['용기'], otherAnswer: '끈기' }]) {
      await expect(wizard.respond(traits.session.id, { questionId: 'shared', ...input })).rejects.toBeInstanceOf(BadRequestException);
    }
  });

  it('normalizes AI option whitespace before validating a selected answer', async () => {
    const initial = await start();
    completeText.mockResolvedValueOnce(toolResponse({ ...toneQuestion, options: ['  밝음  ', '어두움', '밝음'] }));
    const tone = await wizard.respond(initial.session.id, { questionId: 'shared', answer: '달 없는 밤' });
    const actualTone = await wizard.skip(tone.session.id, { questionId: 'target-episode' });
    expect(actualTone.step).toMatchObject({ question: { options: ['밝음', '어두움'] } });
    const traits = await wizard.respond(actualTone.session.id, { questionId: 'shared', answer: '밝음' });
    expect(traits.history[2]).toMatchObject({ answer: '밝음' });
  });

  it('preserves required title validation for direct input and skipped history', async () => {
    const initial = await start();
    for (const input of [{ skipOptional: true }, { otherAnswer: '제목' }, { answer: ' ' }]) {
      await expect(wizard.respond(initial.session.id, { questionId: 'shared', ...input })).rejects.toBeInstanceOf(BadRequestException);
    }
    const target = await wizard.respond(initial.session.id, { questionId: 'shared', answer: '달 없는 밤' });
    const traits = await wizard.skip(target.session.id, { questionId: 'target-episode', expectedState: target.stateToken });
    expect(traits.history[1]).toMatchObject({ answer: null, skipped: true });
    await expect(wizard.respond(traits.session.id, {
      questionId: 'shared', position: 0, expectedState: traits.stateToken, skipOptional: true,
    })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('keeps subsequent answers and blueprint when revisiting with the same answer', async () => {
    const ready = await finish();
    const calls = completeText.mock.calls.length;
    const same = await wizard.respond(ready.session.id, {
      questionId: 'shared', answer: '밝음', position: 2, expectedState: ready.stateToken,
    });
    expect(same).toEqual(ready);
    expect(completeText).toHaveBeenCalledTimes(calls);
  });

  it('reopens READY and drops only subsequent answers when an earlier answer changes', async () => {
    const ready = await finish();
    const revised = await wizard.respond(ready.session.id, {
      questionId: 'shared', otherAnswer: '희망적', position: 2, expectedState: ready.stateToken,
    });
    expect(revised.step).toMatchObject({ type: 'question', question: traitsQuestion });
    expect(revised.history).toHaveLength(3);
    expect(revised.history[0]).toEqual(ready.history[0]);
    const row = database.orm.select().from(projectCreationSessions).where(eq(projectCreationSessions.id, ready.session.id)).get()!;
    expect(JSON.parse(row.answersJson)).toEqual({ title: '달 없는 밤', targetEpisode: null, tone: '희망적' });
    expect(row.blueprintJson).toBeNull();
    expect(completeText.mock.lastCall?.[0].variables.interview_answers).toEqual(revised.history);
  });

  it('rebuilds the title and next questions after revising the first answer', async () => {
    const ready = await finish();
    const revised = await wizard.respond(ready.session.id, {
      questionId: 'shared', answer: '달이 돌아온 밤', position: 0, expectedState: ready.stateToken,
    });
    expect(revised.history).toHaveLength(1);
    expect(revised.step).toMatchObject({ question: targetQuestion });
  });

  it('rejects stale state despite reused AI question IDs and rejects invalid positions', async () => {
    const tone = await answerTarget();
    const traits = await wizard.respond(tone.session.id, {
      questionId: 'shared', answer: '밝음', position: 2, expectedState: tone.stateToken,
    });
    await expect(wizard.respond(traits.session.id, {
      questionId: 'shared', answer: '어두움', position: 2, expectedState: tone.stateToken,
    })).rejects.toBeInstanceOf(ConflictException);
    for (const position of [-1, 0.5, 100, '0']) {
      await expect(wizard.respond(traits.session.id, {
        questionId: 'shared', answer: '달', position, expectedState: traits.stateToken,
      })).rejects.toBeInstanceOf(BadRequestException);
    }
    await expect(wizard.respond(traits.session.id, { questionId: 'shared', position: 0, answer: '달' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('shares an in-flight next question with session recovery', async () => {
    const target = await answerTitle();
    let finishTurn!: (value: ReturnType<typeof toolResponse>) => void;
    completeText.mockImplementationOnce(() => new Promise((resolve) => { finishTurn = resolve; }));
    const responding = wizard.skip(target.session.id, { questionId: 'target-episode' });
    const recovering = wizard.get(target.session.id);
    finishTurn(toolResponse(toneQuestion));
    expect(await recovering).toEqual(await responding);
    expect(completeText).toHaveBeenCalledTimes(2);
  });

  it('does not overwrite a newer session state with a delayed AI result', async () => {
    const target = await answerTitle();
    let finishTurn!: (value: ReturnType<typeof toolResponse>) => void;
    completeText.mockImplementationOnce(() => new Promise((resolve) => { finishTurn = resolve; }));
    const responding = wizard.skip(target.session.id, { questionId: 'target-episode' });
    database.orm.update(projectCreationSessions).set({
      pendingQuestionJson: JSON.stringify(traitsQuestion), updatedAt: '2099-01-01T00:00:00.000Z',
    }).where(eq(projectCreationSessions.id, target.session.id)).run();
    finishTurn(toolResponse(toneQuestion));
    await expect(responding).rejects.toBeInstanceOf(ConflictException);
    expect((await wizard.get(target.session.id)).step).toMatchObject({ question: traitsQuestion });
  });

  it('retains the revised answer after AI failure and resumes generation without replaying it', async () => {
    const ready = await finish();
    completeText.mockRejectedValueOnce(new Error('temporary AI failure'));
    await expect(wizard.respond(ready.session.id, {
      questionId: 'shared', answer: '어두움', position: 2, expectedState: ready.stateToken,
    })).rejects.toThrow('temporary AI failure');
    const recovered = await wizard.get(ready.session.id);
    expect(recovered.history).toHaveLength(3);
    expect(recovered.history[2]?.answer).toBe('어두움');
    expect(recovered.step).toMatchObject({ question: traitsQuestion });
  });

  it('guards a reviewed blueprint against stale commits and committed-session edits', async () => {
    const ready = await finish();
    await expect(wizard.commit(ready.session.id, { expectedState: 'stale' })).rejects.toBeInstanceOf(ConflictException);
    const committed = await wizard.commit(ready.session.id, { expectedState: ready.stateToken });
    expect(committed.project).toMatchObject({ title: '달 없는 밤', targetEpisode: 25, targetEpisodeSource: 'AI' });
    expect(database.orm.select().from(arcs).where(eq(arcs.projectId, committed.project.id)).all().map((arc) => arc.status))
      .toEqual(['ACTIVE', 'PLANNED']);
    expect((await wizard.commit(ready.session.id)).project.id).toBe(committed.project.id);
    await expect(wizard.respond(ready.session.id, {
      questionId: 'shared', answer: '새 제목', position: 0, expectedState: ready.stateToken,
    })).rejects.toBeInstanceOf(ConflictException);
  });

  it('retries initial canon and active-arc indexing after the project transaction committed', async () => {
    const ready = await finish();
    indexSource.mockRejectedValueOnce(new Error('index unavailable'));
    await expect(wizard.commit(ready.session.id, { expectedState: ready.stateToken }))
      .rejects.toThrow('index unavailable');
    const stored = database.orm.select().from(projectCreationSessions)
      .where(eq(projectCreationSessions.id, ready.session.id)).get()!;
    expect(stored).toMatchObject({ status: 'COMMITTED', projectId: expect.any(String) });

    indexSource.mockResolvedValue(undefined);
    const retried = await wizard.commit(ready.session.id);
    expect(retried.project.id).toBe(stored.projectId);
    expect(indexSource).toHaveBeenCalledTimes(2);
  });

  it('marks an AI ending as user-selected when it is changed during review', async () => {
    const ready = await finish();
    if (ready.step.type !== 'ready') throw new Error('Expected a blueprint');
    const committed = await wizard.commit(ready.session.id, {
      expectedState: ready.stateToken,
      blueprint: {
        ...ready.step.blueprint,
        targetEpisode: 15,
        targetEpisodeSource: 'AI',
        arcs: plannedArcs(15),
      },
    });
    expect(committed.project).toMatchObject({ targetEpisode: 15, targetEpisodeSource: 'USER' });
  });

  it('normalizes a legacy reviewed single arc before returning it', async () => {
    const target = await answerTitle();
    const legacy = {
      title: '달 없는 밤', logline: '잃어버린 달을 찾는다.', genreTags: ['판타지'],
      details: '', defaultTargetChars: 5000, canon: [],
      arc: { title: '달의 흔적', startEpisode: 1, endEpisode: 5, goal: '달 찾기', conflict: '추격자', reversalPlan: [] },
    };
    database.orm.update(projectCreationSessions).set({
      status: 'READY', pendingQuestionJson: null, blueprintJson: JSON.stringify(legacy),
    }).where(eq(projectCreationSessions.id, target.session.id)).run();
    expect((await wizard.get(target.session.id)).step).toMatchObject({
      type: 'ready', blueprint: { targetEpisode: 5, targetEpisodeSource: 'AI', arcs: [legacy.arc] },
    });
  });

  it('reopens a legacy READY session whose single arc cannot satisfy the full-story contract', async () => {
    const target = await answerTitle();
    const legacy = {
      title: '달 없는 밤', logline: '잃어버린 달을 찾는다.', genreTags: ['판타지'],
      details: '', defaultTargetChars: 5000, canon: [],
      arc: { title: '중간 기록', startEpisode: 6, endEpisode: 10, goal: '달 찾기', conflict: '추격자', reversalPlan: [] },
    };
    database.orm.update(projectCreationSessions).set({
      status: 'READY', pendingQuestionJson: null, blueprintJson: JSON.stringify(legacy),
    }).where(eq(projectCreationSessions.id, target.session.id)).run();

    const recovered = await wizard.get(target.session.id);

    expect(recovered.session.status).toBe('ACTIVE');
    expect(recovered.step).toEqual({ type: 'question', question: targetQuestion });
  });

  it('reopens a READY session whose blueprint is missing instead of returning ready with null', async () => {
    const target = await answerTitle();
    database.orm.update(projectCreationSessions).set({
      status: 'READY', pendingQuestionJson: null, blueprintJson: null,
    }).where(eq(projectCreationSessions.id, target.session.id)).run();

    const recovered = await wizard.get(target.session.id);

    expect(recovered.session.status).toBe('ACTIVE');
    expect(recovered.step).toEqual({ type: 'question', question: targetQuestion });
    const row = database.orm.select().from(projectCreationSessions)
      .where(eq(projectCreationSessions.id, target.session.id)).get()!;
    expect(row).toMatchObject({ status: 'ACTIVE', blueprintJson: null });
  });
});
