import { Body, Controller, Delete, Get, Headers, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ImprovementsService } from './improvements.service';

@Controller()
export class ImprovementsController {
  constructor(private readonly improvements: ImprovementsService) {}

  @Get('improvements')
  list(@Query('projectId') projectId?: string) { return this.improvements.list(projectId); }

  @Post('improvements')
  create(@Body() body: unknown) { return this.improvements.create(body); }

  @Patch('improvements/:improvementId')
  update(@Param('improvementId') improvementId: string, @Body() body: unknown) {
    return this.improvements.update(improvementId, body);
  }

  @Delete('improvements/:improvementId')
  @HttpCode(204)
  remove(@Param('improvementId') improvementId: string): void { this.improvements.remove(improvementId); }

  @Post('improvement-candidates')
  candidates(@Body() body: unknown) { return this.improvements.candidates(body); }

  @Post('improvements/batch')
  batch(@Body() body: unknown, @Headers('idempotency-key') idempotencyKey?: string) {
    return this.improvements.batch(body, idempotencyKey);
  }
}
