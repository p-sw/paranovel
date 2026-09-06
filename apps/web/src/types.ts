import type {
  AiStreamEvent,
  Arc as ContractArc,
  CanonCategory,
  CanonEntry as ContractCanonEntry,
  ContinuityIssue,
  Episode,
  EpisodeSummary,
  Improvement,
  ImprovementCandidate,
  ImprovementScope,
  Project,
  ProjectBlueprint as ContractProjectBlueprint,
  SceneState,
  SetupQuestion,
  SetupAnswerRecord,
} from '@paranovel/contracts';

export type {
  CanonCategory,
  ContinuityIssue,
  Episode,
  EpisodeSummary,
  Improvement,
  ImprovementCandidate,
  ImprovementScope,
  Project,
  SetupQuestion,
  SetupAnswerRecord,
};

// API views expose review state and compatibility aliases in addition to the
// stable shared entities. Keep those narrow additions at the HTTP boundary.
export type CanonEntry = ContractCanonEntry & {
  status?: 'ACTIVE' | 'PENDING' | 'ACCEPTED' | 'REJECTED';
  sourceEpisodeId?: string | null;
};

export type Arc = ContractArc & {
  startEpisodeNumber?: number;
  endEpisodeNumber?: number;
  revision?: number;
};

export type CurrentScene = SceneState;
export type StreamEvent = AiStreamEvent;

export interface ArcPlanProposal {
  title: string;
  startEpisodeNumber: number;
  endEpisodeNumber: number;
  goal: string;
  conflict: string;
  reversalPlan: Array<{ episode: number; description: string }>;
  episodeDirections: Array<{ episode: number; title: string; direction: string }>;
  conflicts: string[];
}

export type ProjectBlueprint = ContractProjectBlueprint & {
  defaultTargetChars?: number;
};

export type ProjectSessionStep =
  | { type: 'question'; question: SetupQuestion }
  | { type: 'ready'; blueprint: ProjectBlueprint };

export interface ProjectSession {
  id: string;
  status?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface ProjectSessionResult {
  session: ProjectSession;
  step: ProjectSessionStep;
  history?: SetupAnswerRecord[];
  stateToken?: string;
}

export interface ImprovementSuggestion {
  title: string;
  rule: string;
  rationale: string;
  tags: string[];
  beforeExample?: string;
  afterExample?: string;
}

export interface StreamResult {
  content: string;
  issues: ContinuityIssue[];
  blocked: boolean;
  runId?: string;
  baseRevision?: number;
}

export interface SelectionSnapshot {
  start: number;
  end: number;
  text: string;
  content: string;
  revision: number;
}

export type SaveState = 'idle' | 'saving' | 'saved' | 'error';
export type AiPhase = 'idle' | 'retrieving' | 'writing' | 'checking' | 'repairing' | 'done' | 'error' | 'cancelled';
