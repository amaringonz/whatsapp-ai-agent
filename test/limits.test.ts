import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { OpenAIModel } from '../src/agent/openai.js';
import { AgentService, type AgentLimits } from '../src/agent/service.js';
import type { AssistantBlock, LanguageModel, ModelRequest, ModelResponse } from '../src/agent/types.js';
import type { BookingProvider } from '../src/booking/types.js';
import { parseBusinessConfig } from '../src/config/business.js';
import { countPdfPages, MediaReader } from '../src/media/reader.js';
import type { HandoffNotice } from '../src/notify/types.js';
import { createApp } from '../src/routes.js';
import { MemoryStore } from '../src/store/memory.js';
import { MediaTooLargeError } from '../src/whatsapp/client.js';

const config = parseBusinessConfig(JSON.parse(readFileSync('examples/business.example.json', 'utf8')));
const contact = '50688887777';

type Script = (request: ModelRequest) => AssistantBlock[] | Error;

function setup(options: { script?: Script; limits?: Partial<AgentLimits>; blocked?: string[]; booking?: BookingProvider; sendFails?: boolean } = {}) {
  let clock = new Date('2026-12-01T15:00:00Z');
  const store = new MemoryStore(() => clock.getTime());
  const sent: string[] = [];
  const notices: HandoffNotice[] = [];
  const alerts: string[] = [];
  const requests: ModelRequest[] = [];
  const model: LanguageModel = {
    respond: async (request): Promise<ModelResponse> => {
      requests.push(structuredClone(request));
      const result = options.script?.(request) ?? [{ type: 'text', text: 'ok' }];
      if (result instanceof Error) throw result;
      return { content: result, stopReason: result.some((block) => block.type === 'tool_use') ? 'tool_use' : 'end_turn' };
    },
  };
  const agent = new AgentService({
    config,
    store,
    model,
    booking: options.booking,
    whatsapp: {
      markReadAndTyping: async () => undefined,
      sendText: async (_to, body) => {
        if (options.sendFails) throw new Error('WhatsApp API 401: token expired');
        sent.push(body);
      },
    },
    notifier: {
      notify: async (notice) => void notices.push(notice),
      alert: async (subject) => void alerts.push(subject),
    },
    limits: options.limits,
    blockedNumbers: options.blocked,
    debounceMs: 0,
    humanPauseHours: 24,
    historyLimit: 40,
    now: () => clock,
    sleep: async () => undefined,
  });
  let counter = 0;
  const say = (text: string, extra: Record<string, unknown> = {}) =>
    agent.handle({ kind: 'inbound', id: `m${(counter += 1)}`, from: contact, timestamp: 0, text, ...extra });
  const owner = (text: string) => agent.handle({ kind: 'echo', id: `e${(counter += 1)}`, to: contact, timestamp: 0, text });
  return {
    agent,
    store,
    sent,
    notices,
    alerts,
    requests,
    say,
    owner,
    advance: (minutes: number) => (clock = new Date(clock.getTime() + minutes * 60_000)),
    now: () => clock,
  };
}

describe('rate limits', () => {
  it('drops bursts above the per-minute limit', async () => {
    const { say, sent, advance } = setup({ limits: { messagesPerMinute: 2 } });
    await say('uno');
    await say('dos');
    await say('tres');
    expect(sent).toHaveLength(2);
    advance(2);
    await say('cuatro');
    expect(sent).toHaveLength(3);
  });

  it('pauses the chat once the daily limit is passed and tells the owner once', async () => {
    const { say, sent, notices, advance } = setup({ limits: { messagesPerDay: 2 } });
    await say('uno');
    advance(1);
    await say('dos');
    advance(1);
    await say('tres');
    advance(1);
    await say('cuatro');
    expect(sent).toEqual(['ok', 'ok', config.fallbacks.limit]);
    expect(notices.map((notice) => notice.reason)).toEqual(['limit']);
  });

  it('ignores old messages that Meta delivers late', async () => {
    const { say, sent, now } = setup({ limits: { maxMessageAgeMinutes: 60 } });
    await say('viejo', { timestamp: Math.floor(now().getTime() / 1000) - 2 * 3600 });
    await say('nuevo', { timestamp: Math.floor(now().getTime() / 1000) });
    expect(sent).toEqual(['ok']);
  });
});

describe('blocking', () => {
  it('never answers numbers listed in BLOCKED_NUMBERS', async () => {
    const { say, sent } = setup({ blocked: ['+506 8888-7777'] });
    await say('hola');
    expect(sent).toEqual([]);
  });

  it('blocks and unblocks a chat with owner commands without pausing it', async () => {
    const { say, owner, sent, store } = setup();
    await owner('/bloquear');
    await say('hola');
    expect(sent).toEqual([]);
    await owner('/desbloquear');
    await say('hola otra vez');
    expect(sent).toEqual(['ok']);
    expect((await store.load(contact)).history.some((message) => JSON.stringify(message).includes('/bloquear'))).toBe(false);
  });
});

describe('input limits', () => {
  it('cuts very long messages before they reach the model', async () => {
    const { say, requests } = setup({ limits: { maxMessageChars: 20 } });
    await say('a'.repeat(500));
    const last = JSON.stringify(requests[0]?.messages.at(-1));
    expect(last).toContain('a'.repeat(20));
    expect(last).not.toContain('a'.repeat(21));
    expect(last).toContain('cut because it was too long');
  });

  it('stops reading files after the daily media limit', async () => {
    const { say, requests } = setup({ limits: { mediaPerDay: 1, messagesPerMinute: 50 } });
    await say('[fallback 1]', { media: { type: 'image', id: 'I1' } });
    await say('[fallback 2]', { media: { type: 'image', id: 'I2' } });
    expect(JSON.stringify(requests[1]?.messages.at(-1))).toContain('maximum of 1 files');
  });
});

