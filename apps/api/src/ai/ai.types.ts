export type JsonSchema = Record<string, unknown>;

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
  reasoning?: string | null;
  reasoning_details?: unknown[];
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

export type ChatStreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'reset' }
  | { type: 'tool_start' | 'tool_end'; callId: string; name: string };

export interface CompletionResult {
  content: string;
  toolCalls: ToolCall[];
  usage: CompletionUsage;
  model: string;
  // Preserve provider metadata (including reasoning signatures) across tool turns.
  assistantMessage?: ChatMessage;
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
  modelRole?: 'WRITING' | 'IMPROVEMENT' | 'CHAT' | 'IMAGE_TAG';
  history?: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  includeCore?: boolean;
  includeMemoryContract?: boolean;
  includeReferenceTools?: boolean;
  signal?: AbortSignal;
}

export interface ContinuityIssue {
  category: 'CANON' | 'TIMELINE' | 'SCENE';
  severity: 'WARNING' | 'BLOCKING';
  excerpt: string;
  explanation: string;
  evidenceRefs: string[];
  repairInstruction: string;
}
