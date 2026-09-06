import { Global, Module } from '@nestjs/common';
import { AiRunnerService } from './ai-runner.service';
import { OpenRouterGateway } from './openrouter.gateway';
import { TavilySearchService } from './tavily-search.service';
import { AnimeImageService } from './anime-image.service';

@Global()
@Module({
  providers: [OpenRouterGateway, TavilySearchService, AnimeImageService, AiRunnerService],
  exports: [OpenRouterGateway, AiRunnerService, TavilySearchService, AnimeImageService],
})
export class AiModule {}
