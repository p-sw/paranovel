import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { AiRunnerService } from '../ai/ai-runner.service';
import { ArcEpisodeDirectionsService } from '../ai/arc-episode-directions.service';
import {
  type ArcMilestone,
  type ProjectBlueprint as AiProjectBlueprint,
  type ProjectBlueprintMilestones,
  projectBlueprintValidator,
  projectBlueprintMilestonesSchema,
  projectBlueprintMilestonesValidator,
  projectInterviewTools,
} from '../ai/ai.schemas';
import { DatabaseService } from '../database/database.service';
import { arcs, canonEntries, projectCreationSessions } from '../database/schema';
import { formatArcMemory } from '../memory/arc-memory';
import { formatCanonMemory } from '../memory/canon-memory';
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
  suggestedAnswer?: string;
}

export type Blueprint = AiProjectBlueprint;

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
    private readonly arcDirections: ArcEpisodeDirectionsService,
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
    let session = this.requireSession(sessionId);
    if (session.status === 'READY' && !this.parseStoredBlueprint(session.blueprintJson)) {
      const milestones = this.parseStoredMilestoneBlueprint(session.blueprintJson);
      if (milestones) {
        const blueprint = await this.completeBlueprintDirections(milestones);
        this.updateSession(session, { blueprintJson: stringifyJson(blueprint) });
      } else {
        // Older READY sessions with an unusable shape are reopened rather than
        // returning a null blueprint. Valid legacy reversal plans are upgraded
        // above and keep their original descriptions as REVERSAL milestones.
        this.updateSession(session, {
          status: 'ACTIVE',
          blueprintJson: null,
          pendingQuestionJson: null,
        });
      }
      session = this.requireSession(sessionId);
    }
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
    if (!skip && pending.field === 'title') {
      answer = requireString(answer, 'title', { max: 200 });
    }
    if (!skip && pending.field === 'targetEpisode') {
      const targetEpisode = this.parseTargetEpisode(answer);
      if (targetEpisode === null) {
        throw new BadRequestException('Target episode must be a whole number between 5 and 2000');
      }
      answer = String(targetEpisode);
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
      await this.indexCommittedProject(session.projectId);
      return { project: this.projects.get(session.projectId) };
    }
    if (session.status !== 'READY' || !session.blueprintJson) {
      throw new ConflictException('Project interview is not ready to commit');
    }
    this.assertExpectedState(session, body && typeof body === 'object' ? (body as Record<string, unknown>).expectedState : undefined);
    let blueprint = this.parseStoredBlueprint(session.blueprintJson);
    if (!blueprint) {
      const milestones = this.parseStoredMilestoneBlueprint(session.blueprintJson);
      if (milestones) blueprint = await this.completeBlueprintDirections(milestones);
    }
    const submitted = body && typeof body === 'object'
      ? (body as Record<string, unknown>).blueprint
      : undefined;
    if (submitted !== undefined) {
      const normalized = this.normalizeBlueprintInput(submitted);
      const adjusted = normalized && typeof normalized === 'object' && !Array.isArray(normalized)
        ? {
            ...(normalized as Record<string, unknown>),
            targetEpisodeSource:
              Number((normalized as Record<string, unknown>).targetEpisode) !== blueprint?.targetEpisode
                ? 'USER'
                : this.targetSourceFromTranscript(session) ?? (normalized as Record<string, unknown>).targetEpisodeSource,
          }
        : normalized;
      const parsed = projectBlueprintValidator.safeParse(adjusted);
      if (!parsed.success) {
        throw new BadRequestException(`Invalid blueprint: ${parsed.error.message}`);
      }
      blueprint = parsed.data;
      this.validateBlueprint(blueprint);
    }
    if (!blueprint) throw new ConflictException('Blueprint is missing');
    this.validateBlueprint(blueprint);
    const projectId = id();
    const stamp = new Date(Math.max(Date.now(), Date.parse(session.updatedAt) + 1)).toISOString();
    this.database.connection.transaction(() => {
      this.projects.createInternal({
        id: projectId,
        title: blueprint.title,
        logline: blueprint.logline,
        genreTags: blueprint.genreTags,
        writingDirection: blueprint.writingDirection,
        defaultTargetChars: blueprint.defaultTargetChars,
        targetEpisode: blueprint.targetEpisode,
        targetEpisodeSource: blueprint.targetEpisodeSource,
      });
      for (const item of blueprint.canon ?? []) {
        const canonId = id();
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
      for (const [index, arc] of blueprint.arcs.entries()) {
        this.database.orm.insert(arcs).values({
          id: id(),
          projectId,
          title: arc.title,
          startEpisodeNumber: arc.startEpisode,
          endEpisodeNumber: arc.endEpisode,
          goal: arc.goal,
          conflict: arc.conflict,
          reversalPlanJson: '[]',
          milestonePlanJson: stringifyJson(arc.milestones),
          episodeDirectionsJson: stringifyJson(arc.episodeDirections),
          status: index === 0 ? 'ACTIVE' : 'PLANNED',
          revision: 1,
          createdAt: stamp,
          updatedAt: stamp,
        }).run();
      }
      const committed = this.database.orm
        .update(projectCreationSessions)
        .set({
          status: 'COMMITTED',
          projectId,
          blueprintJson: stringifyJson(blueprint),
          updatedAt: stamp,
        })
        .where(and(
          eq(projectCreationSessions.id, sessionId),
          eq(projectCreationSessions.status, 'READY'),
          eq(projectCreationSessions.updatedAt, session.updatedAt),
        ))
        .run();
      if (committed.changes !== 1) {
        throw new ConflictException('Project interview was committed or changed concurrently');
      }
    }).immediate();
    await this.indexCommittedProject(projectId);
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
    if (
      typeof answers.title === 'string' &&
      answers.title.trim() &&
      !transcript.some((entry) => (entry.question as Record<string, unknown> | undefined)?.field === 'targetEpisode')
    ) {
      const question: SetupQuestion = {
        id: 'target-episode',
        field: 'targetEpisode',
        prompt: '몇 화에 완결하는 것을 목표로 할까요?',
        inputType: 'text',
        options: [],
        required: false,
      };
      this.updateSession(session, { pendingQuestionJson: stringifyJson(question) });
      return this.result(this.requireSession(session.id));
    }
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
          !['text', 'long_text'].includes(requested.inputType) ||
          !requested.suggestedAnswer?.trim())
      ) {
        throw new BadGatewayException(
          'AI interview must ask for the required title as a text question first',
        );
      }
      if (
        ['title', 'targetEpisode'].includes(requested.field)
        && transcript.some((entry) => (entry.question as Record<string, unknown> | undefined)?.field === requested.field)
      ) {
        throw new BadGatewayException(`AI interview attempted to ask reserved field ${requested.field} again`);
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
    const targetRecord = transcript.find((entry) => {
      const question = entry.question as Record<string, unknown> | undefined;
      return question?.field === 'targetEpisode';
    }) as AnswerRecord | undefined;
    if (!targetRecord) {
      throw new BadGatewayException('AI interview attempted to finish before collecting the target episode');
    }
    const targetSource = targetRecord.skipped ? 'AI' as const : 'USER' as const;
    const requestedTarget = targetRecord.skipped ? null : this.parseTargetEpisode(targetRecord.answer);
    const blueprintValidator = projectBlueprintMilestonesValidator.superRefine((value, context) => {
      if (value.targetEpisodeSource !== targetSource) {
        context.addIssue({ code: 'custom', message: `targetEpisodeSource must be ${targetSource}`, path: ['targetEpisodeSource'] });
      }
      if (requestedTarget !== null && value.targetEpisode !== requestedTarget) {
        context.addIssue({ code: 'custom', message: `targetEpisode must be ${requestedTarget}`, path: ['targetEpisode'] });
      }
    });

    const { value: milestoneBlueprint } = await this.ai.completeJson<ProjectBlueprintMilestones>({
      task: 'project_blueprint_milestones',
      promptId: 'project-blueprint',
      variables: {
        project_title: answers.title,
        logline: session.logline,
        genre_tags: parseJson(session.genreTagsJson, []),
        interview_answers: transcript,
        target_episode_answer: targetRecord.answer,
        interview_completion: args,
      },
      schema: { name: 'project_blueprint_milestones', value: projectBlueprintMilestonesSchema },
      validator: blueprintValidator,
      includeCore: false,
      includeMemoryContract: false,
      maxTokens: 24_000,
    });
    const blueprint = await this.completeBlueprintDirections(milestoneBlueprint);
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
    const suggestedAnswer = typeof args.suggestedAnswer === 'string' && args.suggestedAnswer.trim()
      ? requireString(args.suggestedAnswer, 'question.suggestedAnswer', { max: 200 })
      : undefined;
    return {
      id: requireString(args.id, 'question.id', { max: 100 }),
      field: requireString(args.field, 'question.field', { max: 100 }),
      prompt: requireString(args.prompt, 'question.prompt', { max: 1_000 }),
      inputType,
      options: Array.isArray(args.options)
        ? stringArray(args.options.filter((item): item is string => typeof item === 'string'), 'question.options')
        : [],
      required: args.required === true,
      ...(suggestedAnswer ? { suggestedAnswer } : {}),
    };
  }

  private validateBlueprint(blueprint: Blueprint): void {
    const parsed = projectBlueprintValidator.safeParse(blueprint);
    if (!parsed.success) throw new BadRequestException(`Invalid blueprint: ${parsed.error.message}`);
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
    return {
      ...question,
      options: stringArray(question.options ?? [], 'question.options'),
      ...(question.suggestedAnswer?.trim() ? { suggestedAnswer: question.suggestedAnswer.trim() } : {}),
    };
  }

  private parseTargetEpisode(answer: AnswerRecord['answer']): number | null {
    const text = typeof answer === 'string' ? answer : Array.isArray(answer) ? answer.join(' ') : '';
    const match = text.replaceAll(',', '').match(/^\s*(\d+)(?:\s*화)?\s*$/);
    if (!match) return null;
    const value = Number(match[1]);
    return Number.isInteger(value) && value >= 5 && value <= 2_000 ? value : null;
  }

  private targetSourceFromTranscript(session: SessionRow): Blueprint['targetEpisodeSource'] | null {
    const record = parseJson<AnswerRecord[]>(session.transcriptJson, [])
      .find((entry) => entry.question.field === 'targetEpisode');
    return record ? (record.skipped ? 'AI' : 'USER') : null;
  }

  private normalizeBlueprintInput(value: unknown): unknown {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const normalized = { ...(value as Record<string, unknown>) };
    if (normalized.writingDirection === undefined && typeof normalized.details === 'string') {
      normalized.writingDirection = normalized.details;
    }
    delete normalized.details;
    let result = normalized;
    if (!Array.isArray(normalized.arcs) && normalized.arc && typeof normalized.arc === 'object') {
      const legacyArc = normalized.arc as Record<string, unknown>;
      const { arc: _legacyArc, ...rest } = normalized;
      result = {
        ...rest,
        targetEpisode: legacyArc.endEpisode,
        targetEpisodeSource: 'AI',
        arcs: [legacyArc],
      };
    }
    if (Array.isArray(result.arcs)) {
      result.arcs = result.arcs.map((arc) => this.normalizeBlueprintArc(arc));
    }
    return result;
  }

  private normalizeBlueprintArc(value: unknown): unknown {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const arc = { ...(value as Record<string, unknown>) };
    if (!Array.isArray(arc.milestones)) {
      const reversals = Array.isArray(arc.reversalPlan) ? arc.reversalPlan : [];
      const milestones: ArcMilestone[] = reversals.flatMap((raw): ArcMilestone[] => {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
        const reversal = raw as Record<string, unknown>;
        if (!Number.isInteger(reversal.episode) || typeof reversal.description !== 'string') return [];
        return [{
          ...(typeof reversal.id === 'string' && reversal.id ? { id: reversal.id } : {}),
          episode: Number(reversal.episode),
          type: 'REVERSAL' as const,
          // Do not trim or rewrite legacy text during compatibility recovery.
          description: reversal.description,
        }];
      });
      if (
        milestones.length === 0
        && Number.isInteger(arc.endEpisode)
        && typeof arc.goal === 'string'
        && arc.goal.trim()
      ) {
        milestones.push({
          episode: Number(arc.endEpisode),
          type: 'GOAL',
          description: arc.goal,
        });
      }
      arc.milestones = milestones;
    }
    delete arc.reversalPlan;
    return arc;
  }

  private parseStoredBlueprint(json: string | null): Blueprint | null {
    const raw = this.normalizeBlueprintInput(parseJson<unknown>(json, null));
    const parsed = projectBlueprintValidator.safeParse(raw);
    return parsed.success ? parsed.data : null;
  }

  private parseStoredMilestoneBlueprint(json: string | null): ProjectBlueprintMilestones | null {
    const raw = this.normalizeBlueprintInput(parseJson<unknown>(json, null));
    const parsed = projectBlueprintMilestonesValidator.safeParse(raw);
    return parsed.success ? parsed.data : null;
  }

  private async completeBlueprintDirections(
    milestoneBlueprint: ProjectBlueprintMilestones,
  ): Promise<Blueprint> {
    const surroundingArcs = milestoneBlueprint.arcs.map((arc) => ({
      title: arc.title,
      startEpisodeNumber: arc.startEpisode,
      endEpisodeNumber: arc.endEpisode,
      goal: arc.goal,
      conflict: arc.conflict,
      milestones: arc.milestones,
    }));
    const directions = await this.arcDirections.generateMany(
      milestoneBlueprint.arcs.map((arc) => ({
        projectContext: {
          title: milestoneBlueprint.title,
          logline: milestoneBlueprint.logline,
          genreTags: milestoneBlueprint.genreTags,
          targetEpisode: milestoneBlueprint.targetEpisode,
        },
        writingDirection: milestoneBlueprint.writingDirection,
        canon: milestoneBlueprint.canon,
        surroundingArcs,
        arc: {
          title: arc.title,
          startEpisodeNumber: arc.startEpisode,
          endEpisodeNumber: arc.endEpisode,
          goal: arc.goal,
          conflict: arc.conflict,
          milestones: arc.milestones,
        },
        generationRequest: '프로젝트 초기 청사진의 마일스톤을 모든 회차의 전개 방향으로 연결한다.',
      })),
    );
    const completed = {
      ...milestoneBlueprint,
      arcs: milestoneBlueprint.arcs.map((arc, index) => ({
        ...arc,
        episodeDirections: directions[index]!,
      })),
    };
    const parsed = projectBlueprintValidator.safeParse(completed);
    if (!parsed.success) {
      throw new BadGatewayException(`AI generated an incomplete project blueprint: ${parsed.error.message}`);
    }
    return parsed.data;
  }

  private async indexCommittedProject(projectId: string): Promise<void> {
    const canon = this.database.orm.select().from(canonEntries).where(eq(canonEntries.projectId, projectId)).all()
      .filter((entry) => ['ACTIVE', 'ACCEPTED'].includes(entry.status));
    const activeArcs = this.database.orm.select().from(arcs).where(eq(arcs.projectId, projectId)).all()
      .filter((arc) => arc.status === 'ACTIVE');
    await Promise.all([
      ...canon.map((entry) => this.memory.indexSource({
        projectId,
        sourceType: 'CANON',
        sourceId: entry.id,
        text: formatCanonMemory(entry),
      })),
      ...activeArcs.map((arc) => this.memory.indexSource({
        projectId,
        sourceType: 'ARC',
        sourceId: arc.id,
        text: formatArcMemory(arc),
      })),
    ]);
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
    const blueprint = this.parseStoredBlueprint(session.blueprintJson);
    if (!pending && !blueprint) {
      throw new ConflictException('Project interview has no valid pending question or blueprint');
    }
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
