import { Module } from '@nestjs/common';
import { ArcsModule } from '../arcs/arcs.module';
import { CanonModule } from '../canon/canon.module';
import { ImprovementsModule } from '../improvements/improvements.module';
import { ProjectsModule } from '../projects/projects.module';
import { ChatController } from './chat.controller';
import { ChatReadToolsService } from './chat-read-tools.service';
import { ChatService } from './chat.service';
import { ImageTagToolService } from './image-tag-tool.service';

@Module({
  imports: [ProjectsModule, CanonModule, ArcsModule, ImprovementsModule],
  controllers: [ChatController], providers: [ChatService, ChatReadToolsService, ImageTagToolService], exports: [ChatService],
})
export class ChatModule {}
