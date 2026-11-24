import { z } from 'zod';

const optional = z
  .string()
  .optional()
  .transform((value) => (value?.trim() ? value.trim() : undefined));

const envSchema = z.object({
  WHATSAPP_TOKEN: z.string().min(1),
  WHATSAPP_PHONE_NUMBER_ID: z.string().min(1),
  WHATSAPP_APP_SECRET: z.string().min(1),
  WHATSAPP_VERIFY_TOKEN: z.string().min(1),
  GRAPH_API_VERSION: z.string().default('v26.0'),

  AI_PROVIDER: z.enum(['anthropic', 'openai']).optional().catch(undefined),
  ANTHROPIC_API_KEY: optional,
  ANTHROPIC_MODEL: z.string().default('claude-sonnet-5-5'),
  OPENAI_API_KEY: optional,
  OPENAI_MODEL: z.string().default('gpt-6.2-sol'),
  OPENAI_BASE_URL: z.string().default('https://api.openai.com/v1'),

  UPSTASH_REDIS_REST_URL: optional,
  UPSTASH_REDIS_REST_TOKEN: optional,
  KV_REST_API_URL: optional,
  KV_REST_API_TOKEN: optional,

  BUSINESS_CONFIG: optional,
  BUSINESS_CONFIG_PATH: optional,

  BOOKING_API_URL: optional,
  BOOKING_API_TOKEN: optional,

  TRANSCRIPTION_API_KEY: optional,
  TRANSCRIPTION_BASE_URL: z.string().default('https://api.openai.com/v1'),
  TRANSCRIPTION_MODEL: z.string().default('gpt-4o-mini-transcribe'),

  RESEND_API_KEY: optional,
  NOTIFY_EMAIL_FROM: optional,
  NOTIFY_EMAIL_TO: optional,

  CRON_SECRET: optional,
  FOLLOW_UP_HOURS: z.coerce.number().min(0).default(4),
  FOLLOW_UP_START_HOUR: z.coerce.number().int().min(0).max(23).default(8),
  FOLLOW_UP_END_HOUR: z.coerce.number().int().min(1).max(24).default(20),

  WHATSAPP_BUSINESS_ACCOUNT_ID: optional,
  META_DATASET_ID: optional,
  META_EVENTS_TOKEN: optional,

  BLOCKED_NUMBERS: optional,
  LIMIT_MESSAGES_PER_MINUTE: z.coerce.number().int().positive().default(10),
  LIMIT_MESSAGES_PER_DAY: z.coerce.number().int().positive().default(60),
  LIMIT_MEDIA_PER_DAY: z.coerce.number().int().min(0).default(8),
  LIMIT_BOOKINGS_PER_WEEK: z.coerce.number().int().min(0).default(2),
  LIMIT_REPLIES_PER_DAY: z.coerce.number().int().positive().default(1500),
  MAX_MESSAGE_CHARS: z.coerce.number().int().positive().default(1500),
  MAX_TURN_CHARS: z.coerce.number().int().positive().default(4000),
  MAX_MESSAGE_AGE_MINUTES: z.coerce.number().int().positive().default(360),
  MAX_PDF_PAGES: z.coerce.number().int().positive().default(20),
  MAX_AUDIO_SECONDS: z.coerce.number().int().positive().default(300),

  DEBOUNCE_MS: z.coerce.number().int().min(0).default(4000),
  HUMAN_PAUSE_HOURS: z.coerce.number().positive().default(24),
  HISTORY_LIMIT: z.coerce.number().int().min(6).default(40),
});

const resolvedSchema = envSchema
  .transform((env) => {
    const provider = env.AI_PROVIDER ?? (env.ANTHROPIC_API_KEY || !env.OPENAI_API_KEY ? 'anthropic' : 'openai');
    const usesOpenAITranscription = env.TRANSCRIPTION_BASE_URL.replace(/\/$/, '') === 'https://api.openai.com/v1';
    return {
      ...env,
      AI_PROVIDER: provider,
      TRANSCRIPTION_API_KEY: env.TRANSCRIPTION_API_KEY ?? (usesOpenAITranscription ? env.OPENAI_API_KEY : undefined),
    };
  })
  .superRefine((env, context) => {
    const key = env.AI_PROVIDER === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY';
    if (!env[key]) context.addIssue({ code: 'custom', path: [key], message: `Required when AI_PROVIDER is ${env.AI_PROVIDER}` });
  });

export type Env = z.infer<typeof resolvedSchema>;

export function readEnv(source: Record<string, string | undefined> = process.env): Env {
  const result = resolvedSchema.safeParse(source);
  if (!result.success) {
    throw new Error(`Invalid environment:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
