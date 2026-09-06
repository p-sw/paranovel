import { describe, expect, it } from 'vitest';
import { continuityReviewValidator, continuityReviewSchema } from '../src/ai/ai.schemas';
import {
  PromptRegistryService,
  REQUIRED_PROMPT_IDS,
  type PromptId,
} from '../src/prompts/prompt-registry.service';

const variables: Record<string, unknown> = {
  project_context: '{"title":"기억의 문"}',
  writing_direction: '하린의 1인칭 현재 시점과 절제된 문체를 유지한다.',
  improvements: '[]',
  canon: '[]',
  previous_arcs: '[]',
  future_arcs: '[]',
  current_arc: 'null',
  current_scene: 'null',
  recent_summaries: '[]',
  recent_episode_memories: '[]',
  open_foreshadowing: '[]',
  retrieved_memories: '[]',
  record_catalog: '[]',
  start_episode_number: 1,
  end_episode_number: 10,
  arc_to_revise: 'null',
  arc_request: '',
  generation_request: '',
  user_request: '',
  project_title: '기억의 문',
  logline: '잊힌 문을 찾는 기록관의 이야기',
  genre_tags: '["판타지"]',
  interview_answers: '[]',
  target_episode_answer: null,
  interview_completion: '{"confirmedFacts":[],"assumptions":[]}',
  episode_title: '문 앞에서',
  episode_direction: '기록관이 닫힌 문에 도착한다.',
  refinement_instruction: '마지막 장면의 긴장감만 높여줘.',
  episode_number: 1,
  episode_text: '기록관은 문 앞에 섰다.',
  episode_context: { title: '문 앞에서', selection: { start: 0, end: 0, text: '' } },
  previous_episode_memories: '[]',
  previous_paragraph: '기록관은 숨을 골랐다.',
  text_before_cursor: '기록관은 숨을 골랐다.',
  text_after_cursor: '문이 천천히 열렸다.',
  requested_length: 1000,
  target_length: 5000,
  direction_brief: '닫힌 문을 여는 장면',
  global_improvements: '[]',
  comparison_mode: 'EDITOR',
  original_text: '그는 놀랐다.',
  preferred_text: '그의 손끝이 굳었다.',
  existing_improvements: '[]',
  default_scope: 'PROJECT',
  boundary_context: '{"textBeforeCursor":"앞","textAfterCursor":"뒤"}',
  draft_text: '삽입 후보',
  review_issues: '[]',
  task_context: '{"user":"조선 후기 한양을 배경으로 집필"}',
  additional_description: '',
};

