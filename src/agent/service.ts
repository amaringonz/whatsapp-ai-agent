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
import { forModel, stripAttachments, type MediaReader } from '../media/reader.js';
import type { QueuedMessage } from '../store/types.js';
import type { ConversionSender } from '../conversions/messaging.js';
import type { BookingOrigin } from '../booking/types.js';

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
export const FOLLOW_UPS = 'follow-ups';
export const SKIP_FOLLOW_UP = 'SKIP';

export interface FollowUpSettings {
  afterHours: number;
  startHour: number;
  endHour: number;
  windowHours: number;
}

const followUpNote = `[Internal note, not written by the customer: the customer has not answered for a few hours. Write ONE short, friendly follow-up message in their language that picks up exactly where the conversation stopped and makes it easy to answer, for example by offering two times or asking one simple question. Do not repeat what you already said, do not pressure and do not say this message is automatic. If no follow-up makes sense (they said goodbye, are not interested or asked you to stop), reply with exactly ${SKIP_FOLLOW_UP}.]`;
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
  followUp?: FollowUpSettings;
  mediaMemoryTurns?: number;
  conversions?: ConversionSender;
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
    const conversation = await this.options.store.load(event.from);
    if (!this.paused(conversation) || this.covering(conversation)) {
      await this.options.whatsapp.markReadAndTyping(event.id).catch((error) => console.warn('Typing indicator failed', error));
    }

    if (event.name || event.ad) {
      let changed = false;
      if (event.name && conversation.state.name !== event.name) {
        conversation.state.name = event.name;
        changed = true;
      }
      if (event.ad) {
        conversation.state.ad = { ...event.ad, at: this.now().getTime() };
        changed = true;
      }
      if (changed) await this.options.store.save(event.from, conversation);
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

  async inspect(contact: string): Promise<Conversation & { blocked: boolean; paused: boolean }> {
    const conversation = await this.options.store.load(contact);
    return {
      state: conversation.state,
      history: stripAttachments(conversation.history),
      blocked: await this.isBlocked(contact),
      paused: this.paused(conversation),
    };
  }

  async resume(contact: string): Promise<void> {
    const conversation = await this.options.store.load(contact);
    conversation.state.pausedUntil = undefined;
    conversation.state.pauseReason = undefined;
    await this.options.store.save(contact, conversation);
    await this.options.store.clearFlag(`error:${contact}`);
  }

  async reset(contact: string): Promise<void> {
    await this.options.store.save(contact, { history: [], state: {} });
    await this.options.store.unschedule(FOLLOW_UPS, contact);
    await this.options.store.clearFlag(`bookings:full:${contact}`);
  }

  ownerAway(at = this.now().getTime()): boolean {
    const hours = this.options.config.handoff.ownerHours;
    if (!hours) return false;
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: this.options.config.business.timezone,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(at));
    const read = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
    const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(read('weekday'));
    const time = `${read('hour').padStart(2, '0')}:${read('minute').padStart(2, '0')}`;
    return !hours.days.includes(day) || time < hours.start || time >= hours.end;
  }

  private covering(conversation: Conversation): boolean {
    const { state } = conversation;
    return this.paused(conversation) && state.pauseReason === 'handoff' && state.lastHandoff !== 'limit' && this.ownerAway();
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
        conversation.state.lastCustomerAt = this.now().getTime();
        conversation.state.followUpsSent = 0;
        await store.unschedule(FOLLOW_UPS, contact);
        const covering = this.covering(conversation);
        if (this.paused(conversation) && !covering) {
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
          await this.reply(contact, conversation, covering);
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

  private async withMedia(history: ChatMessage[]): Promise<ChatMessage[]> {
    const turns = this.options.mediaMemoryTurns ?? 5;
    return this.options.media && turns > 0 ? this.options.media.hydrate(history, turns) : history;
  }

  private origin(conversation: Conversation): BookingOrigin | undefined {
    const ad = conversation.state.ad;
    if (!ad) return undefined;
    return {
      source: 'facebook',
      medium: 'whatsapp-ad',
      ...(ad.headline ? { campaign: ad.headline } : {}),
      ...(ad.id ? { content: ad.id } : {}),
      ...(ad.clickId ? { clickId: ad.clickId } : {}),
    };
  }

  private localTime(at: number): { hour: number; minute: number } {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: this.options.config.business.timezone,
      hour: 'numeric',
      minute: 'numeric',
      hourCycle: 'h23',
    }).formatToParts(new Date(at));
    const read = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
    return { hour: read('hour'), minute: read('minute') };
  }

  nextSendTime(at: number): number {
    const settings = this.options.followUp;
    if (!settings) return at;
    const { hour, minute } = this.localTime(at);
    if (hour >= settings.startHour && hour < settings.endHour) return at;
    const hoursAhead = hour < settings.startHour ? settings.startHour - hour : 24 - hour + settings.startHour;
    return at + hoursAhead * 3_600_000 - minute * 60_000;
  }

  async runFollowUps(limit = 25): Promise<number> {
    const { store } = this.options;
    if (!this.options.followUp) return 0;
    const now = this.now().getTime();
    let sent = 0;
    for (const contact of await store.due(FOLLOW_UPS, now, limit)) {
      if (!(await store.unschedule(FOLLOW_UPS, contact))) continue;
      if (!(await store.lock(contact, 120))) {
        await store.schedule(FOLLOW_UPS, contact, now + 10 * 60_000);
        continue;
      }
      try {
        if (await this.followUp(contact)) sent += 1;
      } catch (error) {
        console.error(`Follow-up to ${contact} failed`, error);
      } finally {
        await store.unlock(contact);
      }
    }
    return sent;
  }

  private async followUp(contact: string): Promise<boolean> {
    const { store, model, whatsapp, config, historyLimit } = this.options;
    const settings = this.options.followUp!;
    const conversation = await store.load(contact);
    const { state } = conversation;
    if (this.paused(conversation) || state.booked || (state.followUpsSent ?? 0) >= 1 || !state.lastCustomerAt) return false;
    if (conversation.history.at(-1)?.role !== 'assistant' || (await this.isBlocked(contact))) return false;

    const now = this.now().getTime();
    const deadline = state.lastCustomerAt + settings.windowHours * 3_600_000;
    if (now >= deadline) return false;
    const next = this.nextSendTime(now);
    if (next > now) {
      if (next < deadline) await store.schedule(FOLLOW_UPS, contact, next);
      return false;
    }
    if (!(await this.withinBudget())) return false;

    const messages = normalizeHistory(trimHistory(conversation.history, historyLimit));
    messages.push({ role: 'user', content: followUpNote });
    const prepared = await this.withMedia(messages);
    const response = await model.respond({
      system: buildSystemPrompt(config, { now: this.now(), contactName: state.name, lead: state.lead }),
      messages: forModel(prepared),
      tools: [],
    });
    const text = response.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text.trim())
      .join('\n')
      .trim();
    const message = splitReply(text)[0];
    if (!message || message.toUpperCase().startsWith(SKIP_FOLLOW_UP)) return false;

    await whatsapp.sendText(contact, message);
    conversation.history.push({ role: 'assistant', content: message });
    state.followUpsSent = (state.followUpsSent ?? 0) + 1;
    await store.save(contact, conversation);
    return true;
  }

  private async reply(contact: string, conversation: Conversation, covering = false): Promise<void> {
    const { config, model, booking, whatsapp, notifier, store, historyLimit, humanPauseHours } = this.options;
    const history = await this.withMedia(normalizeHistory(trimHistory(conversation.history, historyLimit)));
    let handoff: HandoffRequest | undefined;

    const turn = await runAgent({
      model,
      system: buildSystemPrompt(config, {
        now: this.now(),
        contactName: conversation.state.name,
        lead: conversation.state.lead,
        ...(covering
          ? { covering: { reason: conversation.state.lastHandoff, summary: conversation.state.handoffSummary } }
          : {}),
      }),
      history,
      tools: toolSpecs(config, Boolean(booking)).filter((tool) => !covering || tool.name !== 'hand_off'),
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
        origin: this.origin(conversation),
        canBook: async () => !(await store.hasFlag(`bookings:full:${contact}`)),
        onBooked: async () => {
          conversation.state.booked = true;
          const week = await store.increment(`bookings:week:${contact}`, 7 * DAY_SECONDS);
          if (week >= this.limits.bookingsPerWeek) await store.setFlag(`bookings:full:${contact}`, 7 * DAY_SECONDS);
          const clickId = conversation.state.ad?.clickId;
          if (clickId && this.options.conversions) {
            await this.options.conversions
              .send({ name: 'LeadSubmitted', clickId, time: this.now() })
              .catch((error) => console.error('WhatsApp conversion failed', error));
          }
        },
      },
    });

    conversation.history = stripAttachments(turn.history);
    for (const message of splitReply(turn.reply)) {
      await whatsapp.sendText(contact, message);
    }

    if (this.options.followUp && !handoff && !covering && !conversation.state.booked) {
      await store.schedule(FOLLOW_UPS, contact, this.now().getTime() + this.options.followUp.afterHours * 3_600_000);
    }

    if (handoff) {
      conversation.state.pausedUntil = this.now().getTime() + humanPauseHours * 3_600_000;
      conversation.state.pauseReason = 'handoff';
      conversation.state.lastHandoff = handoff.reason;
      conversation.state.handoffSummary = handoff.summary.slice(0, 600);
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
