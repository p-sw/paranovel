import { Body, Controller, Get, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { EditorAiService } from './editor-ai.service';

@Controller('projects/:projectId/episodes/:episodeId/editor-ai')
export class EditorAiController {
  constructor(private readonly editorAi: EditorAiService) {}

  @Get('messages')
  history(@Param('projectId') projectId: string, @Param('episodeId') episodeId: string) {
    return this.editorAi.history(projectId, episodeId);
  }

  @Post('messages')
  async send(@Param('projectId') projectId: string, @Param('episodeId') episodeId: string, @Body() body: unknown, @Req() request: Request) {
    const controller = new AbortController();
    const abort = () => controller.abort(new DOMException('Client disconnected', 'AbortError'));
    request.once('aborted', abort);
    try { return await this.editorAi.send(projectId, episodeId, body, controller.signal); }
    finally { request.off('aborted', abort); }
  }

  @Post('messages/:messageId/apply')
  apply(@Param('projectId') projectId: string, @Param('episodeId') episodeId: string, @Param('messageId') messageId: string) {
    return this.editorAi.apply(projectId, episodeId, messageId);
  }
}
