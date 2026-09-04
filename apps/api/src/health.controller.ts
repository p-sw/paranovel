import { Controller, Get } from '@nestjs/common';
import { DatabaseService } from './database/database.service';
import { PromptRegistryService } from './prompts/prompt-registry.service';

@Controller('health')
export class HealthController {
  constructor(
    private readonly database: DatabaseService,
    private readonly prompts: PromptRegistryService,
  ) {}

  @Get()
  get() {
    this.database.connection.prepare('SELECT 1').get();
    return {
      status: 'ok',
      database: 'ok',
      promptsDirectory: this.prompts.directory,
      vectorSearch: this.database.vectorAvailable,
      timestamp: new Date().toISOString(),
    };
  }
}
