import { BadRequestException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';

export function id(): string {
  return randomUUID();
}

export function now(): string {
  return new Date().toISOString();
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || value.length === 0) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function stringifyJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export function stableStringifyJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringifyJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringifyJson(item)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function requireString(
  value: unknown,
  field: string,
  options: { min?: number; max?: number } = {},
): string {
  if (typeof value !== 'string') {
    throw new BadRequestException(`${field} must be a string`);
  }
  const trimmed = value.trim();
  const min = options.min ?? 1;
  const max = options.max ?? 1_000_000;
  if (trimmed.length < min || trimmed.length > max) {
    throw new BadRequestException(
      `${field} must contain between ${min} and ${max} characters`,
    );
  }
  return trimmed;
}

export function optionalString(
  value: unknown,
  field: string,
  max = 1_000_000,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > max) {
    throw new BadRequestException(`${field} must be a string of at most ${max} characters`);
  }
  return value;
}

export function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new BadRequestException(`${field} must be an array of strings`);
  }
  return [...new Set(value.map((item) => item.trim()).filter(Boolean))];
}

export function positiveInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || Number(value) < 0) {
    throw new BadRequestException(`${field} must be a non-negative integer`);
  }
  return Number(value);
}

export function assertEnum<T extends string>(
  value: unknown,
  field: string,
  choices: readonly T[],
): T {
  if (typeof value !== 'string' || !choices.includes(value as T)) {
    throw new BadRequestException(`${field} must be one of ${choices.join(', ')}`);
  }
  return value as T;
}

export function chunkText(
  text: string,
  maxCharacters = 1_200,
  overlap = 160,
): string[] {
  const normalized = text.replace(/\r\n/g, '\n').trim();
  if (!normalized) return [];
  if (normalized.length <= maxCharacters) return [normalized];
  const chunks: string[] = [];
  let start = 0;
  while (start < normalized.length) {
    let end = Math.min(start + maxCharacters, normalized.length);
    if (end < normalized.length) {
      const paragraph = normalized.lastIndexOf('\n\n', end);
      const sentence = normalized.lastIndexOf('. ', end);
      const split = Math.max(paragraph, sentence);
      if (split > start + Math.floor(maxCharacters * 0.55)) end = split + 1;
    }
    chunks.push(normalized.slice(start, end).trim());
    if (end >= normalized.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return chunks.filter(Boolean);
}

export function interpolate(
  template: string,
  variables: Record<string, unknown>,
): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_, key: string) => {
    if (!(key in variables)) return `{{${key}}}`;
    const value = variables[key];
    return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  });
}

export function extractLastParagraph(text: string): string {
  const paragraphs = text.trimEnd().split(/\n\s*\n/);
  return paragraphs.at(-1)?.slice(-2_000) ?? '';
}
