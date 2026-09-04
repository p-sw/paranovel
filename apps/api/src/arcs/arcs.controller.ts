import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { ArcsService } from './arcs.service';

@Controller('projects/:projectId/arcs')
export class ArcsController {
  constructor(private readonly arcs: ArcsService) {}

  @Get()
  list(@Param('projectId') projectId: string) { return this.arcs.list(projectId); }

  @Get('current')
  current(@Param('projectId') projectId: string) { return this.arcs.current(projectId); }

  @Post('plan')
  plan(@Param('projectId') projectId: string, @Body() body: unknown) {
    return this.arcs.plan(projectId, body);
  }

  @Post()
  create(@Param('projectId') projectId: string, @Body() body: unknown) { return this.arcs.create(projectId, body); }

  @Patch(':arcId')
  update(@Param('projectId') projectId: string, @Param('arcId') arcId: string, @Body() body: unknown) {
    return this.arcs.update(projectId, arcId, body);
  }

  @Delete(':arcId')
  @HttpCode(204)
  remove(@Param('projectId') projectId: string, @Param('arcId') arcId: string): void {
    this.arcs.remove(projectId, arcId);
  }
}