describe('AI budget', () => {
  it('sends a short notice instead of calling the model after the daily limit', async () => {
    const { say, sent, alerts, requests, advance } = setup({ limits: { repliesPerDay: 1 } });
    await say('uno');
    advance(1);
    await say('dos');
    advance(1);
    await say('tres');
    expect(requests).toHaveLength(1);
    expect(sent).toEqual(['ok', config.fallbacks.busy, config.fallbacks.busy]);
    expect(alerts).toEqual(['[Clínica Dental Sonrisa] Daily AI limit reached']);
  });
});

describe('failures', () => {
  it('tells the customer, emails the owner once an hour and keeps the message', async () => {
    const { say, sent, notices, store, advance } = setup({ script: () => new Error('OpenAI 500: overloaded') });
    await say('hola');
    advance(1);
    await say('¿hay alguien?');
    expect(sent).toEqual([config.fallbacks.error, config.fallbacks.error]);
    expect(notices.map((notice) => notice.reason)).toEqual(['error']);
    expect(notices[0]?.summary).toContain('OpenAI 500');
    const saved = await store.load(contact);
    expect(JSON.stringify(saved.history)).toContain('¿hay alguien?');
    expect(saved.state.pausedUntil).toBeUndefined();
  });

  it('alerts the owner when WhatsApp rejects messages', async () => {
    const { say, alerts, notices } = setup({ sendFails: true });
    await say('hola');
    expect(alerts).toEqual(['[Clínica Dental Sonrisa] WhatsApp is rejecting messages']);
    expect(notices[0]?.summary).toContain('did not get any message');
  });
});

describe('booking limit', () => {
  it('refuses to book more than the weekly limit for one contact', async () => {
    let booked = 0;
    const booking: BookingProvider = {
      availability: async () => [],
      book: async () => ({ ok: true, id: `B${(booked += 1)}`, summary: '' }),
    };
    const call: AssistantBlock[] = [
      { type: 'tool_use', id: 't', name: 'book_appointment', input: { name: 'Ana', date: '2026-12-02', time: '09:00', motivo: 'limpieza' } },
    ];
    const results: string[] = [];
    const { say, advance } = setup({
      booking,
      limits: { bookingsPerWeek: 1 },
      script: (request) => {
        const last = request.messages.at(-1);
        if (last && Array.isArray(last.content) && last.content[0]?.type === 'tool_result') {
          results.push(last.content[0].content);
          return [{ type: 'text', text: 'listo' }];
        }
        return call;
      },
    });
    await say('agenda');
    advance(1);
    await say('otra cita');
    expect(booked).toBe(1);
    expect(results[1]).toContain('maximum number of appointments');
  });
});

describe('file limits', () => {
  it('counts PDF pages and refuses long PDFs', async () => {
    const pdf = new TextEncoder().encode('%PDF /Type /Pages /Type /Page /Type /Page /Type /Page');
    expect(countPdfPages(pdf)).toBe(3);
    const reader = new MediaReader({
      downloader: { downloadMedia: async () => ({ data: pdf, mimeType: 'application/pdf' }) },
      maxPdfPages: 2,
    });
    expect(await reader.read([{ text: '[x]', media: { type: 'document', id: 'D', mimeType: 'application/pdf' } }])).toContain(
      'with 3 pages',
    );
  });

  it('caps voice notes by length', async () => {
    let limit = 0;
    const reader = new MediaReader({
      downloader: {
        downloadMedia: async (_id, maxBytes) => {
          limit = maxBytes;
          throw new MediaTooLargeError(maxBytes + 1);
        },
      },
      transcriber: { transcribe: async () => 'hola' },
      maxAudioSeconds: 60,
    });
    expect(await reader.read([{ text: '[x]', media: { type: 'audio', id: 'A' } }])).toContain('too long');
    expect(limit).toBe(240_000);
  });
});

describe('webhook size', () => {
  it('rejects oversized payloads before checking anything else', async () => {
    const app = createApp({
      verifyToken: 'v',
      appSecret: 's',
      agent: async () => {
        throw new Error('should not run');
      },
      runInBackground: () => undefined,
    });
    const response = await app.request('/webhook', { method: 'POST', body: 'x'.repeat(600 * 1024) });
    expect(response.status).toBe(413);
  });
});

describe('OpenAI retries', () => {
  it('retries server errors and rate limits but not bad requests', async () => {
    const statuses = [500, 429, 200];
    let calls = 0;
    const fakeFetch = (async () => {
      const status = statuses[calls] ?? 200;
      calls += 1;
      return status === 200
        ? new Response(JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'hola' }] }] }))
        : new Response('busy', { status });
    }) as typeof fetch;
    const model = new OpenAIModel({ apiKey: 'K', model: 'm', fetch: fakeFetch, retryDelayMs: 1 });
    expect((await model.respond({ system: 's', messages: [], tools: [] })).content).toEqual([{ type: 'text', text: 'hola' }]);
    expect(calls).toBe(3);

    let badCalls = 0;
    const badFetch = (async () => {
      badCalls += 1;
      return new Response('bad', { status: 400 });
    }) as typeof fetch;
    const bad = new OpenAIModel({ apiKey: 'K', model: 'm', fetch: badFetch, retryDelayMs: 1 });
    await expect(bad.respond({ system: 's', messages: [], tools: [] })).rejects.toThrow('OpenAI 400');
    expect(badCalls).toBe(1);
  });
});
