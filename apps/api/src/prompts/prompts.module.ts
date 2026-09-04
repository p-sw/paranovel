import { Global, Module } from '@nestjs/common';
import { PromptRegistryService } from './prompt-registry.service';

@Global()
@Module({
  providers: [PromptRegistryService],
  exports: [PromptRegistryService],
})
export class PromptsModule {}
