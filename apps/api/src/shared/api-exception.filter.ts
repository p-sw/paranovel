import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { sanitizeLogText, serializeError } from './error-log';

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ApiExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const response = http.getResponse<Response>();
    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;
    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      const request = typeof http.getRequest === 'function'
        ? http.getRequest<Request | undefined>()
        : undefined;
      const pathname = (request?.path ?? request?.originalUrl ?? request?.url ?? '')
        .split(/[?#]/, 1)[0] ?? '';
      this.logger.error({
        event: 'http_request_failed',
        method: sanitizeLogText(request?.method ?? 'UNKNOWN'),
        pathname: sanitizeLogText(pathname),
        status,
        error: serializeError(exception),
      });
    }
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
