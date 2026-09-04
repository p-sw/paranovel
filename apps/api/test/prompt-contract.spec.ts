import { describe, expect, it } from 'vitest';
import {
  PromptRegistryService,
  REQUIRED_PROMPT_IDS,
  type PromptId,
} from '../src/prompts/prompt-registry.service';

const variables: Record<string, unknown> = {
  project_context: '{"title":"기억의 문"}',
  improvements: '[]',
  canon: '[]',
  previous_arcs: '[]',
  current_arc: 'null',
  current_scene: 'null',
  recent_summaries: '[]',
  recent_episode_memories: '[]',
  open_foreshadowing: '[]',
  retrieved_memories: '[]',
  start_episode_number: 1,
  arc_request: '',
  generation_request: '',
  user_request: '',
  project_title: '기억의 문',
  logline: '잊힌 문을 찾는 기록관의 이야기',
  genre_tags: '["판타지"]',
  interview_answers: '[]',
  episode_title: '문 앞에서',
  episode_direction: '기록관이 닫힌 문에 도착한다.',
  episode_number: 1,
  episode_text: '기록관은 문 앞에 섰다.',
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
};

describe('expanded prompt contracts', () => {
  const promptIds: PromptId[] = [
    'continuity-review',
    'continuity-repair',
    'episode-direction',
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
});
