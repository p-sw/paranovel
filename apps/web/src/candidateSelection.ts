import type { ImprovementCandidate } from './types';

export function candidateNeedsExplicitSelection(candidate: ImprovementCandidate): boolean {
  return Boolean(candidate.duplicateOfId || candidate.conflictsWithIds?.length);
}

export function defaultCandidateSelection(candidates: ImprovementCandidate[]): number[] {
  return candidates.flatMap((candidate, index) =>
    candidateNeedsExplicitSelection(candidate) ? [] : [index],
  );
}
