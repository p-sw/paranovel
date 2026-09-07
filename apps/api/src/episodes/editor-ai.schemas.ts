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

export const replaceTextInput = editToolInput.extend({
  original: z.string().min(1).max(100_000),
});

export const readManuscriptInput = z.strictObject({
  start: z.number().int().nonnegative(),
  length: z.number().int().min(1).max(20_000),
});

function toolParameters(input: typeof replaceTextInput | typeof readManuscriptInput) {
  const { $schema: _, ...parameters } = z.toJSONSchema(input);
  return parameters;
}

export const replaceTextTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'replace_text',
    description: '선택문이 없을 때 요청에 맞는 수정 범위를 원고에서 직접 골라 수정안을 준비한다. original에 현재 원고의 연속된 원문을 공백과 줄바꿈까지 그대로 복사하고 replacement에 그 범위를 교체할 본문을 넣는다. original은 원고에서 한 번만 나타나야 하며 중복되면 앞뒤 문맥을 포함한다. 삭제는 빈 replacement다. 서로 겹치지 않는 여러 범위는 한 번에 여러 번 호출할 수 있으며, 모두 같은 현재 원고를 기준으로 지정한다. 여러 수정은 하나의 비교 카드에 합쳐지고 사용자가 수락하기 전에는 원고가 변경되지 않는다.',
    parameters: toolParameters(replaceTextInput),
    strict: true,
  },
};

export const readManuscriptTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'read_manuscript',
    description: '현재 회차 원고에서 생략된 부분을 읽어 수정할 범위를 찾는다. start는 0부터 시작하는 UTF-16 위치, length는 읽을 길이(최대 20,000)다. 반환된 원문과 위치를 기준으로 필요하면 이어서 읽는다. 원고를 변경하지 않는다.',
    parameters: toolParameters(readManuscriptInput),
    strict: true,
  },
};

export function editorTool(hasSelection: boolean): ToolDefinition {
  const { $schema: _, ...parameters } = z.toJSONSchema(editToolInput);
  return {
    type: 'function',
    function: {
      name: hasSelection ? 'replace_selection' : 'insert_at_cursor',
      description: hasSelection
        ? '선택된 문장만 교체할 수정안을 준비한다. replacement에 교체할 본문 전체를 넣는다. 삭제는 빈 문자열이다. 선택 범위 밖의 내용은 바꿀 수 없다. 사용자가 적용하기 전에는 원고가 변경되지 않는다. 한 답변에 한 번만 호출한다.'
        : '현재 커서에 삽입할 소설 본문을 작성한다. 빈 원고에서는 첫 장면을, 기존 원고에서는 앞뒤에 이어지는 새 본문을 쓴다. 사용자가 적용하기 전에는 원고가 변경되지 않는다. 같은 커서에 한 번만 호출하며, 커서가 교체 범위 내부에 없으면 replace_text와 함께 호출할 수 있다.',
      parameters,
      strict: true,
    },
  };
}
