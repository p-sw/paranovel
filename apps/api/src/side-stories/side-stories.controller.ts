import { Body, Controller, Get, Headers, Param, Patch, Post } from '@nestjs/common';
import { SideStoriesService } from './side-stories.service';

@Controller('projects/:projectId')
export class SideStoriesController {
  constructor(private readonly sideStories: SideStoriesService) {}

  @Get('side-stories')
  list(@Param('projectId') projectId: string) {
    return this.sideStories.list(projectId);
  }

  @Post('side-stories')
  create(
    @Param('projectId') projectId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.sideStories.create(projectId, body, idempotencyKey);
  }

  @Get('side-story-groups')
  listGroups(@Param('projectId') projectId: string) {
    return this.sideStories.listGroups(projectId);
  }

  @Post('side-story-groups')
  createGroup(
    @Param('projectId') projectId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.sideStories.createGroup(projectId, body, idempotencyKey);
  }

  @Get('side-story-groups/:groupId')
  getGroup(
    @Param('projectId') projectId: string,
    @Param('groupId') groupId: string,
  ) {
    return this.sideStories.getGroup(projectId, groupId);
  }

  @Patch('side-story-groups/:groupId')
  updateGroup(
    @Param('projectId') projectId: string,
    @Param('groupId') groupId: string,
    @Body() body: unknown,
  ) {
    return this.sideStories.updateGroup(projectId, groupId, body);
  }
}
