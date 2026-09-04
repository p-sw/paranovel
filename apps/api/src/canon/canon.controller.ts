import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { CanonService } from './canon.service';

@Controller('projects/:projectId/canon')
export class CanonController {
  constructor(private readonly canon: CanonService) {}

  @Get()
  list(@Param('projectId') projectId: string, @Query('status') status?: string) {
    return this.canon.list(projectId, status);
  }

  @Post()
  create(@Param('projectId') projectId: string, @Body() body: unknown) {
    return this.canon.create(projectId, body);
  }

  @Post('generate')
  generate(@Param('projectId') projectId: string, @Body() body: unknown) {
    return this.canon.generate(projectId, body);
  }

  @Get(':canonId')
  get(@Param('projectId') projectId: string, @Param('canonId') canonId: string) {
    return this.canon.get(projectId, canonId);
  }

  @Patch(':canonId')
  update(
    @Param('projectId') projectId: string,
    @Param('canonId') canonId: string,
    @Body() body: unknown,
  ) {
    return this.canon.update(projectId, canonId, body);
  }

  @Delete(':canonId')
  @HttpCode(204)
  remove(@Param('projectId') projectId: string, @Param('canonId') canonId: string): void {
    this.canon.remove(projectId, canonId);
  }
}
