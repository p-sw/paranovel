/**
 * Browser textarea offsets and String#slice both use UTF-16 code units. Keeping
 * this operation deliberately simple prevents Korean/emoji selections from
 * drifting between the DOM, API validation, and local preview.
 */
export function replaceUtf16Range(text: string, start: number, end: number, replacement: string): string {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > text.length) {
    throw new RangeError('Invalid UTF-16 range');
  }
  return `${text.slice(0, start)}${replacement}${text.slice(end)}`;
}

export function rangeStillMatches(text: string, start: number, end: number, expected: string): boolean {
  return start >= 0 && end >= start && end <= text.length && text.slice(start, end) === expected;
}
