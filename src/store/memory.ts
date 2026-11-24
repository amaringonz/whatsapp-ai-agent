import { emptyConversation, type Conversation, type ConversationStore, type QueuedMessage } from './types.js';

export class MemoryStore implements ConversationStore {
  private readonly events = new Set<string>();
  private readonly queues = new Map<string, QueuedMessage[]>();
  private readonly latest = new Map<string, string>();
  private readonly locks = new Set<string>();
  private readonly conversations = new Map<string, string>();

  async claimEvent(id: string): Promise<boolean> {
    if (this.events.has(id)) return false;
    this.events.add(id);
    return true;
  }

  async queueMessage(contact: string, messageId: string, message: QueuedMessage): Promise<void> {
    this.queues.set(contact, [...(this.queues.get(contact) ?? []), structuredClone(message)]);
    this.latest.set(contact, messageId);
  }

  async latestMessageId(contact: string): Promise<string | null> {
    return this.latest.get(contact) ?? null;
  }

  async takeQueued(contact: string): Promise<QueuedMessage[]> {
    const queued = this.queues.get(contact) ?? [];
    this.queues.delete(contact);
    return queued;
  }

  async lock(contact: string): Promise<boolean> {
    if (this.locks.has(contact)) return false;
    this.locks.add(contact);
    return true;
  }

  async unlock(contact: string): Promise<void> {
    this.locks.delete(contact);
  }

  async load(contact: string): Promise<Conversation> {
    const saved = this.conversations.get(contact);
    return saved ? (JSON.parse(saved) as Conversation) : emptyConversation();
  }

  async save(contact: string, conversation: Conversation): Promise<void> {
    this.conversations.set(contact, JSON.stringify(conversation));
  }
}
