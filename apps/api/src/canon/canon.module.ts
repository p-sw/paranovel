import { Module } from '@nestjs/common';
import { CanonController } from './canon.controller';
import { CanonService } from './canon.service';

@Module({ controllers: [CanonController], providers: [CanonService], exports: [CanonService] })
export class CanonModule {}
