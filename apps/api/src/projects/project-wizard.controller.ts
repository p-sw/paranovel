import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ProjectWizardService } from './project-wizard.service';

@Controller('project-sessions')
export class ProjectWizardController {
  constructor(private readonly wizard: ProjectWizardService) {}

  @Post()
  start(@Body() body: unknown) {
    return this.wizard.start(body);
  }

  @Get(':sessionId')
  get(@Param('sessionId') sessionId: string) {
    return this.wizard.get(sessionId);
  }

  @Post(':sessionId/respond')
  respond(@Param('sessionId') sessionId: string, @Body() body: unknown) {
    return this.wizard.respond(sessionId, body);
  }

  @Post(':sessionId/turn')
  turn(@Param('sessionId') sessionId: string, @Body() body: unknown) {
    return this.wizard.respond(sessionId, body);
  }

  @Post(':sessionId/skip')
  skip(@Param('sessionId') sessionId: string, @Body() body: unknown) {
    return this.wizard.skip(sessionId, body);
  }

  @Post(':sessionId/commit')
  commit(@Param('sessionId') sessionId: string, @Body() body: unknown) {
    return this.wizard.commit(sessionId, body);
  }
}
