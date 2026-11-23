import type { ChatMessage } from '../agent/types.js';

export interface ConversationState {
  name?: string;
  pausedUntil?: number;
  pauseReason?: 'handoff' | 'human_reply';
  lead?: Record<string, string>;
  lastHandoff?: string;
}

export interface Conversation {
  history: ChatMessage[];
  state: ConversationState;
}

export interface ConversationStore {
  claimEvent(id: string): Promise<boolean>;
  queueMessage(contact: string, messageId: string, text: string): Promise<void>;
  latestMessageId(contact: string): Promise<string | null>;
  takeQueued(contact: string): Promise<string[]>;
  lock(contact: string, seconds: number): Promise<boolean>;
  unlock(contact: string): Promise<void>;
  load(contact: string): Promise<Conversation>;
  save(contact: string, conversation: Conversation): Promise<void>;
}

export const emptyConversation = (): Conversation => ({ history: [], state: {} });
