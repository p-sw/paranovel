import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { AiRunnerService } from '../ai/ai-runner.service';
import {
  projectBlueprintSchema,
  projectBlueprintValidator,
  projectInterviewTools,
} from '../ai/ai.schemas';
import { DatabaseService } from '../database/database.service';
import { arcs, canonEntries, projectCreationSessions } from '../database/schema';
import { MemoryService } from '../memory/memory.service';
import {
  id,
  now,
  parseJson,
  requireString,
  sha256,
  stringifyJson,
  stringArray,
} from '../shared/utils';
import { ProjectsService } from './projects.service';

export interface SetupQuestion {
  id: string;
  field: string;
  prompt: string;
  inputType: 'text' | 'long_text' | 'single' | 'multi';
  options: string[];
  required: boolean;
}

export interface Blueprint {
  title: string;
  logline: string;
  genreTags: string[];
  details: string;
  defaultTargetChars: number;
  canon: Array<{
    category: string;
    name: string;
    aliases: string[];
    content: string;
    metadata: Record<string, unknown>;
  }>;
  arc: {
    title: string;
    startEpisode: number;
    endEpisode: number;
    goal: string;
    conflict: string;
    reversalPlan: Array<{ episode: number; description: string }>;
  };
}

type SessionRow = typeof projectCreationSessions.$inferSelect;
type AnswerRecord = {
  question: SetupQuestion;
  answer: string | string[] | null;
  skipped: boolean;
  otherAnswer?: string;
};

@Injectable()
export class ProjectWizardService {
  private readonly pendingTurns = new Map<string, Promise<ReturnType<ProjectWizardService['result']>>>();

  constructor(
    private readonly database: DatabaseService,
    private readonly ai: AiRunnerService,
    private readonly projects: ProjectsService,
    private readonly memory: MemoryService,
  ) {}

  async start(body: unknown) {
    const input = (body ?? {}) as Record<string, unknown>;
    if ('title' in input) {
      throw new BadRequestException('Title is collected by the AI interview and must not be sent initially');
    }
    const logline = requireString(input.logline, 'logline', { max: 2_000 });
    const genreTags = stringArray(input.genreTags, 'genreTags');
    if (genreTags.length === 0) throw new BadRequestException('At least one genre tag is required');
    const stamp = now();
    const sessionId = id();
    this.database.orm.insert(projectCreationSessions).values({
      id: sessionId,
      projectId: null,
      logline,
      genreTagsJson: stringifyJson(genreTags),
      answersJson: '{}',
      transcriptJson: '[]',
      pendingQuestionJson: null,
      blueprintJson: null,
      titleAsked: 0,
      status: 'ACTIVE',
      createdAt: stamp,
      updatedAt: stamp,
    }).run();
    return this.next(this.requireSession(sessionId));
  }

  async get(sessionId: string) {
    const session = this.requireSession(sessionId);
    if (session.status === 'ACTIVE' && !session.pendingQuestionJson) {
      return this.next(session);
    }
    return this.result(session);
  }