describe('expanded prompt contracts', () => {
  const promptIds: PromptId[] = [
    'continuity-review',
    'continuity-repair',
    'episode-direction',
    'episode-direction-refine',
    'arc-plan',
    'worldbuilding-generate',
  ];

  it.each(promptIds)('renders %s with every required runtime variable', (promptId) => {
    const registry = new PromptRegistryService();
    const rendered = registry.render(promptId, variables);

    expect(rendered.refs.map((ref) => ref.id)).toEqual([
      'novelist-core',
      'memory-contract',
      promptId,
    ]);
    expect(`${rendered.system}\n${rendered.user}`).not.toMatch(/\{\{\s*[a-zA-Z0-9_.-]+\s*\}\}/);
  });

  it.each(REQUIRED_PROMPT_IDS.filter((id) => !['novelist-core', 'memory-contract'].includes(id)))(
    'keeps the complete %s runtime contract renderable',
    (promptId) => {
      const registry = new PromptRegistryService();
      const rendered = registry.render(promptId, variables);

      expect(rendered.user).not.toMatch(/\{\{\s*[a-zA-Z0-9_.-]+\s*\}\}/);
    },
  );

  it('limits direction refinement to the requested parts of the latest plan and retains continuity rules', () => {
    const registry = new PromptRegistryService();
    const rendered = registry.render('episode-direction-refine', variables);

    expect(rendered.user).toContain(`<episode_title>\n${variables.episode_title}\n</episode_title>`);
    expect(rendered.user).toContain(`<episode_direction>\n${variables.episode_direction}\n</episode_direction>`);
    expect(rendered.user).toContain(`<refinement_instruction>\n${variables.refinement_instruction}\n</refinement_instruction>`);
    expect(rendered.system).toContain('매번 이 최신본에서 이어서 개선');
    expect(rendered.system).toContain('요청하지 않은 부분은 문구, 문장 순서, 줄바꿈과 공백까지 그대로 보존');
    expect(rendered.system).toContain('제목만 개선하라는 요청이면 direction 전체를 입력 그대로 반환');
    expect(rendered.system).toContain('전개 방향만 개선하라는 요청이면 title을 입력 그대로 반환');
    expect(rendered.system).toContain('Canon을 최우선');
    expect(rendered.system).toContain('이전 화의 사건을 요약·복습하거나 마지막 장면을 재연하는 도입');
    expect(rendered.system).toContain('해당 부분의 기존 내용을 보존하고 충돌 이유를 conflicts에 표시');
  });

  it.each([
    'worldbuilding-generate',
    'arc-plan',
    'project-chat',
    'episode-direction',
    'episode-direction-refine',
    'episode-draft',
    'episode-continue',
    'episode-editor',
    'continuity-repair',
  ] as PromptId[])('passes the persistent writing direction directly to %s', (promptId) => {
    const rendered = new PromptRegistryService().render(promptId, variables);

    expect(rendered.user).toContain(
      `<writing_direction>\n${variables.writing_direction}\n</writing_direction>`,
    );
    expect(rendered.system).toContain('작문 디렉션');
  });

  it('reviews only factual contradictions without importing general writing guidance', () => {
    const rendered = new PromptRegistryService().render('continuity-review', variables, { includeCore: false });
    expect(rendered.refs.map((ref) => ref.id)).toEqual(['memory-contract', 'continuity-review']);
    expect(rendered.system).toContain('설정·시간대·장소에 관한 사실 오류만');
    expect(rendered.system).toContain('서술 순서와 실제 사건 순서를 구분');
    expect(rendered.system).toContain('회상 속 시간·장소·인물 상태를 현재 장면과 직접 비교해 모순으로 만들지 않는다');
    expect(rendered.system).toContain('이를 설정·시간대·장소 오류로 재분류하지 않는다');
    expect(rendered.system).not.toContain('시점, 시제, 호칭, 말투, 공간 배치와 시간 흐름을 일관되게 유지');
    expect(rendered.user).not.toContain(String(variables.writing_direction));
    expect(rendered.user).toContain('시점·회상 등 서술 기법과 문체·구성은 문제로 보고하지 말라');
  });

  it('repairs only selected factual issues without smoothing insertion boundaries', () => {
    const rendered = new PromptRegistryService().render('continuity-repair', variables, { includeCore: false });
    expect(rendered.refs.map((ref) => ref.id)).toEqual(['memory-contract', 'continuity-repair']);
    expect(rendered.system).toContain('선택된 오류와 무관한 연결·전환·자연스러움을 다듬지 말고');
    expect(rendered.system).toContain('선택된 오류를 고치기 위해 실제로 바꾸는 부분의 표현을 정할 때만');
    expect(rendered.system).toContain('작문 디렉션을 이유로 수정 범위를 넓히거나 무관한 문장');
    expect(rendered.user).toContain('선택된 오류를 고치는 데 직접 필요한 경우가 아니면 삽입 원고의 시작과 끝을 바꾸지 말고');
    expect(rendered.user).toContain(
      `<writing_direction>\n${variables.writing_direction}\n</writing_direction>`,
    );
    expect(rendered.user).not.toContain('자연스럽게 맞도록');
  });

  it('uses the same narrow issue categories for the AI output schema and runtime validation', () => {
    const categories = ['CANON', 'TIMELINE', 'SCENE'];
    const schema = continuityReviewSchema as { properties: { issues: { items: { properties: { category: { enum: string[] } } } } } };
    expect(schema.properties.issues.items.properties.category.enum).toEqual(categories);
    for (const category of [...categories, 'CHARACTER', 'ARC', 'FORESHADOWING', 'STYLE']) {
      const parsed = continuityReviewValidator.safeParse({ issues: [{
        category, severity: 'WARNING', excerpt: '원고', explanation: '검토 문제', evidenceRefs: [], repairInstruction: '수정 방향',
      }] });
      expect(parsed.success, category).toBe(categories.includes(category));
    }
  });
});
