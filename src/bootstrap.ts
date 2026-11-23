import { AnthropicModel } from './agent/anthropic.js';
import { AgentService } from './agent/service.js';
import { HttpBookingProvider } from './booking/http.js';
import { loadBusinessConfig } from './config/business.js';
import type { Env } from './config/env.js';
import { ConsoleNotifier, ResendNotifier } from './notify/resend.js';
import { MemoryStore } from './store/memory.js';
import { RedisStore } from './store/redis.js';
import { WhatsAppClient } from './whatsapp/client.js';

export async function createAgent(env: Env): Promise<AgentService> {
  const config = await loadBusinessConfig({ json: env.BUSINESS_CONFIG, path: env.BUSINESS_CONFIG_PATH });

  const redisUrl = env.UPSTASH_REDIS_REST_URL ?? env.KV_REST_API_URL;
  const redisToken = env.UPSTASH_REDIS_REST_TOKEN ?? env.KV_REST_API_TOKEN;
  const store = redisUrl && redisToken ? new RedisStore({ url: redisUrl, token: redisToken }) : new MemoryStore();
  if (store instanceof MemoryStore) console.warn('No Redis configured: conversations live in memory only.');

  const notifier =
    env.RESEND_API_KEY && env.NOTIFY_EMAIL_FROM && env.NOTIFY_EMAIL_TO
      ? new ResendNotifier(env.RESEND_API_KEY, env.NOTIFY_EMAIL_FROM, env.NOTIFY_EMAIL_TO)
      : new ConsoleNotifier();

  const booking =
    env.BOOKING_API_URL && env.BOOKING_API_TOKEN
      ? new HttpBookingProvider({ baseUrl: env.BOOKING_API_URL, token: env.BOOKING_API_TOKEN })
      : undefined;

  return new AgentService({
    config,
    store,
    notifier,
    booking,
    model: new AnthropicModel(env.ANTHROPIC_API_KEY, env.ANTHROPIC_MODEL),
    whatsapp: new WhatsAppClient({
      token: env.WHATSAPP_TOKEN,
      phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID,
      version: env.GRAPH_API_VERSION,
    }),
    debounceMs: env.DEBOUNCE_MS,
    humanPauseHours: env.HUMAN_PAUSE_HOURS,
    historyLimit: env.HISTORY_LIMIT,
  });
}
