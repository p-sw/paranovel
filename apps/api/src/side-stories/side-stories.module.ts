import { Module } from '@nestjs/common';
import { SideStoriesController } from './side-stories.controller';
import { SideStoriesService } from './side-stories.service';

@Module({
  controllers: [SideStoriesController],
  providers: [SideStoriesService],
  exports: [SideStoriesService],
})
export class SideStoriesModule {}
