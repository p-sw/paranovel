import type {
  AiStreamEvent,
  Arc as ContractArc,
  CanonCategory,
  CanonEntry as ContractCanonEntry,
  ContinuityIssue,
  Episode as ContractEpisode,
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
  EpisodeSummary,
  Improvement,
  ImprovementCandidate,
  ImprovementScope,
  Project,
  SetupQuestion,
  SetupAnswerRecord,
};

export type EpisodeKind = 'MAIN' | 'SIDE_STORY';

// Older API responses do not carry a kind yet, so MAIN remains the compatible
// default at the HTTP boundary. Standalone side stories intentionally have no
// number; grouped side stories use a number local to their group.
export type Episode = Omit<ContractEpisode, 'number'> & {
  kind?: EpisodeKind;
  number: number | null;
  sideStoryGroupId?: string | null;
  branchFromEpisodeId?: string | null;
};

// API views expose review state and compatibility aliases in addition to the
// stable shared entities. Keep those narrow additions at the HTTP boundary.
export type CanonEntry = ContractCanonEntry & {
  status?: 'ACTIVE' | 'PENDING' | 'ACCEPTED' | 'REJECTED';
  sourceEpisodeId?: string | null;
};

export type ArcMilestoneType = 'GOAL' | 'REVERSAL' | 'ESCALATION' | 'CLIMAX' | 'RESOLUTION' | 'OTHER';

export interface ArcMilestone {
  id?: string;
  episode: number;
  type: ArcMilestoneType;
  description: string;
}

export interface ArcEpisodeDirection {
  episode: number;
  title: string;
  direction: string;
}

// Keep the HTTP boundary usable while the shared contract and older cached
// responses move from reversalPlan to milestones plus complete episode plans.
export type Arc = Omit<ContractArc, 'reversalPlan' | 'milestones' | 'episodeDirections'> & {
  milestones: ArcMilestone[];
  episodeDirections: ArcEpisodeDirection[];
  startEpisodeNumber?: number;
  endEpisodeNumber?: number;
  revision?: number;
};

export interface SideStoryGroup {
  id: string;
  projectId: string;
  title: string;
  description: string;
  branchFromEpisodeId: string | null;
  nextEpisodeNumber: number;
  revision: number;
  canon: CanonEntry[];
  arc: Arc;
  episodes?: Episode[];
  createdAt?: string;
  updatedAt?: string;
}

export interface SideStoryCollection {
  standalone: Episode[];
  groups: Array<SideStoryGroup & { episodes: Episode[] }>;
}

export interface EpisodeFlow {
  kind: EpisodeKind;
  label: string;
  group: Pick<SideStoryGroup, 'id' | 'projectId' | 'title' | 'description' | 'branchFromEpisodeId' | 'nextEpisodeNumber' | 'revision' | 'createdAt' | 'updatedAt'> | null;
  episodes: Episode[];
}

export interface CreateSideStoryGroupInput {
  title: string;
  description?: string;
  branchFromEpisodeId: string | null;
  canon: string;
  arc: {
    title: string;
    goal: string;
    conflict: string;
    endEpisodeNumber?: number;
    reversalPlan?: Array<{ episode: number; description: string }>;
    milestones?: ArcMilestone[];
    episodeDirections?: ArcEpisodeDirection[];
  };
}

export type CurrentScene = SceneState;
export type StreamEvent = AiStreamEvent;

export interface ArcPlanProposal {
  title: string;
  startEpisodeNumber: number;
  endEpisodeNumber: number;
  goal: string;
  conflict: string;
  milestones: ArcMilestone[];
  episodeDirections: ArcEpisodeDirection[];
  conflicts: string[];
  replaceArcId?: string;
  replaceArcRevision?: number;
}

type ContractBlueprintArc = ContractProjectBlueprint['arcs'][number];

export type ProjectBlueprint = Omit<ContractProjectBlueprint, 'arcs'> & {
  arcs: Array<Omit<ContractBlueprintArc, 'reversalPlan' | 'milestones' | 'episodeDirections'> & {
    milestones: ArcMilestone[];
    episodeDirections: ArcEpisodeDirection[];
  }>;
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
