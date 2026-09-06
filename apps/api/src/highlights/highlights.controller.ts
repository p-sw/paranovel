import { Body, Controller, Delete, Get, Headers, Param, Patch, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { HighlightsService } from './highlights.service';

@Controller('projects/:projectId/episodes/:episodeId/highlight')
export class HighlightsController {
  constructor(private readonly highlights: HighlightsService) {}

  @Get()
  get(@Param('projectId') projectId: string, @Param('episodeId') episodeId: string) {
    return this.highlights.get(projectId, episodeId);
  }

  @Post('generate')
  async generate(
    @Param('projectId') projectId: string, @Param('episodeId') episodeId: string,
    @Body() body: unknown, @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    // A disconnected browser must not turn a paid request into a new request.
    // The durable state remains readable while this bounded operation finishes.
    const state = await this.highlights.generate(projectId, episodeId, body, key);
    response.status(state.generation?.status === 'RUNNING' ? 202 : 200);
    return state;
  }

  @Patch('placement')
  place(@Param('projectId') projectId: string, @Param('episodeId') episodeId: string, @Body() body: unknown) {
    return this.highlights.place(projectId, episodeId, body);
  }

  @Delete()
  remove(@Param('projectId') projectId: string, @Param('episodeId') episodeId: string, @Body() body: unknown) {
    return this.highlights.remove(projectId, episodeId, body);
  }

  @Get(':imageId/image')
  image(
    @Param('projectId') projectId: string, @Param('episodeId') episodeId: string,
    @Param('imageId') imageId: string, @Res() response: Response,
  ) {
    const file = this.highlights.imageFile(projectId, episodeId, imageId);
    response.sendFile(file.path, {
      headers: { 'Content-Type': file.mimeType, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=3600' },
    }, (error) => {
      if (error && !response.headersSent) response.status(404).json({ message: '저장된 이미지 파일을 찾을 수 없습니다.' });
    });
  }
}
