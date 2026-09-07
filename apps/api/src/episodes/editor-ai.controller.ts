import { Body, Controller, Get, Param, Post, Req, Res } from '@nestjs/common';
import type { ConversationStreamEvent, EditorAiHistory } from '@paranovel/contracts';
import type { Request, Response } from 'express';
import { sendNdjson } from '../shared/ndjson';
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

  @Post('messages/stream')
  stream(@Param('projectId') projectId: string, @Param('episodeId') episodeId: string,
    @Body() body: unknown, @Req() request: Request, @Res() response: Response) {
    return sendNdjson<ConversationStreamEvent<EditorAiHistory>>(request, response, async (emit, signal) => {
      const history = await this.editorAi.send(projectId, episodeId, body, signal, emit);
      signal.throwIfAborted();
      emit({ type: 'complete', history });
    });
  }
}