  async respond(sessionId: string, body: unknown) {
    const session = this.requireSession(sessionId);
    if (!['ACTIVE', 'READY'].includes(session.status)) throw new ConflictException('Interview is not accepting answers');
    const input = (body ?? {}) as Record<string, unknown>;
    this.assertExpectedState(session, input.expectedState);
    const history = parseJson<AnswerRecord[]>(session.transcriptJson, []);
    const position = input.position === undefined ? history.length : input.position;
    if (!Number.isInteger(position) || Number(position) < 0 || Number(position) > history.length) {
      throw new BadRequestException('Invalid question position');
    }
    if (input.position !== undefined && input.expectedState === undefined) {
      throw new BadRequestException('expectedState is required when a question position is supplied');
    }
    const index = Number(position);
    const previous = history[index];
    const storedQuestion = previous?.question ?? parseJson<SetupQuestion | null>(session.pendingQuestionJson, null);
    const pending = storedQuestion ? this.normalizeQuestion(storedQuestion) : null;
    if (!pending) throw new ConflictException('There is no pending question');
    if (input.questionId !== pending.id) throw new ConflictException('Question is stale');
    const skip = input.skipOptional === true;
    if (skip && pending.required) throw new BadRequestException('Required questions cannot be skipped');
    if (skip && pending.field === 'title') throw new BadRequestException('Title cannot be skipped');
    let answer: string | string[] | null = null;
    let otherAnswer: string | undefined;
    if (skip && (input.answer !== undefined || input.otherAnswer !== undefined)) {
      throw new BadRequestException('Skipped questions cannot include an answer');
    }
    if (!skip) {
      const choice = pending.inputType === 'single' || pending.inputType === 'multi';
      if (input.otherAnswer !== undefined) {
        if (!choice || input.answer !== undefined) {
          throw new BadRequestException('Other answers are exclusive to choice questions and cannot include a selection');
        }
        otherAnswer = requireString(input.otherAnswer, 'otherAnswer', { max: 10_000 });
        answer = pending.inputType === 'multi' ? [otherAnswer] : otherAnswer;
      } else if (pending.inputType === 'multi') {
        answer = stringArray(input.answer, 'answer');
        if (answer.length === 0) throw new BadRequestException('Answer is required');
        if (answer.some((value) => !pending.options.includes(value))) {
          throw new BadRequestException('Answer must contain only the provided options');
        }
      } else {
        answer = requireString(input.answer, 'answer', { max: 10_000 });
        if (choice && !pending.options.includes(answer)) {
          throw new BadRequestException('Answer must be one of the provided options');
        }
      }
    }
    const record: AnswerRecord = { question: pending, answer, skipped: skip, ...(otherAnswer === undefined ? {} : { otherAnswer }) };
    // Viewing history never mutates the session. An unchanged resubmission also
    // preserves every later answer and the reviewed blueprint.
    const sameAnswer = Array.isArray(previous?.answer) && Array.isArray(answer)
      ? previous.answer.length === answer.length && previous.answer.every((value) => answer.includes(value))
      : previous?.answer === answer;
    if (previous && previous.skipped === skip && previous.otherAnswer === otherAnswer && sameAnswer) {
      return this.result(session);
    }
    const transcript = history.slice(0, index);
    const answers: Record<string, unknown> = {};
    for (const entry of transcript) answers[entry.question.field] = entry.answer;
    answers[pending.field] = answer;
    transcript.push(record);
    this.updateSession(session, {
      answersJson: stringifyJson(answers),
      transcriptJson: stringifyJson(transcript),
      pendingQuestionJson: null,
      blueprintJson: null,
      status: 'ACTIVE',
      titleAsked: transcript.some((entry) => entry.question.field === 'title') ? 1 : 0,
    });
    return this.next(this.requireSession(sessionId));
  }

  async skip(sessionId: string, body: unknown) {
    const session = this.requireSession(sessionId);
    const pending = parseJson<SetupQuestion | null>(session.pendingQuestionJson, null);
    if (!pending) throw new ConflictException('There is no pending question');
    const input = (body ?? {}) as Record<string, unknown>;
    return this.respond(sessionId, {
      ...input,
      questionId: input.questionId ?? pending.id,
      skipOptional: true,
    });
  }

