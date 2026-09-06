import { BadGatewayException } from '@nestjs/common';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { sanitizeLogText, serializeError } from '../src/shared/error-log';

describe('safe error logging', () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it('retains useful exception, status, code, stack and cause diagnostics', () => {
    const cause = Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
    const error = new BadGatewayException('Unable to save reply', { cause });
    const logged = serializeError(error);
    expect(logged).toMatchObject({
      name: 'BadGatewayException', message: 'Unable to save reply', status: 502,
      cause: { name: 'Error', message: 'database is locked', code: 'SQLITE_BUSY' },
    });
    expect(logged.stack).toEqual(expect.stringContaining('error-log.spec.ts'));
    expect(String(logged.stack)).not.toContain('Unable to save reply');
  });

  it('redacts configured secrets and authorization tokens in messages, frames and causes', () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'configured-openrouter-key-value');
    vi.stubEnv('TAVILY_API_KEY', 'configured-tavily-key-value');
    const error = new Error('configured-openrouter-key-value; Bearer unconfigured.bearer-token', {
      cause: new Error('Authorization: Basic unconfigured-basic-token; configured-tavily-key-value'),
    });
    error.stack = `${error.name}: ${error.message}\n    at configured-openrouter-key-value (/app/source.ts:1:2)`;
    const logged = JSON.stringify(serializeError(error));
    for (const secret of ['configured-openrouter-key-value', 'configured-tavily-key-value', 'unconfigured.bearer-token', 'unconfigured-basic-token']) {
      expect(logged).not.toContain(secret);
    }
    expect(logged).toContain('[REDACTED]');
    expect(sanitizeLogText('"Authorization":"Bearer json-header-token"')).not.toContain('json-header-token');
  });

  it('omits SQL and parameter contents from real Drizzle errors while retaining the driver cause', () => {
    const error = new DrizzleQueryError(
      'insert into chat_messages (content) values (?)',
      ['private prompt and reply', '\n    at forged-private-source (/private/document:1:1)'],
      Object.assign(new Error('UNIQUE constraint failed: chat_messages.id'), { code: 'SQLITE_CONSTRAINT_UNIQUE' }),
    );
    const logged = serializeError(error);
    expect(logged).toMatchObject({
      name: 'DrizzleQueryError', message: 'Database query failed',
      cause: { message: 'UNIQUE constraint failed: chat_messages.id', code: 'SQLITE_CONSTRAINT_UNIQUE' },
    });
    const text = JSON.stringify(logged);
    for (const source of ['insert into', 'values (?)', 'private prompt and reply', 'forged-private-source', '/private/document', 'params:']) {
      expect(text).not.toContain(source);
    }
    expect(logged.stack).toEqual(expect.stringContaining('error-log.spec.ts'));
  });

  it('reports Zod paths, codes and constraints without input or custom message contents', () => {
    const result = z.strictObject({
      content: z.string(),
      title: z.string().max(3),
      count: z.number().min(1),
      custom: z.string().superRefine((value, context) => {
        context.addIssue({ code: 'custom', message: `private custom input: ${value}` });
      }),
    }).safeParse({ content: 12345, title: 'private-long-title', count: -99, custom: 'private-custom-value', unexpected: 'private-extra-value' }, { reportInput: true });
    expect(result.success).toBe(false);
    if (result.success) return;
    const logged = serializeError(result.error);
    expect(logged.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: ['content'], code: 'invalid_type', expected: 'string' }),
      expect.objectContaining({ path: ['title'], code: 'too_big', origin: 'string', maximum: 3 }),
      expect.objectContaining({ path: ['count'], code: 'too_small', origin: 'number', minimum: 1 }),
      expect.objectContaining({ path: ['custom'], code: 'custom', message: 'Validation failed' }),
      expect.objectContaining({ code: 'unrecognized_keys', keys: ['unexpected'] }),
    ]));
    const text = JSON.stringify(logged);
    for (const input of ['12345', 'private-long-title', '-99', 'private-custom-value', 'private-extra-value', 'private custom input', '"input"']) {
      expect(text).not.toContain(input);
    }
    const wrapped = serializeError(new BadGatewayException(`AI returned invalid chat output after one retry: ${result.error.message}`, { cause: result.error }));
    expect(wrapped.message).toBe('AI returned invalid chat output after one retry: Validation failed; see cause');
    expect(JSON.stringify(wrapped)).not.toContain('private-custom-value');
  });

  it('includes bounded, sanitized allowed enum values without the rejected input', () => {
    vi.stubEnv('EXAMPLE_SECRET', 'private-enum-schema-secret');
    const options = ['ACTIVE', 'PLANNED', 'private-enum-schema-secret', ...Array.from({ length: 30 }, (_, index) => `OPTION_${index}`)] as [string, ...string[]];
    const result = z.object({ status: z.enum(options) }).safeParse({ status: 'private-rejected-status' }, { reportInput: true });
    if (result.success) throw new Error('Expected validation failure');
    const logged = serializeError(result.error);
    expect(logged.issues).toEqual([
      expect.objectContaining({
        path: ['status'], code: 'invalid_value',
        values: ['ACTIVE', 'PLANNED', '[REDACTED]', ...Array.from({ length: 17 }, (_, index) => `OPTION_${index}`)],
      }),
    ]);
    const text = JSON.stringify(logged);
    expect(text).not.toContain('private-enum-schema-secret');
    expect(text).not.toContain('private-rejected-status');
  });

  it('removes JSON source excerpts from parse errors and their wrappers', () => {
    let parseError: unknown;
    try { JSON.parse('private-source-document'); } catch (error) { parseError = error; }
    expect(parseError).toBeInstanceOf(SyntaxError);
    const cause = parseError as SyntaxError;
    const wrapped = new BadGatewayException(`AI returned invalid chat output after one retry: ${cause.message}`, { cause });
    expect(serializeError(wrapped)).toMatchObject({
      name: 'BadGatewayException', status: 502,
      cause: { name: 'SyntaxError', message: expect.stringContaining('Invalid JSON') },
    });
    expect(JSON.stringify(serializeError(wrapped))).not.toContain('private-source-document');
    expect(sanitizeLogText('AI returned invalid output: Unexpected token x, "private excerpt" is not valid JSON at position 42'))
      .toBe('AI returned invalid output: Invalid JSON at position 42');
    expect(serializeError(new BadGatewayException('AI 변경 필드가 올바르지 않습니다.', { cause })).cause)
      .toMatchObject({ name: 'SyntaxError', message: expect.stringContaining('Invalid JSON') });
  });

  it('bounds deep and circular causes, large text, and issue lists', () => {
    const circular = new Error('circular');
    circular.cause = circular;
    expect(serializeError(circular).cause).toEqual({ name: 'CircularCause', message: 'Circular cause omitted' });
    let deep: Error = new Error('last-cause-must-be-omitted');
    for (let level = 0; level < 10; level += 1) deep = new Error(`level-${level}`, { cause: deep });
    const text = JSON.stringify(serializeError(deep));
    expect(text).toContain('CauseLimit');
    expect(text).not.toContain('last-cause-must-be-omitted');
    expect(sanitizeLogText('x'.repeat(10_000)).length).toBeLessThanOrEqual(2_001);
    const result = z.array(z.string()).safeParse(Array(100).fill(1));
    if (result.success) throw new Error('Expected validation failure');
    expect(serializeError(result.error).issues).toHaveLength(20);
  });

  it('does not serialize arbitrary properties on errors or non-Error objects', () => {
    const error = Object.assign(new Error('failed'), { body: 'private body', headers: { Authorization: 'private token' } });
    expect(JSON.stringify(serializeError(error))).not.toContain('private');
    expect(serializeError({ input: 'private body', query: 'private SQL' })).toEqual({ name: 'NonError', message: 'Non-Error value thrown' });
  });
});
