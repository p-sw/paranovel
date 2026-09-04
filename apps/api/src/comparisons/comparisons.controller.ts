import { Body, Controller, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { StreamEvent } from '../episodes/episodes.service';
import { sendNdjson } from '../shared/ndjson';
import { ComparisonsService } from './comparisons.service';

@Controller('comparisons')
export class ComparisonsController {
  constructor(private readonly comparisons: ComparisonsService) {}

  @Post('generate')
  generate(@Body() body: unknown, @Req() request: Request, @Res() response: Response) {
    return sendNdjson<StreamEvent>(request, response, (emit, signal) =>
      this.comparisons.generate(body, emit, signal),
    );
  }
}
