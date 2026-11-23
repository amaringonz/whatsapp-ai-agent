import { Redis } from '@upstash/redis';
import { emptyConversation, type Conversation, type ConversationStore } from './types.js';

const DAY = 86_400;

export class RedisStore implements ConversationStore {
  private readonly redis: Redis;

  constructor(
    options: { url: string; token: string },
    private readonly prefix = 'wa-agent',
    private readonly keepDays = 30,
  ) {
    this.redis = new Redis({ url: options.url, token: options.token });
  }

  private key(...parts: string[]): string {
    return [this.prefix, ...parts].join(':');
  }

  async claimEvent(id: string): Promise<boolean> {
    return (await this.redis.set(this.key('event', id), 1, { nx: true, ex: 2 * DAY })) === 'OK';
  }

  async queueMessage(contact: string, messageId: string, text: string): Promise<void> {
    await this.redis
      .multi()
      .rpush(this.key('queue', contact), text)
      .expire(this.key('queue', contact), DAY)
      .set(this.key('latest', contact), messageId, { ex: DAY })
      .exec();
  }

  async latestMessageId(contact: string): Promise<string | null> {
    return this.redis.get<string>(this.key('latest', contact));
  }

  async takeQueued(contact: string): Promise<string[]> {
    const [queued] = await this.redis
      .multi()
      .lrange<string>(this.key('queue', contact), 0, -1)
      .del(this.key('queue', contact))
      .exec<[string[], number]>();
    return queued ?? [];
  }

  async lock(contact: string, seconds: number): Promise<boolean> {
    return (await this.redis.set(this.key('lock', contact), 1, { nx: true, ex: seconds })) === 'OK';
  }

  async unlock(contact: string): Promise<void> {
    await this.redis.del(this.key('lock', contact));
  }

  async load(contact: string): Promise<Conversation> {
    return (await this.redis.get<Conversation>(this.key('conversation', contact))) ?? emptyConversation();
  }

  async save(contact: string, conversation: Conversation): Promise<void> {
    await this.redis.set(this.key('conversation', contact), conversation, { ex: this.keepDays * DAY });
  }
}
