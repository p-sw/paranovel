import { HttpException } from '@nestjs/common';
import type { Request, Response } from 'express';

export async function sendNdjson<T extends { type: string }>(
  request: Request,
  response: Response,
  run: (emit: (event: T) => void, signal: AbortSignal) => Promise<void>,
): Promise<void> {
  response.status(200);
  response.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  response.setHeader('Cache-Control', 'no-cache, no-transform');
  response.setHeader('X-Accel-Buffering', 'no');
  response.flushHeaders();
  const controller = new AbortController();
  const abort = (): void => {
    if (!response.writableEnded) controller.abort(new DOMException('Client disconnected', 'AbortError'));
  };
  request.on('aborted', abort);
  response.on('close', abort);
  const emit = (event: T): void => {
    if (!response.destroyed && !response.writableEnded) response.write(`${JSON.stringify(event)}\n`);
  };
  try {
    await run(emit, controller.signal);
  } catch (error) {
    if (!controller.signal.aborted) {
      emit({
        type: 'error',
        code: error instanceof HttpException ? String(error.getStatus()) : 'AI_STREAM_FAILED',
        message: error instanceof Error ? error.message : 'AI stream failed',
      } as unknown as T);
    }
  } finally {
    if (!response.writableEnded) response.end();
  }
}
