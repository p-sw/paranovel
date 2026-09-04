import { Module } from '@nestjs/common';
import { ImprovementsModule } from '../improvements/improvements.module';
import { ComparisonsController } from './comparisons.controller';
import { ComparisonsService } from './comparisons.service';

@Module({
  imports: [ImprovementsModule],
  controllers: [ComparisonsController],
  providers: [ComparisonsService],
})
export class ComparisonsModule {}
