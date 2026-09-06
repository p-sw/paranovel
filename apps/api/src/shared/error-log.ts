import { HttpException } from '@nestjs/common';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import { ZodError } from 'zod';

const MAX_TEXT = 2_000;
const MAX_CAUSE_DEPTH = 4;
const MAX_ISSUES = 20;
const MAX_FRAMES = 20;
const REDACTED = '[REDACTED]';

function jsonFailure(message: string): string {
  const position = message.match(/\bposition\s+(\d+)/i)?.[1];
  const reason = /Unexpected end of JSON input/i.test(message)
    ? 'Unexpected end of JSON input' : 'Invalid JSON';
  return `${reason}${position ? ` at position ${position}` : ''}`;
}

/** Only diagnostic text belongs here; callers must never pass request bodies. */
export function sanitizeLogText(value: string): string {
  let text = value;
  // Node's JSON.parse errors can include a fragment of the source document.
  const jsonStart = text.search(/Unexpected token|Unexpected end of JSON input|Unexpected non-whitespace character after JSON|Expected (?:property name|double-quoted property name|':' after property name|',' or)|Unterminated string in JSON|Bad (?:control character|escaped character|Unicode escape)|No number after minus sign in JSON|Exponent part is missing a number in JSON|Unterminated fractional number in JSON/i);
  if (jsonStart >= 0) text = `${text.slice(0, jsonStart)}${jsonFailure(text.slice(jsonStart))}`;
  // Drizzle also embeds bind values in its message, including wrapped errors.
  const queryStart = text.indexOf('Failed query:');
  if (queryStart >= 0) text = `${text.slice(0, queryStart)}Database query failed`;

  const secrets = [...new Set(Object.entries(process.env)
    .filter(([key, secret]) => /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTHORIZATION/i.test(key) && Boolean(secret))
    .map(([, secret]) => secret!))].sort((left, right) => right.length - left.length);
  for (const secret of secrets) text = text.split(secret).join(REDACTED);
  text = text
    .replace(/(authorization\s*["']?\s*[:=]\s*["']?)(?:(?:bearer|basic)\s+)?(?:\[REDACTED\]|[^\s"',;\]}]+)/gi, `$1${REDACTED}`)
    .replace(/\b(?:bearer|basic)\s+[a-z0-9._~+\/-]+=*/gi, REDACTED)
    .replace(/\bsk-(?:or-v1-)?[a-z0-9_-]{8,}\b/gi, REDACTED)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text;
}

function validationIssues(error: ZodError): Record<string, unknown>[] {
  return error.issues.slice(0, MAX_ISSUES).map((issue) => {
    const messages: Record<string, string> = {
      invalid_type: 'Unexpected value type',
      too_big: 'Value exceeds maximum',
      too_small: 'Value is below minimum',
      invalid_format: 'Invalid value format',
      not_multiple_of: 'Value is not an allowed multiple',
      unrecognized_keys: 'Unrecognized fields',
      invalid_union: 'Value does not match any allowed type',
      invalid_key: 'Invalid record key',
      invalid_element: 'Invalid collection element',
      invalid_value: 'Value is not an allowed option',
      custom: 'Validation failed',
    };
    // Do not copy issue.message: custom validation messages can include input.
    const result: Record<string, unknown> = {
      path: issue.path.slice(0, 20).map((part) => typeof part === 'number'
        ? part : sanitizeLogText(String(part)).slice(0, 200)),
      code: issue.code,
      message: messages[issue.code] ?? 'Validation failed',
    };
    if ('expected' in issue) result.expected = sanitizeLogText(issue.expected);
    if ('origin' in issue) result.origin = sanitizeLogText(issue.origin).slice(0, 200);
    if ('minimum' in issue) result.minimum = typeof issue.minimum === 'bigint' ? String(issue.minimum) : issue.minimum;
    if ('maximum' in issue) result.maximum = typeof issue.maximum === 'bigint' ? String(issue.maximum) : issue.maximum;
    if ('inclusive' in issue) result.inclusive = issue.inclusive;
    if ('keys' in issue) result.keys = issue.keys.slice(0, 20).map((key) => sanitizeLogText(key).slice(0, 200));
    if ('values' in issue) result.values = issue.values
      .filter((value) => value === null || ['string', 'number', 'boolean'].includes(typeof value))
      .slice(0, 20).map((value) => typeof value === 'string' ? sanitizeLogText(value).slice(0, 200) : value);
    return result;
  });
}

/** A bounded allowlist prevents Error properties from leaking prompts or SQL. */
export function serializeError(error: unknown): Record<string, unknown> {
  const seen = new WeakSet<object>();
  const visit = (value: unknown, depth: number): Record<string, unknown> => {
    if (depth >= MAX_CAUSE_DEPTH) return { name: 'CauseLimit', message: 'Further causes omitted' };
    if (value && typeof value === 'object') {
      if (seen.has(value)) return { name: 'CircularCause', message: 'Circular cause omitted' };
      seen.add(value);
    }
    if (!(value instanceof Error)) {
      return { name: 'NonError', message: typeof value === 'string'
        ? sanitizeLogText(value) : 'Non-Error value thrown' };
    }

    const queryError = value instanceof DrizzleQueryError;
    let message = queryError ? 'Database query failed'
      : value instanceof ZodError ? `Validation failed (${value.issues.length} issues)`
        : value instanceof SyntaxError ? jsonFailure(value.message) : value.message;
    if (value.cause instanceof ZodError) {
      // The runner's wrapper interpolates Zod's JSON message after this colon.
      message = message.replace(/:\s*\[[\s\S]*$/, ': Validation failed; see cause');
    }
    const result: Record<string, unknown> = {
      name: queryError ? 'DrizzleQueryError' : sanitizeLogText(value.name),
      message: sanitizeLogText(message),
    };
    // Remove the full, possibly multiline message before selecting frames.
    // SQL params and custom Zod messages may themselves contain lines like "at".
    const stack = value.stack ?? '';
    const messageStart = value.message ? stack.indexOf(value.message) : -1;
    const frameText = messageStart >= 0 ? stack.slice(messageStart + value.message.length) : stack;
    const frames = frameText.split('\n').filter((line) => /^\s+at\s/.test(line)).slice(0, MAX_FRAMES);
    if (frames.length) result.stack = sanitizeLogText(frames.join('\n'));
    if ('code' in value && (typeof value.code === 'string' || typeof value.code === 'number')) {
      result.code = typeof value.code === 'string' ? sanitizeLogText(value.code) : value.code;
    }
    if (value instanceof HttpException) result.status = value.getStatus();
    if (value instanceof ZodError) result.issues = validationIssues(value);
    if (value.cause !== undefined) result.cause = visit(value.cause, depth + 1);
    return result;
  };
  return visit(error, 0);
}
