import { Module } from '@nestjs/common';
import { HighlightsController } from './highlights.controller';
import { HighlightsService } from './highlights.service';
import { HighlightStorageService } from './highlight-storage.service';

@Module({
  controllers: [HighlightsController],
  providers: [HighlightsService, HighlightStorageService],
})
export class HighlightsModule {}
