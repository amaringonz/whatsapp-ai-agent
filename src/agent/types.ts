export interface TextBlock {
  type: 'text';
  text: string;
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export type AssistantBlock = TextBlock | ToolUseBlock;

export type ChatMessage =
  | { role: 'user'; content: string | ToolResultBlock[] }
  | { role: 'assistant'; content: string | AssistantBlock[] };

export interface ToolSpec {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
}

export interface ModelRequest {
  system: string;
  messages: ChatMessage[];
  tools: ToolSpec[];
}

export interface ModelResponse {
  content: AssistantBlock[];
  stopReason: string | null;
}

export interface LanguageModel {
  respond(request: ModelRequest): Promise<ModelResponse>;
}
