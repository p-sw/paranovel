import { Body, Controller, Get, Param, Post, Req, Res } from '@nestjs/common';
import type { ChatHistory, ConversationStreamEvent } from '@paranovel/contracts';
import type { Request, Response } from 'express';
import { sendNdjson } from '../shared/ndjson';
import { ChatService } from './chat.service';

@Controller('projects/:projectId/chat')
export class ChatController {
  constructor(private readonly chat: ChatService) {}

  @Get('threads')
  threads(@Param('projectId') projectId: string) { return this.chat.threads(projectId); }

  @Post('threads')
  createThread(@Param('projectId') projectId: string, @Body() body: unknown) {
    return this.chat.createThread(projectId, body);
  }

  @Get('threads/:threadId/messages')
  threadHistory(@Param('projectId') projectId: string, @Param('threadId') threadId: string) {
    return this.chat.history(projectId, threadId);
  }

  @Post('threads/:threadId/messages')
  sendToThread(@Param('projectId') projectId: string, @Param('threadId') threadId: string, @Body() body: unknown, @Req() request: Request) {
    return this.send(projectId, body, request, threadId);
  }

  @Get('messages')
  history(@Param('projectId') projectId: string) { return this.chat.history(projectId); }

  @Post('threads/:threadId/messages/stream')
  streamToThread(@Param('projectId') projectId: string, @Param('threadId') threadId: string,
    @Body() body: unknown, @Req() request: Request, @Res() response: Response) {
    return this.stream(projectId, body, request, response, threadId);
  }

  @Post('messages/stream')
  stream(@Param('projectId') projectId: string, @Body() body: unknown,
    @Req() request: Request, @Res() response: Response, threadId?: string) {
    return sendNdjson<ConversationStreamEvent<ChatHistory>>(request, response, async (emit, signal) => {
      const history = await this.chat.send(projectId, body, signal, threadId, emit);
      signal.throwIfAborted();
      emit({ type: 'complete', history });
    });
  }

  @Post('messages')
  async send(@Param('projectId') projectId: string, @Body() body: unknown, @Req() request: Request, threadId?: string) {
    const controller = new AbortController();
    const abort = () => controller.abort(new DOMException('Client disconnected', 'AbortError'));
    request.once('aborted', abort);
    try { return await this.chat.send(projectId, body, controller.signal, threadId); }
    finally { request.off('aborted', abort); }
  }

  @Post('proposals/:proposalId/apply')
  apply(@Param('projectId') projectId: string, @Param('proposalId') proposalId: string) {
    return this.chat.apply(projectId, proposalId);
  }
}
