import {
  type ArgumentsHost,
  BadGatewayException,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiExceptionFilter } from '../src/shared/api-exception.filter';

function makeHost(request?: Record<string, unknown>) {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  const host = {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
  } as unknown as ArgumentsHost;
  return { host, response };
}

describe('API exception logging', () => {
  let errorLog: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorLog = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs unhandled errors with HTTP context and stack, preserving the response', () => {
    const { host, response } = makeHost({ method: 'POST', path: '/api/projects/project-1/chat' });
    const error = new Error('Database unavailable');

    new ApiExceptionFilter().catch(error, host);

    expect(errorLog).toHaveBeenCalledOnce();
    expect(errorLog).toHaveBeenCalledWith({
      event: 'http_request_failed',
      method: 'POST',
      pathname: '/api/projects/project-1/chat',
      status: 500,
      error: expect.objectContaining({
        name: 'Error',
        message: 'Database unavailable',
        stack: expect.stringContaining('api-exception-filter.spec.ts'),
      }),
    });
    expect(response.status).toHaveBeenCalledWith(500);
    expect(response.json).toHaveBeenCalledWith({
      statusCode: 500,
      code: 'INTERNAL_SERVER_ERROR',
      error: 'INTERNAL_SERVER_ERROR',
      message: 'Database unavailable',
    });
  });

  it('retains the original cause of a wrapped upstream failure', () => {
    const cause = Object.assign(new Error('socket closed'), { code: 'ECONNRESET' });
    const error = new BadGatewayException('OpenRouter request failed', { cause });
    const { host, response } = makeHost({ method: 'POST', path: '/api/chat' });

    new ApiExceptionFilter().catch(error, host);

    expect(errorLog).toHaveBeenCalledWith(expect.objectContaining({
      status: 502,
      error: expect.objectContaining({
        name: 'BadGatewayException',
        message: 'OpenRouter request failed',
        cause: expect.objectContaining({ name: 'Error', message: 'socket closed', code: 'ECONNRESET' }),
      }),
    }));
    expect(response.status).toHaveBeenCalledWith(502);
    expect(response.json).toHaveBeenCalledWith({
      statusCode: 502, code: 'BAD_GATEWAY', error: 'BAD_GATEWAY', message: 'OpenRouter request failed',
    });
  });

  it('excludes request headers, body, query and URL query values from logs', () => {
    const { host } = makeHost({
      method: 'POST',
      originalUrl: '/api/chat?api_key=query-secret#fragment-secret',
      headers: { authorization: 'Bearer header-secret' },
      body: { message: 'private conversation body' },
      query: { api_key: 'query-secret' },
    });
    const error = Object.assign(new Error('Request failed'), {
      request: { body: 'private exception request', headers: { authorization: 'Bearer nested-secret' } },
    });

    new ApiExceptionFilter().catch(error, host);

    expect(errorLog).toHaveBeenCalledWith(expect.objectContaining({ pathname: '/api/chat' }));
    const logged = JSON.stringify(errorLog.mock.calls);
    for (const secret of [
      'query-secret', 'fragment-secret', 'header-secret', 'private conversation body',
      'private exception request', 'nested-secret', 'authorization',
    ]) {
      expect(logged).not.toContain(secret);
    }
  });

  it.each([400, 401, 403, 404, 409, 422, 429])('keeps %i errors and response details unchanged without error logs', (status) => {
    const raw = { code: 'INPUT_REJECTED', message: ['Invalid request'], details: { field: 'targetId' } };
    const { host, response } = makeHost({ method: 'POST', path: '/api/chat' });

    new ApiExceptionFilter().catch(new HttpException(raw, status), host);

    expect(errorLog).not.toHaveBeenCalled();
    expect(response.status).toHaveBeenCalledWith(status);
    expect(response.json).toHaveBeenCalledWith({
      statusCode: status, code: raw.code, error: HttpStatus[status], message: raw.message, details: raw.details,
    });
  });

  it('still logs and responds when an HTTP request is unavailable', () => {
    const { host, response } = makeHost();

    new ApiExceptionFilter().catch(new Error('Failure without request'), host);

    expect(errorLog).toHaveBeenCalledWith(expect.objectContaining({ method: 'UNKNOWN', pathname: '', status: 500 }));
    expect(response.status).toHaveBeenCalledWith(500);
  });

  it('supports existing response-only exception host adapters', () => {
    const { response } = makeHost();
    const host = {
      switchToHttp: () => ({ getResponse: () => response }),
    } as unknown as ArgumentsHost;

    new ApiExceptionFilter().catch(new Error('Failure without request accessor'), host);

    expect(errorLog).toHaveBeenCalledWith(expect.objectContaining({ method: 'UNKNOWN', pathname: '', status: 500 }));
    expect(response.status).toHaveBeenCalledWith(500);
  });
});