  async commit(sessionId: string, body?: unknown) {
    const session = this.requireSession(sessionId);
    if (session.status === 'COMMITTED' && session.projectId) {
      return { project: this.projects.get(session.projectId) };
    }
    if (session.status !== 'READY' || !session.blueprintJson) {
      throw new ConflictException('Project interview is not ready to commit');
    }
    this.assertExpectedState(session, body && typeof body === 'object' ? (body as Record<string, unknown>).expectedState : undefined);
    let blueprint = parseJson<Blueprint | null>(session.blueprintJson, null);
    const submitted = body && typeof body === 'object'
      ? (body as Record<string, unknown>).blueprint
      : undefined;
    if (submitted !== undefined) {
      const parsed = projectBlueprintValidator.safeParse(submitted);
      if (!parsed.success) {
        throw new BadRequestException(`Invalid blueprint: ${parsed.error.message}`);
      }
      blueprint = parsed.data;
      this.validateBlueprint(blueprint);
      this.database.orm
        .update(projectCreationSessions)
        .set({ blueprintJson: stringifyJson(blueprint), updatedAt: now() })
        .where(eq(projectCreationSessions.id, sessionId))
        .run();
    }
    if (!blueprint) throw new ConflictException('Blueprint is missing');
    this.validateBlueprint(blueprint);
    const projectId = id();
    const stamp = now();
    const canonIds: string[] = [];
    this.database.connection.transaction(() => {
      this.projects.createInternal({
        id: projectId,
        title: blueprint.title,
        logline: blueprint.logline,
        genreTags: blueprint.genreTags,
        details: blueprint.details,
        defaultTargetChars: blueprint.defaultTargetChars,
      });
      for (const item of blueprint.canon ?? []) {
        const canonId = id();
        canonIds.push(canonId);
        this.database.orm.insert(canonEntries).values({
          id: canonId,
          projectId,
          category: item.category,
          name: item.name,
          aliasesJson: stringifyJson(item.aliases ?? []),
          content: item.content,
          metadataJson: stringifyJson(item.metadata ?? {}),
          status: 'ACTIVE',
          revision: 1,
          sourceEpisodeId: null,
          createdAt: stamp,
          updatedAt: stamp,
        }).run();
      }
      this.database.orm.insert(arcs).values({
        id: id(),
        projectId,
        title: blueprint.arc.title,
        startEpisodeNumber: blueprint.arc.startEpisode,
        endEpisodeNumber: blueprint.arc.endEpisode,
        goal: blueprint.arc.goal,
        conflict: blueprint.arc.conflict,
        reversalPlanJson: stringifyJson(blueprint.arc.reversalPlan),
        status: 'ACTIVE',
        revision: 1,
        createdAt: stamp,
        updatedAt: stamp,
      }).run();
      this.database.orm
        .update(projectCreationSessions)
        .set({ status: 'COMMITTED', projectId, updatedAt: stamp })
        .where(eq(projectCreationSessions.id, sessionId))
        .run();
    })();
    await Promise.all(
      canonIds.map(async (canonId) => {
        const canon = this.database.orm.select().from(canonEntries).where(eq(canonEntries.id, canonId)).get();
        if (canon) {
          await this.memory.indexSource({
            projectId,
            sourceType: 'CANON',
            sourceId: canon.id,
            text: `${canon.name}\n${canon.content}`,
          });
        }
      }),
    );
    return { project: this.projects.get(projectId) };
  }

  private next(session: SessionRow) {
    const key = `${session.id}:${this.stateToken(session)}`;
    const existing = this.pendingTurns.get(key);
    if (existing) return existing;
    const promise = this.generateNext(session).finally(() => this.pendingTurns.delete(key));
    this.pendingTurns.set(key, promise);
    return promise;
  }

  private async generateNext(session: SessionRow) {
    const answers = parseJson<Record<string, unknown>>(session.answersJson, {});
    const transcript = parseJson<Array<Record<string, unknown>>>(session.transcriptJson, []);
    const { result } = await this.ai.completeText({
      task: 'project_interview',
      promptId: 'project-interview',
      variables: {
        project_title: typeof answers.title === 'string' ? answers.title : '',
        logline: session.logline,
        genre_tags: parseJson(session.genreTagsJson, []),
        interview_answers: transcript,
      },
      tools: projectInterviewTools,
      toolChoice: 'required',
      includeCore: false,
      includeMemoryContract: false,
      maxTokens: 2_000,
    });
    const call = result.toolCalls[0];
    if (!call) throw new BadGatewayException('AI interview returned no tool call');
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(call.function.arguments) as Record<string, unknown>;
    } catch {
      throw new BadGatewayException('AI interview returned invalid tool arguments');
    }

    if (call.function.name === 'ask_project_details') {
      const requested = this.parseQuestion(args);
      if (
        !session.titleAsked &&
        (requested.field !== 'title' ||
          !requested.required ||
          !['text', 'long_text'].includes(requested.inputType))
      ) {
        throw new BadGatewayException(
          'AI interview must ask for the required title as a text question first',
        );
      }
      const question = requested;
      this.updateSession(session, {
        pendingQuestionJson: stringifyJson(question),
        titleAsked: session.titleAsked || question.field === 'title' ? 1 : 0,
      });
      return this.result(this.requireSession(session.id));
    }
    if (call.function.name !== 'complete_project_interview') {
      throw new BadGatewayException(`Unknown interview tool: ${call.function.name}`);
    }
    if (!session.titleAsked || typeof answers.title !== 'string' || !answers.title.trim()) {
      throw new BadGatewayException('AI interview attempted to finish before asking for the title');
    }

