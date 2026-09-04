import { Module } from '@nestjs/common';
import { ArcsController } from './arcs.controller';
import { ArcsService } from './arcs.service';

@Module({ controllers: [ArcsController], providers: [ArcsService], exports: [ArcsService] })
export class ArcsModule {}
