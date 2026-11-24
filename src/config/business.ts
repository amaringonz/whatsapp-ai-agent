import { readFile } from 'node:fs/promises';
import { z } from 'zod';

const option = z.object({
  value: z.string().min(1),
  label: z.string().min(1),
});

const bookingField = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]*$/, 'Use snake_case field names'),
  description: z.string().min(1),
  required: z.boolean().default(true),
  options: z.array(option).optional(),
});

export const businessConfigSchema = z.object({
  business: z.object({
    name: z.string().min(1),
    description: z.string().min(1),
    website: z.string().url().optional(),
    location: z.string().optional(),
    hours: z.string().optional(),
    language: z.string().default('es'),
    timezone: z.string().default('UTC'),
  }),
  assistant: z.object({
    name: z.string().min(1),
    owner: z.string().min(1),
    tone: z.string().min(1),
    disclosure: z
      .string()
      .default('If someone asks whether they are talking to a person, say honestly that you are an assistant.'),
  }),
  knowledge: z
    .array(
      z.object({
        title: z.string().min(1),
        content: z.string().min(1),
      }),
    )
    .default([]),
  rules: z.array(z.string().min(1)).default([]),
  goal: z.string().min(1),
  handoff: z.object({
    completed: z.string().min(1),
    urgent: z.array(z.string().min(1)).min(1),
  }),
  fallbacks: z
    .object({
      error: z.string().min(1).default('Sorry, I had a problem answering. A person from the team will write to you here shortly.'),
      busy: z.string().min(1).default('Thanks for writing! We are receiving many messages right now. A person from the team will answer you here shortly.'),
      limit: z.string().min(1).default('Thanks for your messages! A person from the team will continue this conversation here.'),
    })
    .prefault({}),
  booking: z
    .object({
      enabled: z.boolean().default(true),
      description: z.string().min(1),
      fields: z.array(bookingField).default([]),
    })
    .optional(),
});

export type BusinessConfig = z.infer<typeof businessConfigSchema>;
export type BookingField = z.infer<typeof bookingField>;

export function parseBusinessConfig(input: unknown): BusinessConfig {
  const result = businessConfigSchema.safeParse(input);
  if (!result.success) {
    throw new Error(`Invalid business config:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

export async function loadBusinessConfig(options: { json?: string; path?: string }): Promise<BusinessConfig> {
  if (options.json) return parseBusinessConfig(JSON.parse(options.json));
  if (options.path) return parseBusinessConfig(JSON.parse(await readFile(options.path, 'utf8')));
  throw new Error('Set BUSINESS_CONFIG (JSON) or BUSINESS_CONFIG_PATH (file) to describe the business.');
}
