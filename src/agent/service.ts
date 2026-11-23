import type { BusinessConfig } from '../config/business.js';
import type { BookingProvider } from '../booking/types.js';
import type { Notifier } from '../notify/types.js';
import type { ConversationStore, Conversation } from '../store/types.js';
import type { WhatsAppSender } from '../whatsapp/client.js';
import type { WebhookEvent } from '../whatsapp/webhook.js';
import { buildSystemPrompt, splitReply } from './prompt.js';
import { runAgent, transcript, trimHistory } from './run.js';
import { toolSpecs, type HandoffRequest } from './tools.js';
import type { AssistantBlock, ChatMessage, LanguageModel } from './types.js';

export const RESUME_COMMAND = '/bot';

export interface AgentServiceOptions {
  config: BusinessConfig;
  store: ConversationStore;
  whatsapp: WhatsAppSender;
  model: LanguageModel;
  notifier: Notifier;
  booking?: BookingProvider;
  debounceMs: number;
  humanPauseHours: number;
  historyLimit: number;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function normalizeHistory(history: ChatMessage[]): ChatMessage[] {
  const result: ChatMessage[] = [];
  for (const message of history) {
    if (!result.length && message.role === 'assistant') continue;
    const last = result.at(-1);
    if (last?.role === 'user' && message.role === 'user' && (typeof last.content !== 'string' || typeof message.content !== 'string')) {
      result.push({ role: 'assistant', content: '(no reply)' });
      result.push(structuredClone(message));
      continue;
    }
    if (last && last.role === message.role) {
      if (last.role === 'user' && typeof last.content === 'string' && typeof message.content === 'string') {
        last.content = `${last.content}\n${message.content}`;
        continue;
      }
      if (last.role === 'assistant' && message.role === 'assistant') {
        const toBlocks = (content: string | AssistantBlock[]): AssistantBlock[] =>
          typeof content === 'string' ? [{ type: 'text', text: content }] : content;
        const merged = [...toBlocks(last.content), ...toBlocks(message.content)];
        if (!merged.some((block) => block.type === 'tool_use')) {
          last.content = merged;
          continue;
        }
      }
    }
    result.push(structuredClone(message));
  }
  return result;
}

export class AgentService {
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: AgentServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.sleep = options.sleep ?? wait;
  }

  async handle(event: WebhookEvent): Promise<void> {
    if (!(await this.options.store.claimEvent(event.id))) return;
    if (event.kind === 'echo') return this.handleEcho(event.to, event.text);

    await this.options.store.queueMessage(event.from, event.id, event.text);
    await this.options.whatsapp.markReadAndTyping(event.id).catch((error) => console.warn('Typing indicator failed', error));

    if (event.name) {
      const conversation = await this.options.store.load(event.from);
      if (conversation.state.name !== event.name) {
        conversation.state.name = event.name;
        await this.options.store.save(event.from, conversation);
      }
    }

    await this.sleep(this.options.debounceMs);
    if ((await this.options.store.latestMessageId(event.from)) !== event.id) return;
    await this.process(event.from);
  }

  private async handleEcho(contact: string, text: string): Promise<void> {
    const conversation = await this.options.store.load(contact);
    if (text.trim().toLowerCase() === RESUME_COMMAND) {
      conversation.state.pausedUntil = undefined;
      conversation.state.pauseReason = undefined;
    } else {
      conversation.state.pausedUntil = this.now().getTime() + this.options.humanPauseHours * 3_600_000;
      conversation.state.pauseReason = 'human_reply';
      if (text.trim()) {
        conversation.history.push({ role: 'assistant', content: `(${this.options.config.assistant.owner}) ${text.trim()}` });
      }
    }
    await this.options.store.save(contact, conversation);
  }

  private paused(conversation: Conversation): boolean {
    return Boolean(conversation.state.pausedUntil && conversation.state.pausedUntil > this.now().getTime());
  }

  async process(contact: string): Promise<void> {
    const { store } = this.options;
    if (!(await store.lock(contact, 120))) return;
    try {
      for (let round = 0; round < 3; round += 1) {
        const queued = await store.takeQueued(contact);
        if (!queued.length) return;

        const conversation = await store.load(contact);
        conversation.history.push({ role: 'user', content: queued.join('\n') });

        if (this.paused(conversation)) {
          await store.save(contact, conversation);
          return;
        }

        await this.reply(contact, conversation);
      }
    } finally {
      await store.unlock(contact);
    }
  }

  private async reply(contact: string, conversation: Conversation): Promise<void> {
    const { config, model, booking, whatsapp, notifier, store, historyLimit, humanPauseHours } = this.options;
    const history = normalizeHistory(trimHistory(conversation.history, historyLimit));
    let handoff: HandoffRequest | undefined;

    const turn = await runAgent({
      model,
      system: buildSystemPrompt(config, {
        now: this.now(),
        contactName: conversation.state.name,
        lead: conversation.state.lead,
      }),
      history,
      tools: toolSpecs(config, Boolean(booking)),
      context: {
        contact,
        config,
        booking,
        onLead: (lead) => {
          conversation.state.lead = { ...conversation.state.lead, ...Object.fromEntries(Object.entries(lead).filter(([, value]) => value)) };
        },
        onHandoff: async (request) => {
          handoff = request;
        },
      },
    });

    conversation.history = turn.history;
    for (const message of splitReply(turn.reply)) {
      await whatsapp.sendText(contact, message);
    }

    if (handoff) {
      conversation.state.pausedUntil = this.now().getTime() + humanPauseHours * 3_600_000;
      conversation.state.pauseReason = 'handoff';
      conversation.state.lastHandoff = handoff.reason;
      await notifier
        .notify({
          reason: handoff.reason,
          contact,
          name: conversation.state.lead?.name ?? conversation.state.name,
          summary: handoff.summary,
          lead: { ...conversation.state.lead, ...handoff.lead },
          transcript: transcript(conversation.history, config.business.name),
          business: config.business.name,
        })
        .catch((error) => console.error('Handoff notification failed', error));
    }

    await store.save(contact, conversation);
  }
}
