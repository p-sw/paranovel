import { Global, Module } from '@nestjs/common';
import { AiRunnerService } from './ai-runner.service';
import { OpenRouterGateway } from './openrouter.gateway';
import { TavilySearchService } from './tavily-search.service';

@Global()
@Module({
  providers: [OpenRouterGateway, TavilySearchService, AiRunnerService],
  exports: [OpenRouterGateway, AiRunnerService, TavilySearchService],
})
export class AiModule {}
