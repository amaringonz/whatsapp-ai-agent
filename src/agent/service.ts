import type { BusinessConfig } from '../config/business.js';
import type { BookingProvider } from '../booking/types.js';
import type { Notifier } from '../notify/types.js';
import type { ConversationStore, Conversation } from '../store/types.js';
import type { WhatsAppSender } from '../whatsapp/client.js';
import type { WebhookEvent } from '../whatsapp/webhook.js';
import { buildSystemPrompt, splitReply } from './prompt.js';
import { runAgent, transcript, trimHistory } from './run.js';
import { toolSpecs, type HandoffRequest } from './tools.js';
import { isCustomerTurn, type AssistantBlock, type ChatMessage, type CustomerBlock, type LanguageModel } from './types.js';
import { stripAttachments, type MediaReader } from '../media/reader.js';
import type { QueuedMessage } from '../store/types.js';

export const RESUME_COMMAND = '/bot';
export const BLOCK_COMMANDS = ['/block', '/bloquear'];
export const UNBLOCK_COMMANDS = ['/unblock', '/desbloquear'];

export interface AgentLimits {
  messagesPerMinute: number;
  messagesPerDay: number;
  mediaPerDay: number;
  bookingsPerWeek: number;
  repliesPerDay: number;
  maxMessageChars: number;
  maxTurnChars: number;
  maxMessageAgeMinutes: number;
}

export const DEFAULT_LIMITS: AgentLimits = {
  messagesPerMinute: 10,
  messagesPerDay: 60,
  mediaPerDay: 8,
  bookingsPerWeek: 2,
  repliesPerDay: 1500,
  maxMessageChars: 1500,
  maxTurnChars: 4000,
  maxMessageAgeMinutes: 360,
};

const DAY_SECONDS = 86_400;
const digits = (value: string) => value.replace(/\D/g, '');

