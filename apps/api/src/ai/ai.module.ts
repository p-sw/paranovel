import { Global, Module } from '@nestjs/common';
import { AiRunnerService } from './ai-runner.service';
import { OpenRouterGateway } from './openrouter.gateway';

@Global()
@Module({
  providers: [OpenRouterGateway, AiRunnerService],
  exports: [OpenRouterGateway, AiRunnerService],
})
export class AiModule {}
