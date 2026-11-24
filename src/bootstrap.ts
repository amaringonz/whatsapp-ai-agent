import { AnthropicModel } from './agent/anthropic.js';
import { OpenAIModel } from './agent/openai.js';
import { AgentService } from './agent/service.js';
import { HttpBookingProvider } from './booking/http.js';
import { loadBusinessConfig } from './config/business.js';
import type { Env } from './config/env.js';
import { ConsoleNotifier, ResendNotifier } from './notify/resend.js';
import { MemoryStore } from './store/memory.js';
import { RedisStore } from './store/redis.js';
import { MediaReader } from './media/reader.js';
import { OpenAICompatibleTranscriber } from './media/transcriber.js';
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

  const whatsapp = new WhatsAppClient({
    token: env.WHATSAPP_TOKEN,
    phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID,
    version: env.GRAPH_API_VERSION,
  });

  const transcriber = env.TRANSCRIPTION_API_KEY
    ? new OpenAICompatibleTranscriber({
        apiKey: env.TRANSCRIPTION_API_KEY,
        baseUrl: env.TRANSCRIPTION_BASE_URL,
        model: env.TRANSCRIPTION_MODEL,
      })
    : undefined;

  return new AgentService({
    config,
    store,
    notifier,
    booking,
    model:
      env.AI_PROVIDER === 'openai'
        ? new OpenAIModel({ apiKey: env.OPENAI_API_KEY!, model: env.OPENAI_MODEL, baseUrl: env.OPENAI_BASE_URL })
        : new AnthropicModel(env.ANTHROPIC_API_KEY!, env.ANTHROPIC_MODEL),
    whatsapp,
    media: new MediaReader({
      downloader: whatsapp,
      transcriber,
      language: config.business.language,
      maxPdfPages: env.MAX_PDF_PAGES,
      maxAudioSeconds: env.MAX_AUDIO_SECONDS,
    }),
    blockedNumbers: env.BLOCKED_NUMBERS?.split(',') ?? [],
    limits: {
      messagesPerMinute: env.LIMIT_MESSAGES_PER_MINUTE,
      messagesPerDay: env.LIMIT_MESSAGES_PER_DAY,
      mediaPerDay: env.LIMIT_MEDIA_PER_DAY,
      bookingsPerWeek: env.LIMIT_BOOKINGS_PER_WEEK,
      repliesPerDay: env.LIMIT_REPLIES_PER_DAY,
      maxMessageChars: env.MAX_MESSAGE_CHARS,
      maxTurnChars: env.MAX_TURN_CHARS,
      maxMessageAgeMinutes: env.MAX_MESSAGE_AGE_MINUTES,
    },
    debounceMs: env.DEBOUNCE_MS,
    humanPauseHours: env.HUMAN_PAUSE_HOURS,
    historyLimit: env.HISTORY_LIMIT,
  });
}