export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n[The rest of this message was cut because it was too long.]` : text;
}

export interface AgentServiceOptions {
  config: BusinessConfig;
  store: ConversationStore;
  whatsapp: WhatsAppSender;
  model: LanguageModel;
  notifier: Notifier;
  booking?: BookingProvider;
  media?: MediaReader;
  limits?: Partial<AgentLimits>;
  blockedNumbers?: string[];
  debounceMs: number;
  humanPauseHours: number;
  historyLimit: number;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const asCustomerBlocks = (content: string | CustomerBlock[]): CustomerBlock[] =>
  typeof content === 'string' ? [{ type: 'text', text: content }] : content;

export function normalizeHistory(history: ChatMessage[]): ChatMessage[] {
  const result: ChatMessage[] = [];
  for (const message of history) {
    if (!result.length && message.role === 'assistant') continue;
    const last = result.at(-1);
    if (last?.role === 'user' && message.role === 'user') {
      if (isCustomerTurn(last) && isCustomerTurn(message)) {
        const before = last.content as string | CustomerBlock[];
        const after = message.content as string | CustomerBlock[];
        last.content =
          typeof before === 'string' && typeof after === 'string'
            ? `${before}\n${after}`
            : [...asCustomerBlocks(before), ...structuredClone(asCustomerBlocks(after))];
        continue;
      }
      result.push({ role: 'assistant', content: '(no reply)' });
      result.push(structuredClone(message));
      continue;
    }
    if (last?.role === 'assistant' && message.role === 'assistant') {
      const toBlocks = (content: string | AssistantBlock[]): AssistantBlock[] =>
        typeof content === 'string' ? [{ type: 'text', text: content }] : content;
      const merged = [...toBlocks(last.content), ...toBlocks(message.content)];
      if (!merged.some((block) => block.type === 'tool_use')) {
        last.content = merged;
        continue;
      }
    }
    result.push(structuredClone(message));
  }
  return result;
}

export class AgentService {
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly limits: AgentLimits;
  private readonly blocked: Set<string>;

  constructor(private readonly options: AgentServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.sleep = options.sleep ?? wait;
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
    this.blocked = new Set((options.blockedNumbers ?? []).map(digits).filter(Boolean));
  }

  private today(): string {
    return new Intl.DateTimeFormat('en-CA', { timeZone: this.options.config.business.timezone }).format(this.now());
  }

  async isBlocked(contact: string): Promise<boolean> {
    return this.blocked.has(digits(contact)) || (await this.options.store.hasFlag(`blocked:${contact}`));
  }

  private async alertOnce(key: string, subject: string, text: string, seconds = 3600): Promise<void> {
    const { store, notifier, config } = this.options;
    if (!notifier.alert) return;
    if (!(await store.setFlag(`alert:${key}`, seconds))) return;
    await notifier.alert(`[${config.business.name}] ${subject}`, text).catch((error) => console.error('Alert failed', error));
  }

  private async withinRate(contact: string): Promise<'ok' | 'drop' | 'limit'> {
    const { store } = this.options;
    if ((await store.increment(`rate:minute:${contact}`, 60)) > this.limits.messagesPerMinute) return 'drop';
    const today = await store.increment(`rate:day:${contact}:${this.today()}`, 2 * DAY_SECONDS);
    if (today <= this.limits.messagesPerDay) return 'ok';
    return today === this.limits.messagesPerDay + 1 ? 'limit' : 'drop';
  }

  private async limitReached(contact: string): Promise<void> {
    const { store, whatsapp, notifier, config, humanPauseHours } = this.options;
    const conversation = await store.load(contact);
    conversation.state.pausedUntil = this.now().getTime() + humanPauseHours * 3_600_000;
    conversation.state.pauseReason = 'handoff';
    conversation.state.lastHandoff = 'limit';
    await whatsapp.sendText(contact, config.fallbacks.limit).catch((error) => console.error('Limit notice failed', error));
    await store.save(contact, conversation);
    await notifier
      .notify({
        reason: 'limit',
        contact,
        name: conversation.state.lead?.name ?? conversation.state.name,
        summary: `This contact sent more than ${this.limits.messagesPerDay} messages today, so the assistant paused the chat to protect your AI budget.`,
        lead: conversation.state.lead ?? {},
        transcript: transcript(conversation.history, config.business.name),
        business: config.business.name,
      })
      .catch((error) => console.error('Limit notification failed', error));
  }

  private async admit(event: Extract<WebhookEvent, { kind: 'inbound' }>): Promise<QueuedMessage | undefined> {
    if (await this.isBlocked(event.from)) return undefined;
    if (event.timestamp && this.now().getTime() - event.timestamp * 1000 > this.limits.maxMessageAgeMinutes * 60_000) {
      return undefined;
    }

    const rate = await this.withinRate(event.from);
    if (rate === 'limit') await this.limitReached(event.from);
    if (rate !== 'ok') return undefined;

    const text = clip(event.text, this.limits.maxMessageChars);
    if (!event.media) return { text };
    const files = await this.options.store.increment(`media:day:${event.from}:${this.today()}`, 2 * DAY_SECONDS);
    if (files > this.limits.mediaPerDay) {
      return { text: `[The customer sent a ${event.media.type}, but already sent the maximum of ${this.limits.mediaPerDay} files for today. Ask them kindly to write what it says.]` };
    }
    return { text, media: event.media };
  }

  async handle(event: WebhookEvent): Promise<void> {
    if (!(await this.options.store.claimEvent(event.id))) return;
    if (event.kind === 'echo') return this.handleEcho(event.to, event.text);

    const message = await this.admit(event);
    if (!message) return;

    await this.options.store.queueMessage(event.from, event.id, message);
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
    const command = text.trim().toLowerCase();
    if (BLOCK_COMMANDS.includes(command)) {
      await this.options.store.setFlag(`blocked:${contact}`);
      return;
    }
    if (UNBLOCK_COMMANDS.includes(command)) {
      await this.options.store.clearFlag(`blocked:${contact}`);
      return;
    }

    const conversation = await this.options.store.load(contact);
    if (command === RESUME_COMMAND) {
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
        if (this.paused(conversation)) {
          conversation.history.push({ role: 'user', content: queued.map((item) => item.text).join('\n') });
          await store.save(contact, conversation);
          return;
        }

        let room = this.limits.maxTurnChars;
        const items = queued.map((item) => {
          const text = clip(item.text, Math.max(room, 0));
          room -= item.text.length;
          return { ...item, text };
        });

        if (!(await this.withinBudget())) {
          conversation.history.push({ role: 'user', content: items.map((item) => item.text).join('\n') });
          await this.options.whatsapp.sendText(contact, this.options.config.fallbacks.busy).catch((error) => console.error('Busy notice failed', error));
          await store.save(contact, conversation);
          return;
        }

        const content = this.options.media
          ? await this.options.media.read(items)
          : items.map((item) => item.text).join('\n');
        conversation.history.push({ role: 'user', content });
        try {
          await this.reply(contact, conversation);
        } catch (error) {
          await this.failed(contact, conversation, error);
        }
      }
    } finally {
      await store.unlock(contact);
    }
  }

  private async withinBudget(): Promise<boolean> {
    const replies = await this.options.store.increment(`replies:day:${this.today()}`, 2 * DAY_SECONDS);
    if (replies <= this.limits.repliesPerDay) return true;
    await this.alertOnce(
      `budget:${this.today()}`,
      'Daily AI limit reached',
      `The assistant reached its limit of ${this.limits.repliesPerDay} replies for today, so new messages get a short "we will answer soon" message until tomorrow. Raise LIMIT_REPLIES_PER_DAY if this traffic is real.`,
      2 * DAY_SECONDS,
    );
    return false;
  }

  private async failed(contact: string, conversation: Conversation, error: unknown): Promise<void> {
    const { store, whatsapp, notifier, config } = this.options;
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`Reply to ${contact} failed`, error);

    conversation.history = stripAttachments(conversation.history);

    let told = true;
    try {
      await whatsapp.sendText(contact, config.fallbacks.error);
    } catch (sendError) {
      told = false;
      const reason = sendError instanceof Error ? sendError.message : String(sendError);
      await this.alertOnce(
        'whatsapp',
        'WhatsApp is rejecting messages',
        `The assistant could not send messages on WhatsApp: ${reason}\n\nIf it says the token expired or is invalid, create a new token and update WHATSAPP_TOKEN.`,
      );
    }

    await store.save(contact, conversation);
    if (!(await store.setFlag(`error:${contact}`, 3600))) return;
    await notifier
      .notify({
        reason: 'error',
        contact,
        name: conversation.state.lead?.name ?? conversation.state.name,
        summary: `The assistant could not answer: ${detail.slice(0, 300)}. ${told ? 'The customer was told you will write soon.' : 'The customer did not get any message.'}`,
        lead: conversation.state.lead ?? {},
        transcript: transcript(conversation.history, config.business.name),
        business: config.business.name,
      })
      .catch((notifyError) => console.error('Error notification failed', notifyError));
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
        canBook: async () => !(await store.hasFlag(`bookings:full:${contact}`)),
        onBooked: async () => {
          const week = await store.increment(`bookings:week:${contact}`, 7 * DAY_SECONDS);
          if (week >= this.limits.bookingsPerWeek) await store.setFlag(`bookings:full:${contact}`, 7 * DAY_SECONDS);
        },
      },
    });

    conversation.history = stripAttachments(turn.history);
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
