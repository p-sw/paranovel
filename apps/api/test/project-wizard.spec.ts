import { BadRequestException, ConflictException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { DatabaseService } from '../src/database/database.service';
import { projectCreationSessions } from '../src/database/schema';
import { ProjectWizardService, type SetupQuestion } from '../src/projects/project-wizard.service';
import { ProjectsService } from '../src/projects/projects.service';

const titleQuestion: SetupQuestion = { id: 'shared', field: 'title', prompt: '제목은?', inputType: 'text', options: [], required: true };
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

describe('project interview history and custom answers', () => {
  let database: DatabaseService;
  let wizard: ProjectWizardService;
  const completeText = vi.fn();
  const completeJson = vi.fn();

  beforeEach(() => {
    vi.stubEnv('DB_PATH', ':memory:');
    vi.stubEnv('OPENROUTER_EMBEDDING_DIMENSIONS', '4');
    database = new DatabaseService();
    completeText.mockReset().mockImplementation(async (request) => {
      const count = request.variables.interview_answers.length;
      return toolResponse([titleQuestion, toneQuestion, traitsQuestion][count]);
    });
    completeJson.mockReset().mockImplementation(async (request) => ({ value: {
      title: request.variables.project_title,
      logline: '잃어버린 달을 찾는다.', genreTags: ['판타지'], details: '', defaultTargetChars: 5000, canon: [],
      arc: { title: '달의 흔적', startEpisode: 1, endEpisode: 5, goal: '달 찾기', conflict: '추격자', reversalPlan: [] },
    } }));
    wizard = new ProjectWizardService(database, { completeText, completeJson } as never,
      new ProjectsService(database), { indexSource: vi.fn() } as never);
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
  async function finish() {
    const tone = await answerTitle();
    const traits = await wizard.respond(tone.session.id, {
      questionId: 'shared', answer: '밝음', position: 1, expectedState: tone.stateToken,
    });
    return wizard.respond(traits.session.id, {
      questionId: 'shared', answer: ['용기'], position: 2, expectedState: traits.stateToken,
    });
  }

  it('restores full history and remains compatible with existing current-question requests', async () => {
    const tone = await answerTitle();
    expect(tone.history).toEqual([{ question: titleQuestion, answer: '달 없는 밤', skipped: false }]);
    const restored = await wizard.get(tone.session.id);
    expect(restored).toEqual(tone);
    expect(restored.stateToken).toMatch(/^[a-f0-9]{64}$/);
  });

  it('accepts explicit Other answers and stores the input mode for restoration', async () => {
    const tone = await answerTitle();
    const traits = await wizard.respond(tone.session.id, {
      questionId: 'shared', otherAnswer: '  씁쓸하지만 희망적  ', position: 1, expectedState: tone.stateToken,
    });
    expect(traits.history[1]).toMatchObject({ answer: '씁쓸하지만 희망적', otherAnswer: '씁쓸하지만 희망적' });
    const ready = await wizard.respond(traits.session.id, {
      questionId: 'shared', otherAnswer: '끈기', position: 2, expectedState: traits.stateToken,
    });
    expect(ready.history[2]).toMatchObject({ answer: ['끈기'], otherAnswer: '끈기' });
    expect(ready.step.type).toBe('ready');
  });

  it('rejects custom text masquerading as a predefined option and mixed input modes', async () => {
    const tone = await answerTitle();
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
    expect(tone.step).toMatchObject({ question: { options: ['밝음', '어두움'] } });
    const traits = await wizard.respond(tone.session.id, { questionId: 'shared', answer: '밝음' });
    expect(traits.history[1]).toMatchObject({ answer: '밝음' });
  });

  it('preserves required title validation for direct input and skipped history', async () => {
    const initial = await start();
    for (const input of [{ skipOptional: true }, { otherAnswer: '제목' }, { answer: ' ' }]) {
      await expect(wizard.respond(initial.session.id, { questionId: 'shared', ...input })).rejects.toBeInstanceOf(BadRequestException);
    }
    const tone = await wizard.respond(initial.session.id, { questionId: 'shared', answer: '달 없는 밤' });
    const traits = await wizard.skip(tone.session.id, { questionId: 'shared', expectedState: tone.stateToken });
    expect(traits.history[1]).toMatchObject({ answer: null, skipped: true });
    await expect(wizard.respond(traits.session.id, {
      questionId: 'shared', position: 0, expectedState: traits.stateToken, skipOptional: true,
    })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('keeps subsequent answers and blueprint when revisiting with the same answer', async () => {
    const ready = await finish();
    const calls = completeText.mock.calls.length;
    const same = await wizard.respond(ready.session.id, {
      questionId: 'shared', answer: '밝음', position: 1, expectedState: ready.stateToken,
    });
    expect(same).toEqual(ready);
    expect(completeText).toHaveBeenCalledTimes(calls);
  });

  it('reopens READY and drops only subsequent answers when an earlier answer changes', async () => {
    const ready = await finish();
    const revised = await wizard.respond(ready.session.id, {
      questionId: 'shared', otherAnswer: '희망적', position: 1, expectedState: ready.stateToken,
    });
    expect(revised.step).toMatchObject({ type: 'question', question: traitsQuestion });
    expect(revised.history).toHaveLength(2);
    expect(revised.history[0]).toEqual(ready.history[0]);
    const row = database.orm.select().from(projectCreationSessions).where(eq(projectCreationSessions.id, ready.session.id)).get()!;
    expect(JSON.parse(row.answersJson)).toEqual({ title: '달 없는 밤', tone: '희망적' });
    expect(row.blueprintJson).toBeNull();
    expect(completeText.mock.lastCall?.[0].variables.interview_answers).toEqual(revised.history);
  });

  it('rebuilds the title and next questions after revising the first answer', async () => {
    const ready = await finish();
    const revised = await wizard.respond(ready.session.id, {
      questionId: 'shared', answer: '달이 돌아온 밤', position: 0, expectedState: ready.stateToken,
    });
    expect(revised.history).toHaveLength(1);
    expect(revised.step).toMatchObject({ question: toneQuestion });
    expect(completeText.mock.lastCall?.[0].variables.project_title).toBe('달이 돌아온 밤');
  });

  it('rejects stale state despite reused AI question IDs and rejects invalid positions', async () => {
    const tone = await answerTitle();
    const traits = await wizard.respond(tone.session.id, {
      questionId: 'shared', answer: '밝음', position: 1, expectedState: tone.stateToken,
    });
    await expect(wizard.respond(traits.session.id, {
      questionId: 'shared', answer: '어두움', position: 1, expectedState: tone.stateToken,
    })).rejects.toBeInstanceOf(ConflictException);
    for (const position of [-1, 0.5, 100, '0']) {
      await expect(wizard.respond(traits.session.id, {
        questionId: 'shared', answer: '달', position, expectedState: traits.stateToken,
      })).rejects.toBeInstanceOf(BadRequestException);
    }
    await expect(wizard.respond(traits.session.id, { questionId: 'shared', position: 0, answer: '달' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('shares an in-flight next question with session recovery', async () => {
    const initial = await start();
    let finishTurn!: (value: ReturnType<typeof toolResponse>) => void;
    completeText.mockImplementationOnce(() => new Promise((resolve) => { finishTurn = resolve; }));
    const responding = wizard.respond(initial.session.id, { questionId: 'shared', answer: '달 없는 밤' });
    const recovering = wizard.get(initial.session.id);
    finishTurn(toolResponse(toneQuestion));
    expect(await recovering).toEqual(await responding);
    expect(completeText).toHaveBeenCalledTimes(2);
  });

  it('does not overwrite a newer session state with a delayed AI result', async () => {
    const initial = await start();
    let finishTurn!: (value: ReturnType<typeof toolResponse>) => void;
    completeText.mockImplementationOnce(() => new Promise((resolve) => { finishTurn = resolve; }));
    const responding = wizard.respond(initial.session.id, { questionId: 'shared', answer: '달 없는 밤' });
    database.orm.update(projectCreationSessions).set({
      pendingQuestionJson: JSON.stringify(traitsQuestion), updatedAt: '2099-01-01T00:00:00.000Z',
    }).where(eq(projectCreationSessions.id, initial.session.id)).run();
    finishTurn(toolResponse(toneQuestion));
    await expect(responding).rejects.toBeInstanceOf(ConflictException);
    expect((await wizard.get(initial.session.id)).step).toMatchObject({ question: traitsQuestion });
  });

  it('retains the revised answer after AI failure and resumes generation without replaying it', async () => {
    const ready = await finish();
    completeText.mockRejectedValueOnce(new Error('temporary AI failure'));
    await expect(wizard.respond(ready.session.id, {
      questionId: 'shared', answer: '새 제목', position: 0, expectedState: ready.stateToken,
    })).rejects.toThrow('temporary AI failure');
    const recovered = await wizard.get(ready.session.id);
    expect(recovered.history).toHaveLength(1);
    expect(recovered.history[0]?.answer).toBe('새 제목');
    expect(recovered.step).toMatchObject({ question: toneQuestion });
  });

  it('guards a reviewed blueprint against stale commits and committed-session edits', async () => {
    const ready = await finish();
    await expect(wizard.commit(ready.session.id, { expectedState: 'stale' })).rejects.toBeInstanceOf(ConflictException);
    const committed = await wizard.commit(ready.session.id, { expectedState: ready.stateToken });
    expect(committed.project.title).toBe('달 없는 밤');
    expect((await wizard.commit(ready.session.id)).project.id).toBe(committed.project.id);
    await expect(wizard.respond(ready.session.id, {
      questionId: 'shared', answer: '새 제목', position: 0, expectedState: ready.stateToken,
    })).rejects.toBeInstanceOf(ConflictException);
  });
});
