import { Anthropic } from '@anthropic-ai/sdk';
import type { AssistantBlock, LanguageModel, ModelRequest, ModelResponse } from './types.js';

export class AnthropicModel implements LanguageModel {
  private readonly client: Anthropic;

  constructor(
    apiKey: string,
    private readonly model: string,
    private readonly maxTokens = 1024,
  ) {
    this.client = new Anthropic({ apiKey });
  }

  async respond(request: ModelRequest): Promise<ModelResponse> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: this.maxTokens,
      system: [{ type: 'text', text: request.system, cache_control: { type: 'ephemeral' } }],
      tools: request.tools,
      messages: request.messages,
    });

    const content: AssistantBlock[] = [];
    for (const block of response.content) {
      if (block.type === 'text') content.push({ type: 'text', text: block.text });
      if (block.type === 'tool_use') content.push({ type: 'tool_use', id: block.id, name: block.name, input: block.input });
    }
    return { content, stopReason: response.stop_reason };
  }
}
