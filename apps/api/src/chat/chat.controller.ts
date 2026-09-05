import { Body, Controller, Get, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { ChatService } from './chat.service';

@Controller('projects/:projectId/chat')
export class ChatController {
  constructor(private readonly chat: ChatService) {}

  @Get('messages')
  history(@Param('projectId') projectId: string) { return this.chat.history(projectId); }

  @Post('messages')
  async send(@Param('projectId') projectId: string, @Body() body: unknown, @Req() request: Request) {
    const controller = new AbortController();
    const abort = () => controller.abort(new DOMException('Client disconnected', 'AbortError'));
    request.once('aborted', abort);
    try { return await this.chat.send(projectId, body, controller.signal); }
    finally { request.off('aborted', abort); }
  }

  @Post('proposals/:proposalId/apply')
  apply(@Param('projectId') projectId: string, @Param('proposalId') proposalId: string) {
    return this.chat.apply(projectId, proposalId);
  }
}
