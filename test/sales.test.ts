import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AgentService, FOLLOW_UPS } from '../src/agent/service.js';
import type { AssistantBlock, LanguageModel, ModelRequest, ModelResponse } from '../src/agent/types.js';
import type { BookingProvider, BookingRequest } from '../src/booking/types.js';
import { parseBusinessConfig } from '../src/config/business.js';
import { MessagingConversions, type MessagingEvent } from '../src/conversions/messaging.js';
import { createApp } from '../src/routes.js';
import { MemoryStore } from '../src/store/memory.js';
import { parseWebhook } from '../src/whatsapp/webhook.js';

const config = parseBusinessConfig(JSON.parse(readFileSync('examples/business.example.json', 'utf8')));
const contact = '50688887777';
const ad = { id: '120000000000000000', type: 'ad', headline: 'Limpieza dental', clickId: 'CLICK-1' };

function setup(options: { reply?: (request: ModelRequest) => AssistantBlock[]; booking?: BookingProvider; start?: string } = {}) {
  let clock = new Date(options.start ?? '2026-12-01T15:00:00Z');
  const store = new MemoryStore(() => clock.getTime());
  const sent: string[] = [];
  const events: MessagingEvent[] = [];
  const requests: ModelRequest[] = [];
  const model: LanguageModel = {
    respond: async (request): Promise<ModelResponse> => {
      requests.push(structuredClone(request));
      const content = options.reply?.(request) ?? [{ type: 'text', text: 'ok' }];
      return { content, stopReason: content.some((block) => block.type === 'tool_use') ? 'tool_use' : 'end_turn' };
    },
  };
  const agent = new AgentService({
    config,
    store,
    model,
    booking: options.booking,
    whatsapp: { markReadAndTyping: async () => undefined, sendText: async (_to, body) => void sent.push(body) },
    notifier: { notify: async () => undefined },
    conversions: { send: async (event) => void events.push(event) },
    followUp: { afterHours: 4, startHour: 8, endHour: 20, windowHours: 23 },
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
  return { agent, store, sent, events, requests, say, owner, advance: (hours: number) => (clock = new Date(clock.getTime() + hours * 3_600_000)), now: () => clock };
}

const followUpReply = (text: string) => (request: ModelRequest): AssistantBlock[] => {
  const last = request.messages.at(-1);
  const isFollowUp = typeof last?.content === 'string' && last.content.startsWith('[Internal note');
  return [{ type: 'text', text: isFollowUp ? text : 'ok' }];
};

describe('ad referrals', () => {
  it('reads the ad id and click id from a Click-to-WhatsApp message', () => {
    const [event] = parseWebhook({
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                messages: [
                  {
                    id: 'w1',
                    from: '506',
                    type: 'text',
                    text: { body: 'Hola' },
                    referral: { source_id: ad.id, source_type: 'ad', headline: ad.headline, ctwa_clid: ad.clickId, source_url: 'https://fb.me/x' },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    expect(event).toMatchObject({ ad: { id: ad.id, type: 'ad', headline: ad.headline, clickId: ad.clickId, url: 'https://fb.me/x' } });
  });

  it('sends the ad with the booking and reports the lead to Meta', async () => {
    const requestsSeen: BookingRequest[] = [];
    const booking: BookingProvider = {
      availability: async () => [],
      book: async (request) => {
        requestsSeen.push(request);
        return { ok: true, id: 'B1', summary: '' };
      },
    };
    let step = 0;
    const { say, events, store } = setup({
      booking,
      reply: () =>
        (step += 1) === 1
          ? [{ type: 'tool_use', id: 't', name: 'book_appointment', input: { name: 'Ana', date: '2026-12-02', time: '09:00', reason: 'limpieza', patient_type: 'new' } }]
          : [{ type: 'text', text: 'Listo' }],
    });
    await say('Quiero una cita', { ad });
    expect(requestsSeen[0]?.origin).toEqual({ source: 'facebook', medium: 'whatsapp-ad', campaign: ad.headline, content: ad.id, clickId: ad.clickId });
    expect(events).toEqual([{ name: 'LeadSubmitted', clickId: 'CLICK-1', time: expect.any(Date) }]);
    expect((await store.load(contact)).state.booked).toBe(true);
    expect(await store.due(FOLLOW_UPS, Number.MAX_SAFE_INTEGER, 10)).toEqual([]);
  });

  it('does not report anything for chats that did not come from an ad', async () => {
    const booking: BookingProvider = { availability: async () => [], book: async () => ({ ok: true, id: 'B', summary: '' }) };
    let step = 0;
    const { say, events } = setup({
      booking,
      reply: () =>
        (step += 1) === 1
          ? [{ type: 'tool_use', id: 't', name: 'book_appointment', input: { name: 'Ana', date: 'd', time: 't', reason: 'r', patient_type: 'new' } }]
          : [{ type: 'text', text: 'Listo' }],
    });
    await say('Quiero una cita');
    expect(events).toEqual([]);
  });
});

describe('follow-ups', () => {
  it('writes once after a few hours of silence', async () => {
    const { agent, say, sent, advance, store } = setup({ reply: followUpReply('¿Te sirve el jueves a las 10?') });
    await say('Hola, quiero información');
    advance(3);
    expect(await agent.runFollowUps()).toBe(0);
    advance(1.5);
    expect(await agent.runFollowUps()).toBe(1);
    expect(sent).toEqual(['ok', '¿Te sirve el jueves a las 10?']);
    advance(5);
    expect(await agent.runFollowUps()).toBe(0);
    expect((await store.load(contact)).state.followUpsSent).toBe(1);
  });

  it('cancels the follow-up when the customer answers', async () => {
    const { agent, say, sent, advance } = setup({ reply: followUpReply('seguimiento') });
    await say('Hola');
    advance(2);
    await say('Sigo aquí');
    advance(3);
    expect(await agent.runFollowUps()).toBe(0);
    advance(2);
    expect(await agent.runFollowUps()).toBe(1);
    expect(sent).toEqual(['ok', 'ok', 'seguimiento']);
  });

  it('stays quiet after the owner takes over', async () => {
    const { agent, say, owner, sent, advance } = setup({ reply: followUpReply('seguimiento') });
    await say('Hola');
    await owner('Hola, soy el doctor');
    advance(5);
    expect(await agent.runFollowUps()).toBe(0);
    expect(sent).toEqual(['ok']);
  });

  it('waits for business hours and drops it once the 24 hour window would close', async () => {
    const late = setup({ reply: followUpReply('buenos días'), start: '2026-12-02T01:00:00Z' });
    await late.say('Hola');
    late.advance(4.5);
    expect(await late.agent.runFollowUps()).toBe(0);
    expect(await late.store.due(FOLLOW_UPS, Number.MAX_SAFE_INTEGER, 10)).toEqual([contact]);
    late.advance(4);
    expect(await late.agent.runFollowUps()).toBe(0);
    late.advance(4.6);
    expect(await late.agent.runFollowUps()).toBe(1);
    expect(late.sent).toEqual(['ok', 'buenos días']);

    const expired = setup({ reply: followUpReply('tarde') });
    await expired.say('Hola');
    expired.advance(24);
    expect(await expired.agent.runFollowUps()).toBe(0);
    expect(expired.sent).toEqual(['ok']);
  });

  it('skips when the model says a follow-up does not fit', async () => {
    const { agent, say, sent, advance } = setup({ reply: followUpReply('SKIP') });
    await say('Gracias, no me interesa');
    advance(5);
    expect(await agent.runFollowUps()).toBe(0);
    expect(sent).toEqual(['ok']);
  });

  it('computes the next send time in the business time zone', () => {
    const { agent } = setup();
    const at = new Date('2026-12-02T03:30:00Z').getTime();
    expect(new Date(agent.nextSendTime(at)).toISOString()).toBe('2026-12-02T14:00:00.000Z');
    const inside = new Date('2026-12-01T18:00:00Z').getTime();
    expect(agent.nextSendTime(inside)).toBe(inside);
  });
});

describe('cron route', () => {
  const app = (cronSecret?: string) =>
    createApp({
      verifyToken: 'v',
      appSecret: 's',
      cronSecret,
      agent: async () => ({ runFollowUps: async () => 2 }) as unknown as AgentService,
      runInBackground: () => undefined,
    });

  it('needs the cron secret', async () => {
    expect((await app().request('/cron/follow-ups')).status).toBe(503);
    expect((await app('abc').request('/cron/follow-ups', { headers: { authorization: 'Bearer nope' } })).status).toBe(401);
    const ok = await app('abc').request('/cron/follow-ups', { headers: { authorization: 'Bearer abc' } });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ sent: 2 });
  });
});

describe('MessagingConversions', () => {
  it('finds the dataset once and sends business messaging events', async () => {
    const calls: { url: string; body?: unknown }[] = [];
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url.endsWith('/dataset')) return new Response(JSON.stringify({ id: 'DS1' }));
      return new Response(JSON.stringify({ events_received: 1 }));
    }) as typeof fetch;
    const conversions = new MessagingConversions({ token: 'T', businessAccountId: 'WABA', version: 'v26.0', fetch: fakeFetch });
    const time = new Date('2026-12-01T15:00:00Z');
    await conversions.send({ name: 'LeadSubmitted', clickId: 'C1', time });
    await conversions.send({ name: 'Purchase', clickId: 'C1', time, value: 500_000, currency: 'CRC' });

    expect(calls.map((call) => call.url)).toEqual([
      'https://graph.facebook.com/v26.0/WABA/dataset',
      'https://graph.facebook.com/v26.0/DS1/events',
      'https://graph.facebook.com/v26.0/DS1/events',
    ]);
    expect(calls[1]?.body).toEqual({
      data: [
        {
          event_name: 'LeadSubmitted',
          event_time: 1796137200,
          action_source: 'business_messaging',
          messaging_channel: 'whatsapp',
          user_data: { whatsapp_business_account_id: 'WABA', ctwa_clid: 'C1' },
        },
      ],
    });
    expect(calls[2]?.body).toMatchObject({ data: [{ event_name: 'Purchase', custom_data: { value: 500_000, currency: 'CRC' } }] });
  });
});
