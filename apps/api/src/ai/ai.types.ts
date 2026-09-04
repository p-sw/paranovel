export type JsonSchema = Record<string, unknown>;

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: JsonSchema;
    strict?: boolean;
  };
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface CompletionUsage {
  promptTokens?: number;
  completionTokens?: number;
}

export interface CompletionResult {
  content: string;
  toolCalls: ToolCall[];
  usage: CompletionUsage;
  model: string;
}

export interface CompletionRequest {
  model: string;
  messages: ChatMessage[];
  schema?: { name: string; value: JsonSchema };
  tools?: ToolDefinition[];
  toolChoice?: 'auto' | 'required' | 'none';
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface PromptRunInput {
  task: string;
  promptId: string;
  variables: Record<string, unknown>;
  projectId?: string;
  episodeId?: string;
  schema?: { name: string; value: JsonSchema };
  tools?: ToolDefinition[];
  toolChoice?: 'auto' | 'required' | 'none';
  modelRole?: 'WRITING' | 'IMPROVEMENT';
  temperature?: number;
  maxTokens?: number;
  includeCore?: boolean;
  includeMemoryContract?: boolean;
  signal?: AbortSignal;
}

export interface ContinuityIssue {
  category:
    | 'CANON'
    | 'TIMELINE'
    | 'CHARACTER'
    | 'ARC'
    | 'SCENE'
    | 'FORESHADOWING'
    | 'STYLE';
  severity: 'WARNING' | 'BLOCKING';
  excerpt: string;
  explanation: string;
  evidenceRefs: string[];
  repairInstruction: string;
}
