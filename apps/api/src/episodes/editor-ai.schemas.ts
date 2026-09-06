import { z } from 'zod';
import type { ToolDefinition } from '../ai/ai.types';

export const editorAiInput = z.strictObject({
  content: z.string().trim().min(1).max(20_000),
  clientMessageId: z.string().trim().min(1).max(200),
  expectedRevision: z.number().int().positive(),
  selection: z.strictObject({
    start: z.number().int().nonnegative(),
    end: z.number().int().nonnegative(),
    text: z.string().max(100_000),
  }),
});

export const editorReplyValidator = z.strictObject({ reply: z.string().trim().min(1).max(40_000) });
const { $schema: _, ...replySchema } = z.toJSONSchema(editorReplyValidator);
export const editorReplySchema = replySchema;

export const editToolInput = z.strictObject({
  title: z.string().trim().min(1).max(200),
  replacement: z.string().max(100_000),
});

export function editorTool(hasSelection: boolean): ToolDefinition {
  const { $schema: _, ...parameters } = z.toJSONSchema(editToolInput);
  return {
    type: 'function',
    function: {
      name: hasSelection ? 'replace_selection' : 'insert_at_cursor',
      description: hasSelection
        ? '선택된 문장만 교체할 수정안을 준비한다. replacement에 교체할 본문 전체를 넣는다. 삭제는 빈 문자열이다. 선택 범위 밖의 내용은 바꿀 수 없다. 사용자가 적용하기 전에는 원고가 변경되지 않는다. 한 답변에 한 번만 호출한다.'
        : '현재 커서에 삽입할 소설 본문을 작성한다. 빈 원고에서는 첫 장면을, 기존 원고에서는 앞뒤에 이어지는 새 본문을 쓴다. 사용자가 적용하기 전에는 원고가 변경되지 않는다. 한 답변에 한 번만 호출한다.',
      parameters,
      strict: true,
    },
  };
}
