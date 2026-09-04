import { Global, Module } from '@nestjs/common';
import { MemoryService } from './memory.service';
import { GlobalMemoryController, MemoryController } from './memory.controller';

@Global()
@Module({
  controllers: [MemoryController, GlobalMemoryController],
  providers: [MemoryService],
  exports: [MemoryService],
})
export class MemoryModule {}
