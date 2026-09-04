import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import type { Response } from 'express';

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;
    const raw =
      exception instanceof HttpException ? exception.getResponse() : undefined;
    const message =
      typeof raw === 'string'
        ? raw
        : raw && typeof raw === 'object' && 'message' in raw
          ? (raw as { message: unknown }).message
          : exception instanceof Error
            ? exception.message
            : 'Internal server error';
    const rawObject = raw && typeof raw === 'object'
      ? (raw as Record<string, unknown>)
      : undefined;

    response.status(status).json({
      statusCode: status,
      code:
        typeof rawObject?.code === 'string'
          ? rawObject.code
          : HttpStatus[status] ?? 'INTERNAL_SERVER_ERROR',
      error: HttpStatus[status] ?? 'Error',
      message,
      ...(rawObject && 'details' in rawObject ? { details: rawObject.details } : {}),
    });
  }
}
