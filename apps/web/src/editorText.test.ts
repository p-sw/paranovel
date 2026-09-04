import { describe, expect, it } from 'vitest';
import { rangeStillMatches, replaceUtf16Range } from './editorText';

describe('UTF-16 editor ranges', () => {
  it('replaces exactly the selected Korean sentence and preserves its suffix', () => {
    const content = '그는 문을 열었다.\n뒤에서 바람이 불었다.';
    const selected = '문을 열었다';
    const start = content.indexOf(selected);
    const end = start + selected.length;

    expect(rangeStillMatches(content, start, end, selected)).toBe(true);
    expect(replaceUtf16Range(content, start, end, '봉인된 문을 밀어 열었다')).toBe(
      '그는 봉인된 문을 밀어 열었다.\n뒤에서 바람이 불었다.',
    );
  });

  it('uses the same UTF-16 offsets as textarea selection around surrogate pairs', () => {
    const content = '서막🗝️ 다음 문단';
    const start = content.indexOf(' 다음');
    expect(replaceUtf16Range(content, start, start, '—기억—')).toBe('서막🗝️—기억— 다음 문단');
  });

  it('rejects stale or invalid ranges', () => {
    expect(rangeStillMatches('변경된 문장', 0, 2, '원래')).toBe(false);
    expect(() => replaceUtf16Range('짧음', 0, 99, '')).toThrow(RangeError);
  });
});
