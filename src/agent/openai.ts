import type { AssistantBlock, ChatMessage, CustomerBlock, LanguageModel, ModelRequest, ModelResponse, ToolResultBlock } from './types.js';

type OpenAIContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }
  | { type: 'file'; file: { filename: string; file_data: string } };

type OpenAIMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | OpenAIContentPart[] }
  | {
      role: 'assistant';
      content: string | null;
      tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
    }
  | { role: 'tool'; tool_call_id: string; content: string };

interface OpenAIResponse {
  choices?: {
    finish_reason?: string;
    message?: {
      content?: string | null;
      refusal?: string | null;
      tool_calls?: { id: string; type: string; function?: { name?: string; arguments?: string } }[];
    };
  }[];
}

function customerPart(block: CustomerBlock): OpenAIContentPart {
  if (block.type === 'text') return { type: 'text', text: block.text };
  if (block.type === 'image') {
    return { type: 'image_url', image_url: { url: `data:${block.source.media_type};base64,${block.source.data}` } };
  }
  if (block.source.type === 'base64') {
    return {
      type: 'file',
      file: { filename: block.title ?? 'document.pdf', file_data: `data:application/pdf;base64,${block.source.data}` },
    };
  }
  return { type: 'text', text: `${block.title ? `File "${block.title}":\n` : ''}${block.source.data}` };
}

export function toOpenAIMessages(system: string, history: ChatMessage[]): OpenAIMessage[] {
  const messages: OpenAIMessage[] = [{ role: 'system', content: system }];
  for (const message of history) {
    if (message.role === 'user') {
      if (typeof message.content === 'string') {
        messages.push({ role: 'user', content: message.content });
        continue;
      }
      const blocks = message.content as (CustomerBlock | ToolResultBlock)[];
      const results = blocks.filter((block): block is ToolResultBlock => block.type === 'tool_result');
      for (const result of results) {
        messages.push({
          role: 'tool',
          tool_call_id: result.tool_use_id,
          content: result.is_error ? `Error: ${result.content}` : result.content,
        });
      }
      const parts = blocks.filter((block): block is CustomerBlock => block.type !== 'tool_result').map(customerPart);
      if (parts.length) messages.push({ role: 'user', content: parts });
      continue;
    }

    if (typeof message.content === 'string') {
      messages.push({ role: 'assistant', content: message.content });
      continue;
    }
    const text = message.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n');
    const calls = message.content
      .filter((block) => block.type === 'tool_use')
      .map((block) => ({
        id: block.id,
        type: 'function' as const,
        function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
      }));
    messages.push({ role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
  }
  return messages;
}

function parseArguments(value: string | undefined): unknown {
  if (!value) return {};
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

export function fromOpenAIResponse(response: OpenAIResponse): ModelResponse {
  const choice = response.choices?.[0];
  const message = choice?.message;
  const content: AssistantBlock[] = [];
  const text = message?.content ?? message?.refusal;
  if (text) content.push({ type: 'text', text });
  for (const call of message?.tool_calls ?? []) {
    if (call.type !== 'function' || !call.function?.name) continue;
    content.push({ type: 'tool_use', id: call.id, name: call.function.name, input: parseArguments(call.function.arguments) });
  }
  const hasTools = content.some((block) => block.type === 'tool_use');
  return { content, stopReason: hasTools ? 'tool_use' : (choice?.finish_reason ?? null) };
}

export class OpenAIModel implements LanguageModel {
  constructor(
    private readonly options: {
      apiKey: string;
      model: string;
      baseUrl?: string;
      maxTokens?: number;
      fetch?: typeof fetch;
    },
  ) {}

  async respond(request: ModelRequest): Promise<ModelResponse> {
    const send = this.options.fetch ?? fetch;
    const response = await send(`${(this.options.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.options.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.options.model,
        max_completion_tokens: this.options.maxTokens ?? 4096,
        messages: toOpenAIMessages(request.system, request.messages),
        ...(request.tools.length
          ? {
              tools: request.tools.map((tool) => ({
                type: 'function',
                function: { name: tool.name, description: tool.description, parameters: tool.input_schema },
              })),
            }
          : {}),
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error(`OpenAI ${response.status}: ${await response.text()}`);
    return fromOpenAIResponse((await response.json()) as OpenAIResponse);
  }
}
