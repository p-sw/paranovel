import { Global, Module } from '@nestjs/common';
import { ArcEpisodeDirectionsService } from './arc-episode-directions.service';
import { AiRunnerService } from './ai-runner.service';
import { OpenRouterGateway } from './openrouter.gateway';
import { TavilySearchService } from './tavily-search.service';

@Global()
@Module({
  providers: [OpenRouterGateway, TavilySearchService, AiRunnerService, ArcEpisodeDirectionsService],
  exports: [OpenRouterGateway, AiRunnerService, TavilySearchService, ArcEpisodeDirectionsService],
})
export class AiModule {}
