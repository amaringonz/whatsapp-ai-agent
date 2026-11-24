import type { MediaRef } from '../whatsapp/webhook.js';

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

export type ImageMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

export interface ImageBlock {
  type: 'image';
  source: { type: 'base64'; media_type: ImageMediaType; data: string };
  ref?: MediaRef;
}

export interface DocumentBlock {
  type: 'document';
  title?: string;
  source:
    | { type: 'base64'; media_type: 'application/pdf'; data: string }
    | { type: 'text'; media_type: 'text/plain'; data: string };
  ref?: MediaRef;
}

export interface MediaRefBlock {
  type: 'media_ref';
  media: MediaRef;
}

export type CustomerBlock = TextBlock | ImageBlock | DocumentBlock | MediaRefBlock;

export type AssistantBlock = TextBlock | ToolUseBlock;

export type ChatMessage =
  | { role: 'user'; content: string | CustomerBlock[] | ToolResultBlock[] }
  | { role: 'assistant'; content: string | AssistantBlock[] };

export function isCustomerTurn(message: ChatMessage | undefined): boolean {
  if (message?.role !== 'user') return false;
  return typeof message.content === 'string' || !message.content.some((block) => block.type === 'tool_result');
}

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
