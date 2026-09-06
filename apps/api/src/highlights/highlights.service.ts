import {
  BadGatewayException, BadRequestException, ConflictException, Injectable,
  NotFoundException, OnModuleInit, ServiceUnavailableException,
} from '@nestjs/common';
import { and, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { AiRunnerService } from '../ai/ai-runner.service';
import { AnimeImageService } from '../ai/anime-image.service';
import { DatabaseService } from '../database/database.service';
import { canonEntries, episodeHighlights, episodes, projects } from '../database/schema';
import { id, now, parseJson, stringifyJson } from '../shared/utils';
import { HighlightStorageService } from './highlight-storage.service';
import { generateAnimeImageTool, highlightParagraphs, highlightPlanValidator, type HighlightPlan } from './highlight.schemas';

type HighlightRow = typeof episodeHighlights.$inferSelect;
type ProviderResult = Awaited<ReturnType<AnimeImageService['generate']>>;
const generationInput = z.strictObject({ expectedRevision: z.number().int().positive() });
const placementInput = z.strictObject({
  expectedEpisodeRevision: z.number().int().positive(),
  expectedImageId: z.string().min(1),
  afterParagraphId: z.number().int().positive(),
});
const removeInput = z.strictObject({ expectedImageId: z.string().min(1) });

@Injectable()
export class HighlightsService implements OnModuleInit {
  constructor(
    private readonly database: DatabaseService,
    private readonly ai: AiRunnerService,
    private readonly anime: AnimeImageService,
    private readonly storage: HighlightStorageService,
  ) {}

  onModuleInit(): void {
    this.database.orm.update(episodeHighlights).set({
      status: 'FAILED', fileName: null, mimeType: null, completedAt: now(),
      error: '서버가 재시작되어 이미지 생성이 중단되었습니다. 상태를 확인한 뒤 다시 시도해 주세요.',
    }).where(eq(episodeHighlights.status, 'RUNNING')).run();
    this.storage.recover();
  }

  get(projectId: string, episodeId: string) {
    this.requireEpisode(projectId, episodeId);
    return this.view(projectId, episodeId);
  }

  async generate(projectId: string, episodeId: string, body: unknown, idempotencyKey?: string) {
    const parsed = generationInput.safeParse(body);
    if (!parsed.success || !idempotencyKey?.trim() || idempotencyKey.length > 200) {
      throw new BadRequestException('expectedRevision과 1~200자의 Idempotency-Key가 필요합니다.');
    }
    const requestKey = idempotencyKey;
    const turn = this.database.connection.transaction(() => {
      const episode = this.requireEpisode(projectId, episodeId);
      const existing = this.database.orm.select().from(episodeHighlights)
        .where(and(eq(episodeHighlights.episodeId, episodeId), eq(episodeHighlights.idempotencyKey, requestKey))).get();
      if (existing && existing.sourceRevision !== parsed.data.expectedRevision) {
        throw new ConflictException('같은 Idempotency-Key에 다른 회차 버전을 사용할 수 없습니다.');
      }
      // Replaying a failed provider request never calls the paid API again.
      // Only a known successful URL can be retried, and then only its download.
      if (existing && (existing.status !== 'FAILED' || !existing.providerResultJson)) {
        return { row: existing, replay: true };
      }
      const pending = this.database.orm.select({ id: episodeHighlights.id }).from(episodeHighlights)
        .where(and(eq(episodeHighlights.episodeId, episodeId), eq(episodeHighlights.status, 'RUNNING'))).get();
      if (pending) throw new ConflictException('이 회차의 이미지를 생성하고 있습니다. 완료될 때까지 기다려 주세요.');
      if (existing) {
        // Do not revive an old result over an image the user generated later.
        const latest = this.latest(episodeId);
        if (latest?.id !== existing.id) return { row: existing, replay: true };
        this.database.orm.update(episodeHighlights).set({ status: 'RUNNING', error: null, completedAt: null })
          .where(eq(episodeHighlights.id, existing.id)).run();
        return { row: { ...existing, status: 'RUNNING' }, replay: false };
      }
      if (episode.revision !== parsed.data.expectedRevision) throw new ConflictException('본문이 변경되었습니다. 저장된 최신 회차로 다시 시도해 주세요.');
      if (!episode.content.trim()) throw new BadRequestException('본문을 작성한 뒤 하이라이트 이미지를 생성해 주세요.');
      if (!this.anime.isConfigured() || !process.env.OPENROUTER_API_KEY?.trim()) {
        throw new ServiceUnavailableException('이미지 생성에는 서버의 ANIMEAPI_API_KEY와 OPENROUTER_API_KEY 설정이 필요합니다.');
      }
      const project = this.database.orm.select().from(projects).where(eq(projects.id, projectId)).get()!;
      const canon = this.database.orm.select().from(canonEntries).where(and(
        eq(canonEntries.projectId, projectId), inArray(canonEntries.status, ['ACTIVE', 'ACCEPTED']),
      )).all().map((entry) => ({
        ref: `canon:${entry.id}`, revision: entry.revision, category: entry.category,
        name: entry.name, aliases: parseJson<string[]>(entry.aliasesJson, []), content: entry.content,
      }));
      const snapshot = {
        project_context: { title: project.title, logline: project.logline, genreTags: parseJson(project.genreTagsJson, []), details: parseJson(project.detailsJson, '') },
        canon, episode_title: episode.title, episode_direction: episode.direction,
      };
      const snapshotJson = stringifyJson(snapshot);
      const configuredLimit = Number(process.env.AI_MANDATORY_CONTEXT_MAX_CHARS ?? 400_000);
      const contextLimit = Number.isFinite(configuredLimit) && configuredLimit > 0 ? configuredLimit : 400_000;
      if (snapshotJson.length + episode.content.length > contextLimit) {
        throw new BadRequestException('정사와 본문이 이미지 생성 문맥 한도를 초과했습니다. AI_MANDATORY_CONTEXT_MAX_CHARS 설정을 확인해 주세요.');
      }
      const row: typeof episodeHighlights.$inferInsert = {
        id: id(), projectId, episodeId, idempotencyKey: requestKey,
        sourceRevision: episode.revision, sourceContent: episode.content,
        canonSnapshotJson: snapshotJson, status: 'RUNNING', isCurrent: false,
        createdAt: now(),
      };
      this.database.orm.insert(episodeHighlights).values(row).run();
      return { row: this.requireRow(row.id!), replay: false };
    }).immediate();

    if (turn.replay) return this.view(projectId, episodeId);
    await this.execute(turn.row);
    return this.view(projectId, episodeId);
  }

  place(projectId: string, episodeId: string, body: unknown) {
    const parsed = placementInput.safeParse(body);
    if (!parsed.success) throw new BadRequestException('이미지와 회차 버전, 배치할 문단을 올바르게 지정해 주세요.');
    this.database.connection.transaction(() => {
      const episode = this.requireEpisode(projectId, episodeId);
      if (episode.revision !== parsed.data.expectedEpisodeRevision) throw new ConflictException('본문이 변경되었습니다. 최신 본문에서 위치를 다시 선택해 주세요.');
      const image = this.current(episodeId);
      if (!image || image.id !== parsed.data.expectedImageId) throw new ConflictException('하이라이트 이미지가 변경되었습니다.');
      const paragraph = highlightParagraphs(episode.content).find((item) => item.id === parsed.data.afterParagraphId);
      if (!paragraph) throw new BadRequestException('선택한 문단이 본문에 없습니다.');
      this.database.orm.update(episodeHighlights).set({
        anchorSourceContent: episode.content, anchorText: paragraph.text, anchorOffset: paragraph.end,
      }).where(eq(episodeHighlights.id, image.id)).run();
    }).immediate();
    return this.view(projectId, episodeId);
  }

  remove(projectId: string, episodeId: string, body: unknown) {
    const parsed = removeInput.safeParse(body);
    if (!parsed.success) throw new BadRequestException('제거할 이미지 ID가 필요합니다.');
    this.database.connection.transaction(() => {
      this.requireEpisode(projectId, episodeId);
      const pending = this.database.orm.select({ id: episodeHighlights.id }).from(episodeHighlights)
        .where(and(eq(episodeHighlights.episodeId, episodeId), eq(episodeHighlights.status, 'RUNNING'))).get();
      if (pending) throw new ConflictException('이미지 생성이 끝난 뒤 제거해 주세요.');
      const image = this.current(episodeId);
      if (!image || image.id !== parsed.data.expectedImageId) throw new ConflictException('하이라이트 이미지가 변경되었습니다.');
      this.database.orm.update(episodeHighlights).set({ isCurrent: false, fileName: null, mimeType: null })
        .where(eq(episodeHighlights.id, image.id)).run();
    }).immediate();
    this.storage.cleanup();
    return this.view(projectId, episodeId);
  }

  imageFile(projectId: string, episodeId: string, imageId: string) {
    this.requireEpisode(projectId, episodeId);
    const image = this.current(episodeId);
    if (!image || image.id !== imageId || !image.fileName || !image.mimeType) throw new NotFoundException('이미지를 찾을 수 없습니다.');
    return { path: this.storage.path(image.fileName), mimeType: image.mimeType };
  }

  private async execute(row: HighlightRow): Promise<void> {
    let phase: 'PLAN' | 'GENERATE' | 'DOWNLOAD' | 'STORE' = row.providerResultJson ? 'DOWNLOAD' : 'PLAN';
    try {
      let plan: HighlightPlan;
      let provider: ProviderResult;
      if (row.providerResultJson) {
        plan = highlightPlanValidator.parse(JSON.parse(row.planJson!));
        provider = JSON.parse(row.providerResultJson) as ProviderResult;
      } else {
        const paragraphs = highlightParagraphs(row.sourceContent);
        const snapshot = JSON.parse(row.canonSnapshotJson) as Record<string, unknown>;
        const result = await this.ai.completeTool({
          task: 'episode_highlight', promptId: 'episode-highlight', projectId: row.projectId, episodeId: row.episodeId,
          variables: { ...snapshot, episode_paragraphs: paragraphs.map(({ id: paragraphId, text }) => ({ id: paragraphId, text })) },
          tool: generateAnimeImageTool, validator: highlightPlanValidator,
          validateValue: (value) => paragraphs.some((paragraph) => paragraph.id === value.afterParagraphId),
          maxTokens: 3_000, signal: AbortSignal.timeout(120_000),
        });
        // Validate again at the side-effect boundary, even with alternate AI adapters.
        plan = highlightPlanValidator.parse(result.value);
        if (!paragraphs.some((paragraph) => paragraph.id === plan.afterParagraphId)) throw new BadGatewayException();
        this.requireRow(row.id);
        this.database.orm.update(episodeHighlights).set({ planJson: stringifyJson(plan), runId: result.runId })
          .where(eq(episodeHighlights.id, row.id)).run();
        phase = 'GENERATE';
        provider = await this.anime.generate({ prompt: plan.prompt, orientation: plan.orientation, allowNSFW: plan.allowNSFW });
        this.requireRow(row.id);
        // Durable provider result makes a failed download retry safe without a
        // second paid generation, including recovery after a process restart.
        this.database.orm.update(episodeHighlights).set({ providerResultJson: stringifyJson(provider) })
          .where(eq(episodeHighlights.id, row.id)).run();
      }
      phase = 'DOWNLOAD';
      const image = await this.anime.download(provider.imageUrl);
      this.requireRow(row.id);
      phase = 'STORE';
      const fileName = `${row.id}.${image.extension}`;
      this.database.orm.update(episodeHighlights).set({ fileName, mimeType: image.mimeType })
        .where(eq(episodeHighlights.id, row.id)).run();
      await this.storage.write(fileName, image.bytes);
      const paragraph = highlightParagraphs(row.sourceContent).find((item) => item.id === plan.afterParagraphId)!;
      this.database.connection.transaction(() => {
        this.requireRow(row.id);
        this.requireEpisode(row.projectId, row.episodeId);
        this.database.orm.update(episodeHighlights).set({ isCurrent: false, fileName: null, mimeType: null })
          .where(and(eq(episodeHighlights.episodeId, row.episodeId), eq(episodeHighlights.isCurrent, true), ne(episodeHighlights.id, row.id))).run();
        this.database.orm.update(episodeHighlights).set({
          status: 'SUCCEEDED', isCurrent: true, error: null, completedAt: now(),
          anchorSourceContent: row.sourceContent, anchorText: paragraph.text, anchorOffset: paragraph.end,
        }).where(eq(episodeHighlights.id, row.id)).run();
      }).immediate();
    } catch (error) {
      const message = phase === 'PLAN'
        ? 'AI가 하이라이트 장면을 고르지 못했습니다. 다시 생성해 주세요.'
        : phase === 'GENERATE'
          ? 'AnimeAPI 이미지 생성에 실패했거나 결과를 확인하지 못했습니다. API 키·잔액·한도를 확인한 뒤 다시 생성해 주세요.'
          : '생성된 이미지를 저장하지 못했습니다. 다운로드를 다시 시도해 주세요.';
      this.database.orm.update(episodeHighlights).set({
        status: 'FAILED', error: message, completedAt: now(), fileName: null, mimeType: null,
      }).where(eq(episodeHighlights.id, row.id)).run();
      // Deletion can race with the final rename after its cascade cleanup ran.
      // Queue all possible server-generated filenames even when the row is gone.
      for (const extension of ['webp', 'png', 'jpg']) {
        this.database.connection.prepare('INSERT OR IGNORE INTO highlight_file_cleanup(file_name) VALUES (?)').run(`${row.id}.${extension}`);
      }
      if (error instanceof NotFoundException) throw error;
      // Persisted FAILED state is the response: reloads and ambiguous transport
      // failures expose the same result without silently initiating another POST.
    } finally {
      this.storage.cleanup();
    }
  }

  private current(episodeId: string) {
    return this.database.orm.select().from(episodeHighlights)
      .where(and(eq(episodeHighlights.episodeId, episodeId), eq(episodeHighlights.isCurrent, true))).get();
  }

  private latest(episodeId: string) {
    return this.database.orm.select().from(episodeHighlights).where(eq(episodeHighlights.episodeId, episodeId))
      .orderBy(desc(sql`rowid`)).get();
  }

  private view(projectId: string, episodeId: string) {
    const image = this.current(episodeId);
    const latest = this.latest(episodeId);
    const plan = image?.planJson ? parseJson<HighlightPlan | null>(image.planJson, null) : null;
    return {
      configured: this.anime.isConfigured() && Boolean(process.env.OPENROUTER_API_KEY?.trim()),
      image: image && image.fileName && plan ? {
        id: image.id,
        url: `/api/projects/${encodeURIComponent(projectId)}/episodes/${encodeURIComponent(episodeId)}/highlight/${image.id}/image`,
        altText: plan.altText, generatedSourceRevision: image.sourceRevision,
        generatedSourceContent: image.sourceContent,
        anchorSourceContent: image.anchorSourceContent!, anchorText: image.anchorText!, anchorOffset: image.anchorOffset!,
        createdAt: image.completedAt ?? image.createdAt,
      } : null,
      generation: latest ? {
        id: latest.id, status: latest.status as 'RUNNING' | 'SUCCEEDED' | 'FAILED',
        error: latest.error, retryableDownload: latest.status === 'FAILED' && Boolean(latest.providerResultJson),
        idempotencyKey: latest.idempotencyKey, expectedRevision: latest.sourceRevision,
      } : null,
    };
  }

  private requireRow(rowId: string): HighlightRow {
    const row = this.database.orm.select().from(episodeHighlights).where(eq(episodeHighlights.id, rowId)).get();
    if (!row) throw new NotFoundException('회차 또는 이미지 생성 요청이 삭제되었습니다.');
    return row;
  }

  private requireEpisode(projectId: string, episodeId: string) {
    const project = this.database.orm.select({ id: projects.id }).from(projects)
      .where(and(eq(projects.id, projectId), isNull(projects.deletedAt))).get();
    const episode = this.database.orm.select().from(episodes)
      .where(and(eq(episodes.id, episodeId), eq(episodes.projectId, projectId), isNull(episodes.deletedAt))).get();
    if (!project || !episode) throw new NotFoundException('회차를 찾을 수 없습니다.');
    return episode;
  }
}
