import { runTool, type ToolContext } from './tools.js';
import { isCustomerTurn, type AssistantBlock, type ChatMessage, type LanguageModel, type ToolResultBlock, type ToolSpec } from './types.js';

export interface AgentTurn {
  history: ChatMessage[];
  reply: string;
}

export async function runAgent(options: {
  model: LanguageModel;
  system: string;
  history: ChatMessage[];
  tools: ToolSpec[];
  context: ToolContext;
  maxSteps?: number;
}): Promise<AgentTurn> {
  const history = [...options.history];
  const replies: string[] = [];
  const maxSteps = options.maxSteps ?? 6;

  for (let step = 0; step < maxSteps; step += 1) {
    const response = await options.model.respond({
      system: options.system,
      messages: history,
      tools: options.tools,
    });

    const content: AssistantBlock[] = response.content.length ? response.content : [{ type: 'text', text: '(no reply)' }];
    history.push({ role: 'assistant', content });

    const text = content
      .filter((block) => block.type === 'text')
      .map((block) => block.text.trim())
      .filter((value) => value && value !== '(no reply)')
      .join('\n');
    if (text) replies.push(text);

    const calls = content.filter((block) => block.type === 'tool_use');
    if (!calls.length || response.stopReason !== 'tool_use') break;

    const results: ToolResultBlock[] = [];
    for (const call of calls) {
      try {
        results.push({ type: 'tool_result', tool_use_id: call.id, content: await runTool(call.name, call.input, options.context) });
      } catch (error) {
        console.error(`Tool ${call.name} failed`, error);
        results.push({
          type: 'tool_result',
          tool_use_id: call.id,
          content: 'The tool failed. Apologize briefly and hand off the conversation if you cannot continue.',
          is_error: true,
        });
      }
    }
    history.push({ role: 'user', content: results });
  }

  return { history, reply: replies.join(`\n---\n`) };
}

export function trimHistory(history: ChatMessage[], limit: number): ChatMessage[] {
  if (history.length <= limit) return history;
  for (let index = history.length - limit; index < history.length; index += 1) {
    const message = history[index];
    if (isCustomerTurn(message)) return history.slice(index);
  }
  const lastUser = history.findLastIndex((message) => isCustomerTurn(message));
  return lastUser >= 0 ? history.slice(lastUser) : [];
}

export function transcript(history: ChatMessage[], business: string, limit = 20): string {
  return history
    .flatMap((message) => {
      if (typeof message.content === 'string') {
        return [`${message.role === 'user' ? 'Customer' : business}: ${message.content}`];
      }
      if (isCustomerTurn(message)) {
        const said = (message.content as { type: string; text?: string; title?: string }[])
          .map((block) => (block.type === 'text' ? block.text : block.type === 'image' ? '[photo]' : `[document${block.title ? ` ${block.title}` : ''}]`))
          .join('\n');
        return [`Customer: ${said}`];
      }
      if (message.role === 'assistant') {
        return message.content
          .filter((block) => block.type === 'text' && block.text.trim())
          .map((block) => `${business}: ${(block as { text: string }).text.trim()}`);
      }
      return [];
    })
    .slice(-limit)
    .join('\n');
}
