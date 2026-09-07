import { describe, expect, it, vi } from 'vitest';
import { JsonReplyStream } from '../src/ai/json-reply-stream';

describe('structured reply streaming', () => {
  it('decodes escaped keys, quotes, controls and surrogate pairs without exposing nested JSON', () => {
    const onDelta = vi.fn();
    const stream = new JsonReplyStream(onDelta);
    const reply = '한글 "인용" \\ 경로\n다음\t줄\r\b\f/🌙';
    const json = '{"proposals":[{"reply":"hidden","value":{"a":["reply", "\\\""]}}],"count":12,"ok":true,"re\\u0070ly":'
      + JSON.stringify(reply).replace('🌙', '\\ud83c\\udf19') + '}';
    for (const character of json.split('')) stream.write(character);
    expect(stream.text).toBe(reply);
    expect(onDelta.mock.calls.map(([text]) => text).join('')).toBe(reply);
    expect(onDelta.mock.calls.at(-1)).toEqual(['🌙']);
  });

  it('emits a reply prefix while the JSON string is still incomplete', () => {
    const onDelta = vi.fn();
    const stream = new JsonReplyStream(onDelta);
    stream.write('{"reply":"먼저 도착한');
    expect(onDelta).toHaveBeenCalledWith('먼저 도착한');
    stream.write(' 문장","proposals":[');
    expect(stream.text).toBe('먼저 도착한 문장');
  });

  it.each(['[ {"reply":"hidden"}]', '```json\n{"reply":"hidden"}', '{"other":{"reply":"hidden"}}'])('ignores replies outside the root object', (json) => {
    const onDelta = vi.fn();
    new JsonReplyStream(onDelta).write(json);
    expect(onDelta).not.toHaveBeenCalled();
  });
});
