import { describe, expect, it } from 'vitest';
import type { ImprovementCandidate } from './types';
import { candidateNeedsExplicitSelection, defaultCandidateSelection } from './candidateSelection';

function candidate(overrides: Partial<ImprovementCandidate> = {}): ImprovementCandidate {
  return {
    title: '대사의 호흡',
    rule: '짧은 반응을 섞는다.',
    rationale: '대화의 속도를 조절한다.',
    category: 'STYLE',
    tags: [],
    confidence: 0.8,
    conflictsWithIds: [],
    ...overrides,
  };
}

describe('improvement candidate safety', () => {
  it('requires an explicit opt-in for duplicates and conflicts', () => {
    const candidates = [
      candidate(),
      candidate({ duplicateOfId: 'existing-1' }),
      candidate({ conflictsWithIds: ['existing-2'] }),
    ];

    expect(defaultCandidateSelection(candidates)).toEqual([0]);
    expect(candidateNeedsExplicitSelection(candidates[1])).toBe(true);
    expect(candidateNeedsExplicitSelection(candidates[2])).toBe(true);
  });
});
