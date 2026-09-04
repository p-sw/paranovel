import { Module } from '@nestjs/common';
import { ProjectWizardController } from './project-wizard.controller';
import { ProjectWizardService } from './project-wizard.service';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';

@Module({
  controllers: [ProjectsController, ProjectWizardController],
  providers: [ProjectsService, ProjectWizardService],
  exports: [ProjectsService],
})
export class ProjectsModule {}
