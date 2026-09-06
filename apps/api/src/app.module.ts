import { Module } from '@nestjs/common';
import { ServeStaticModule } from '@nestjs/serve-static';
import { resolve } from 'node:path';
import { AiModule } from './ai/ai.module';
import { ArcsModule } from './arcs/arcs.module';
import { CanonModule } from './canon/canon.module';
import { ChatModule } from './chat/chat.module';
import { ComparisonsModule } from './comparisons/comparisons.module';
import { DatabaseModule } from './database/database.module';
import { EpisodesModule } from './episodes/episodes.module';
import { HealthController } from './health.controller';
import { ImprovementsModule } from './improvements/improvements.module';
import { MemoryModule } from './memory/memory.module';
import { ProjectsModule } from './projects/projects.module';
import { PromptsModule } from './prompts/prompts.module';

const webDistPath = process.env.WEB_DIST_PATH
  ? resolve(process.env.WEB_DIST_PATH)
  : resolve(__dirname, '../../web/dist');

@Module({
  imports: [
    ServeStaticModule.forRoot({
      rootPath: webDistPath,
      exclude: ['/api/{*path}'],
    }),
    DatabaseModule,
    PromptsModule,
    AiModule,
    MemoryModule,
    ProjectsModule,
    CanonModule,
    ArcsModule,
    ImprovementsModule,
    EpisodesModule,
    ComparisonsModule,
    ChatModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
