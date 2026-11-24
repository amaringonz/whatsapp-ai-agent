import type { AssistantBlock, ChatMessage, CustomerBlock, LanguageModel, ModelRequest, ModelResponse, ToolResultBlock } from './types.js';

type InputContent =
  | { type: 'input_text'; text: string }
  | { type: 'input_image'; image_url: string }
  | { type: 'input_file'; filename: string; file_data: string };

type InputItem =
  | { role: 'user'; content: InputContent[] }
  | { role: 'assistant'; content: string }
  | { type: 'function_call'; call_id: string; name: string; arguments: string }
  | { type: 'function_call_output'; call_id: string; output: string };

interface OutputItem {
  type?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  content?: { type?: string; text?: string; refusal?: string }[];
}

interface OpenAIResponse {
  status?: string;
  output?: OutputItem[];
  incomplete_details?: { reason?: string } | null;
}

function customerContent(block: CustomerBlock): InputContent {
  if (block.type === 'text') return { type: 'input_text', text: block.text };
  if (block.type === 'media_ref') return { type: 'input_text', text: '[A file the customer sent earlier is no longer attached]' };
  if (block.type === 'image') {
    return { type: 'input_image', image_url: `data:${block.source.media_type};base64,${block.source.data}` };
  }
  if (block.source.type === 'base64') {
    return {
      type: 'input_file',
      filename: block.title ?? 'document.pdf',
      file_data: `data:application/pdf;base64,${block.source.data}`,
    };
  }
  return { type: 'input_text', text: `${block.title ? `File "${block.title}":\n` : ''}${block.source.data}` };
}

export function toOpenAIInput(history: ChatMessage[]): InputItem[] {
  const items: InputItem[] = [];
  for (const message of history) {
    if (message.role === 'user') {
      if (typeof message.content === 'string') {
        items.push({ role: 'user', content: [{ type: 'input_text', text: message.content }] });
        continue;
      }
      const blocks = message.content as (CustomerBlock | ToolResultBlock)[];
      for (const block of blocks) {
        if (block.type !== 'tool_result') continue;
        items.push({
          type: 'function_call_output',
          call_id: block.tool_use_id,
          output: block.is_error ? `Error: ${block.content}` : block.content,
        });
      }
      const content = blocks.filter((block): block is CustomerBlock => block.type !== 'tool_result').map(customerContent);
      if (content.length) items.push({ role: 'user', content });
      continue;
    }

    if (typeof message.content === 'string') {
      items.push({ role: 'assistant', content: message.content });
      continue;
    }
    const text = message.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n');
    if (text) items.push({ role: 'assistant', content: text });
    for (const block of message.content) {
      if (block.type !== 'tool_use') continue;
      items.push({ type: 'function_call', call_id: block.id, name: block.name, arguments: JSON.stringify(block.input ?? {}) });
    }
  }
  return items;
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
  const content: AssistantBlock[] = [];
  const texts: string[] = [];
  for (const item of response.output ?? []) {
    if (item.type === 'message') {
      for (const part of item.content ?? []) {
        const value = part.type === 'output_text' ? part.text : part.type === 'refusal' ? part.refusal : undefined;
        if (value) texts.push(value);
      }
    }
    if (item.type === 'function_call' && item.call_id && item.name) {
      content.push({ type: 'tool_use', id: item.call_id, name: item.name, input: parseArguments(item.arguments) });
    }
  }
  if (texts.length) content.unshift({ type: 'text', text: texts.join('\n') });
  const hasTools = content.some((block) => block.type === 'tool_use');
  return { content, stopReason: hasTools ? 'tool_use' : (response.incomplete_details?.reason ?? response.status ?? null) };
}

export class OpenAIError extends Error {
  constructor(
    readonly status: number,
    body: string,
  ) {
    super(`OpenAI ${status}: ${body.slice(0, 500)}`);
  }
}

export class OpenAIModel implements LanguageModel {
  constructor(
    private readonly options: {
      apiKey: string;
      model: string;
      baseUrl?: string;
      maxTokens?: number;
      reasoningEffort?: string;
      attempts?: number;
      retryDelayMs?: number;
      fetch?: typeof fetch;
    },
  ) {}

  async respond(request: ModelRequest): Promise<ModelResponse> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.request(request);
      } catch (error) {
        const status = error instanceof OpenAIError ? error.status : 0;
        const retryable = status === 0 || status === 408 || status === 409 || status === 429 || status >= 500;
        if (!retryable || attempt >= (this.options.attempts ?? 3)) throw error;
        await new Promise((resolve) => setTimeout(resolve, (this.options.retryDelayMs ?? 1000) * attempt));
      }
    }
  }

  private async request(request: ModelRequest): Promise<ModelResponse> {
    const send = this.options.fetch ?? fetch;
    const response = await send(`${(this.options.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '')}/responses`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.options.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.options.model,
        instructions: request.system,
        input: toOpenAIInput(request.messages),
        max_output_tokens: this.options.maxTokens ?? 4096,
        store: false,
        ...(this.options.reasoningEffort ? { reasoning: { effort: this.options.reasoningEffort } } : {}),
        ...(request.tools.length
          ? {
              tools: request.tools.map((tool) => ({
                type: 'function',
                name: tool.name,
                description: tool.description,
                parameters: tool.input_schema,
                strict: false,
              })),
            }
          : {}),
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new OpenAIError(response.status, await response.text());
    return fromOpenAIResponse((await response.json()) as OpenAIResponse);
  }
}