    const { value: blueprint } = await this.ai.completeJson<Blueprint>({
      task: 'project_blueprint',
      promptId: 'project-blueprint',
      variables: {
        project_title: answers.title,
        logline: session.logline,
        genre_tags: parseJson(session.genreTagsJson, []),
        interview_answers: transcript,
      },
      schema: { name: 'project_blueprint', value: projectBlueprintSchema },
      validator: projectBlueprintValidator,
      includeCore: false,
      includeMemoryContract: false,
      maxTokens: 12_000,
    });
    this.updateSession(session, {
      blueprintJson: stringifyJson(blueprint),
      pendingQuestionJson: null,
      status: 'READY',
    });
    return this.result(this.requireSession(session.id));
  }

  private parseQuestion(args: Record<string, unknown>): SetupQuestion {
    const inputType = ['text', 'long_text', 'single', 'multi'].includes(String(args.inputType))
      ? (args.inputType as SetupQuestion['inputType'])
      : 'text';
    return {
      id: requireString(args.id, 'question.id', { max: 100 }),
      field: requireString(args.field, 'question.field', { max: 100 }),
      prompt: requireString(args.prompt, 'question.prompt', { max: 1_000 }),
      inputType,
      options: Array.isArray(args.options)
        ? stringArray(args.options.filter((item): item is string => typeof item === 'string'), 'question.options')
        : [],
      required: args.required === true,
    };
  }

  private validateBlueprint(blueprint: Blueprint): void {
    if (!blueprint.title.trim()) throw new BadRequestException('Blueprint title is required');
    const span = blueprint.arc.endEpisode - blueprint.arc.startEpisode + 1;
    if (span < 5 || span > 20) {
      throw new BadRequestException('Blueprint arc must span between 5 and 20 episodes');
    }
  }

  private requireSession(sessionId: string): SessionRow {
    const session = this.database.orm
      .select()
      .from(projectCreationSessions)
      .where(eq(projectCreationSessions.id, sessionId))
      .get();
    if (!session) throw new NotFoundException('Project creation session not found');
    return session;
  }

  private stateToken(session: SessionRow): string {
    return sha256(stringifyJson(session));
  }

  private normalizeQuestion(question: SetupQuestion): SetupQuestion {
    return { ...question, options: stringArray(question.options ?? [], 'question.options') };
  }

  private assertExpectedState(session: SessionRow, expected: unknown): void {
    if (expected !== undefined && expected !== this.stateToken(session)) {
      throw new ConflictException('Interview has changed. Reload the latest questions before continuing');
    }
  }

  private updateSession(session: SessionRow, values: Partial<typeof projectCreationSessions.$inferInsert>): void {
    // A strictly increasing stamp protects against concurrent turns even when
    // requests or mocked AI calls complete within the same millisecond.
    const updatedAt = new Date(Math.max(Date.now(), Date.parse(session.updatedAt) + 1)).toISOString();
    const updated = this.database.orm.update(projectCreationSessions)
      .set({ ...values, updatedAt })
      .where(and(eq(projectCreationSessions.id, session.id), eq(projectCreationSessions.updatedAt, session.updatedAt)))
      .run();
    if (!updated.changes) throw new ConflictException('Interview changed while the AI was responding');
  }

  private result(session: SessionRow) {
    const storedQuestion = parseJson<SetupQuestion | null>(session.pendingQuestionJson, null);
    const pending = storedQuestion ? this.normalizeQuestion(storedQuestion) : null;
    const blueprint = parseJson<Blueprint | null>(session.blueprintJson, null);
    return {
      history: parseJson<AnswerRecord[]>(session.transcriptJson, []).map((entry) => ({
        ...entry, question: this.normalizeQuestion(entry.question),
      })),
      stateToken: this.stateToken(session),
      session: {
        id: session.id,
        status: session.status,
        projectId: session.projectId,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
      },
      step: pending
        ? { type: 'question' as const, question: pending }
        : { type: 'ready' as const, blueprint },
    };
  }
}
