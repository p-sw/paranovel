import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Headers,
  Param,
  Patch,
  Post,
  Put,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { sendNdjson } from '../shared/ndjson';
import { EpisodesService, type StreamEvent } from './episodes.service';

@Controller('projects/:projectId/episodes')
export class EpisodesController {
  constructor(private readonly episodes: EpisodesService) {}

  @Get()
  list(@Param('projectId') projectId: string) { return this.episodes.list(projectId); }

  @Get('order')
  order(@Param('projectId') projectId: string) { return this.episodes.order(projectId); }

  @Put('order')
  updateOrder(@Param('projectId') projectId: string, @Body() body: unknown) {
    return this.episodes.updateOrder(projectId, body);
  }

  @Post()
  create(
    @Param('projectId') projectId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.episodes.create(projectId, body, idempotencyKey);
  }

  @Post('propose')
  propose(@Param('projectId') projectId: string, @Body() body: unknown) {
    return this.episodes.propose(projectId, body);
  }

  @Post('refine')
  refine(@Param('projectId') projectId: string, @Body() body: unknown) {
    return this.episodes.refine(projectId, body);
  }

  @Post('generate')
  generate(
    @Param('projectId') projectId: string,
    @Body() body: unknown,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    return sendNdjson<StreamEvent>(request, response, (emit, signal) =>
      this.episodes.generate(projectId, body, emit, signal),
    );
  }

  @Get(':episodeId')
  get(@Param('projectId') projectId: string, @Param('episodeId') episodeId: string) {
    return this.episodes.get(projectId, episodeId);
  }

  @Post('repair')
  repairDraft(
    @Param('projectId') projectId: string,
    @Body() body: unknown,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    return sendNdjson<StreamEvent>(request, response, (emit, signal) =>
      this.episodes.repairDraft(projectId, body, emit, signal),
    );
  }

  @Patch(':episodeId')
  update(
    @Param('projectId') projectId: string,
    @Param('episodeId') episodeId: string,
    @Body() body: unknown,
  ) {
    return this.episodes.update(projectId, episodeId, body);
  }

  @Delete(':episodeId')
  @HttpCode(204)
  remove(
    @Param('projectId') projectId: string,
    @Param('episodeId') episodeId: string,
    @Body() body: unknown,
  ): void {
    this.episodes.remove(projectId, episodeId, body);
  }

  @Post(':episodeId/continue')
  continueEpisode(
    @Param('projectId') projectId: string,
    @Param('episodeId') episodeId: string,
    @Body() body: unknown,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    return sendNdjson<StreamEvent>(request, response, (emit, signal) =>
      this.episodes.continue(projectId, episodeId, body, emit, signal),
    );
  }

  @Post(':episodeId/finalize')
  finalize(
    @Param('projectId') projectId: string,
    @Param('episodeId') episodeId: string,
    @Body() body: unknown,
  ) {
    return this.episodes.finalize(projectId, episodeId, body);
  }

  @Post(':episodeId/repair')
  repairContinuation(
    @Param('projectId') projectId: string,
    @Param('episodeId') episodeId: string,
    @Body() body: unknown,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    return sendNdjson<StreamEvent>(request, response, (emit, signal) =>
      this.episodes.repairContinuation(projectId, episodeId, body, emit, signal),
    );
  }

  @Post(':episodeId/selection-replacements')
  replaceSelection(
    @Param('projectId') projectId: string,
    @Param('episodeId') episodeId: string,
    @Body() body: unknown,
  ) {
    return this.episodes.replaceSelection(projectId, episodeId, body);
  }

  @Get(':episodeId/scene')
  getScene(@Param('projectId') projectId: string, @Param('episodeId') episodeId: string) {
    return this.episodes.getScene(projectId, episodeId);
  }

  @Patch(':episodeId/scene')
  updateScene(
    @Param('projectId') projectId: string,
    @Param('episodeId') episodeId: string,
    @Body() body: unknown,
  ) {
    return this.episodes.updateScene(projectId, episodeId, body);
  }
}
