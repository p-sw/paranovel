import { Controller, Param, Post } from '@nestjs/common';
import { MemoryService } from './memory.service';

@Controller('projects/:projectId/memory')
export class MemoryController {
  constructor(private readonly memory: MemoryService) {}

  @Post('reindex')
  reindex(@Param('projectId') projectId: string) {
    return this.memory.reindexProject(projectId);
  }
}

@Controller('memory')
export class GlobalMemoryController {
  constructor(private readonly memory: MemoryService) {}

  @Post('reindex-global-improvements')
  reindexGlobalImprovements() {
    return this.memory.reindexGlobalImprovements();
  }
}
