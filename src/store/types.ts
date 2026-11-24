import type { ChatMessage } from '../agent/types.js';
import type { AdReferral, MediaRef } from '../whatsapp/webhook.js';

export interface QueuedMessage {
  text: string;
  media?: MediaRef;
}

export function toQueuedMessage(value: unknown): QueuedMessage {
  if (typeof value === 'string') {
    if (value.startsWith('{')) {
      try {
        return toQueuedMessage(JSON.parse(value));
      } catch {
        return { text: value };
      }
    }
    return { text: value };
  }
  const item = value as Partial<QueuedMessage> | null;
  return { text: typeof item?.text === 'string' ? item.text : '', ...(item?.media ? { media: item.media } : {}) };
}

export interface ConversationState {
  name?: string;
  pausedUntil?: number;
  pauseReason?: 'handoff' | 'human_reply';
  lead?: Record<string, string>;
  lastHandoff?: string;
  lastCustomerAt?: number;
  followUpsSent?: number;
  booked?: boolean;
  ad?: AdReferral & { at: number };
}

export interface Conversation {
  history: ChatMessage[];
  state: ConversationState;
}

export interface ConversationStore {
  claimEvent(id: string): Promise<boolean>;
  queueMessage(contact: string, messageId: string, message: QueuedMessage): Promise<void>;
  latestMessageId(contact: string): Promise<string | null>;
  takeQueued(contact: string): Promise<QueuedMessage[]>;
  lock(contact: string, seconds: number): Promise<boolean>;
  unlock(contact: string): Promise<void>;
  increment(key: string, ttlSeconds: number): Promise<number>;
  setFlag(key: string, ttlSeconds?: number): Promise<boolean>;
  hasFlag(key: string): Promise<boolean>;
  clearFlag(key: string): Promise<void>;
  schedule(set: string, member: string, at: number): Promise<void>;
  unschedule(set: string, member: string): Promise<boolean>;
  due(set: string, until: number, limit: number): Promise<string[]>;
  load(contact: string): Promise<Conversation>;
  save(contact: string, conversation: Conversation): Promise<void>;
}

export const emptyConversation = (): Conversation => ({ history: [], state: {} });
