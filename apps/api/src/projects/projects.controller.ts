import { Body, Controller, Delete, Get, HttpCode, Param, Patch } from '@nestjs/common';
import { ProjectsService } from './projects.service';

@Controller('projects')
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  @Get()
  list() {
    return this.projects.list();
  }

  @Get(':projectId')
  get(@Param('projectId') projectId: string) {
    return this.projects.get(projectId);
  }

  @Patch(':projectId')
  update(@Param('projectId') projectId: string, @Body() body: unknown) {
    return this.projects.update(projectId, body);
  }

  @Delete(':projectId')
  @HttpCode(204)
  remove(@Param('projectId') projectId: string): void {
    this.projects.remove(projectId);
  }
}
