import { Module } from '@nestjs/common';
import { ProjectsModule } from '../projects/projects.module';
import { EpisodesController } from './episodes.controller';
import { EpisodesService } from './episodes.service';
import { EditorAiController } from './editor-ai.controller';
import { EditorAiService } from './editor-ai.service';

@Module({
  imports: [ProjectsModule],
  controllers: [EpisodesController, EditorAiController],
  providers: [EpisodesService, EditorAiService],
  exports: [EpisodesService],
})
export class EpisodesModule {}
