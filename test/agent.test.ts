import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildSystemPrompt, splitReply } from '../src/agent/prompt.js';
import { trimHistory } from '../src/agent/run.js';
import { AgentService, normalizeHistory } from '../src/agent/service.js';
import { runTool, toolSpecs } from '../src/agent/tools.js';
import type { AssistantBlock, ChatMessage, LanguageModel, ModelRequest, ModelResponse } from '../src/agent/types.js';
import type { BookingProvider, BookingRequest } from '../src/booking/types.js';
import { parseBusinessConfig } from '../src/config/business.js';
import type { HandoffNotice } from '../src/notify/types.js';
import { MemoryStore } from '../src/store/memory.js';

const config = parseBusinessConfig(JSON.parse(readFileSync('examples/business.example.json', 'utf8')));
const contact = '50688887777';

class ScriptedModel implements LanguageModel {
  requests: ModelRequest[] = [];
  constructor(private readonly script: AssistantBlock[][]) {}

  async respond(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(structuredClone(request));
    const content = this.script.shift() ?? [{ type: 'text', text: 'ok' }];
    return { content, stopReason: content.some((block) => block.type === 'tool_use') ? 'tool_use' : 'end_turn' };
  }
}

function setup(script: AssistantBlock[][], booking?: BookingProvider) {
  const store = new MemoryStore();
  const sent: string[] = [];
  const notices: HandoffNotice[] = [];
  const model = new ScriptedModel(script);
  let clock = new Date('2026-12-01T15:00:00Z');
  const agent = new AgentService({
    config,
    store,
    model,
    booking,
    whatsapp: { markReadAndTyping: async () => undefined, sendText: async (_to, body) => void sent.push(body) },
    notifier: { notify: async (notice) => void notices.push(notice) },
    debounceMs: 0,
    humanPauseHours: 24,
    historyLimit: 40,
    now: () => clock,
    sleep: async () => undefined,
  });
  return { agent, store, sent, notices, model, advance: (hours: number) => (clock = new Date(clock.getTime() + hours * 3_600_000)) };
}

const inbound = (id: string, text: string) => ({ kind: 'inbound' as const, id, from: contact, name: 'Ana', timestamp: 0, text });
const echo = (id: string, text: string) => ({ kind: 'echo' as const, id, to: contact, timestamp: 0, text });

describe('config and prompt', () => {
  it('validates the example config', () => {
    expect(config.business.name).toBe('Clínica Dental Sonrisa');
  });

  it('builds a prompt with the rules, scope and handoff conditions', () => {
    const prompt = buildSystemPrompt(config, { now: new Date('2026-12-01T15:00:00Z'), contactName: 'Ana' });
    expect(prompt).toContain('No des diagnósticos');
    expect(prompt).toContain('decline kindly');
    expect(prompt).toContain('urgent: El paciente describe dolor intenso');
    expect(prompt).toContain('WhatsApp name: Ana');
    expect(prompt).toContain('Tuesday, December 1, 2026');
  });

  it('exposes booking tools with enum fields only when booking is available', () => {
    expect(toolSpecs(config, false).map((tool) => tool.name)).toEqual(['hand_off']);
    const book = toolSpecs(config, true).find((tool) => tool.name === 'book_appointment');
    expect(book?.input_schema.required).toEqual(['name', 'date', 'time', 'reason', 'patient_type']);
    expect((book?.input_schema.properties.patient_type as { enum: string[] }).enum).toEqual(['new', 'returning']);
  });

  it('splits replies into at most three WhatsApp messages', () => {
    expect(splitReply('Hola\n---\n¿Cómo estás?\n---\nUno\n---\nDos')).toEqual(['Hola', '¿Cómo estás?', 'Uno']);
  });
});

describe('history', () => {
  it('trims without splitting a tool call from its result', () => {
    const history: ChatMessage[] = [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'get_availability', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'x' }] },
      { role: 'assistant', content: 'b' },
      { role: 'user', content: 'c' },
      { role: 'assistant', content: 'd' },
    ];
    expect(trimHistory(history, 4)).toEqual(history.slice(4));
  });

  it('merges consecutive turns and drops a leading owner message', () => {
    const history: ChatMessage[] = [
      { role: 'assistant', content: '(owner) hola' },
      { role: 'user', content: 'uno' },
      { role: 'user', content: 'dos' },
      { role: 'assistant', content: 'tres' },
      { role: 'assistant', content: '(owner) cuatro' },
    ];
    expect(normalizeHistory(history)).toEqual([
      { role: 'user', content: 'uno\ndos' },
      { role: 'assistant', content: [{ type: 'text', text: 'tres' }, { type: 'text', text: '(owner) cuatro' }] },
    ]);
  });
});

describe('AgentService', () => {
  let booked: BookingRequest[];
  let booking: BookingProvider;

  beforeEach(() => {
    booked = [];
    booking = {
      availability: async () => [
        { date: '2026-12-02', label: 'miércoles 2 de diciembre', slots: [{ time: '09:00', label: '9:00 a. m.' }] },
      ],
      book: async (request) => {
        booked.push(request);
        return { ok: true, id: 'abc', summary: 'miércoles 2 de diciembre, 9:00 a. m.' };
      },
    };
  });

  it('answers a message and remembers the conversation', async () => {
    const { agent, sent, store } = setup([[{ type: 'text', text: 'Hola Ana\n---\n¿En qué te ayudo?' }]]);
    await agent.handle(inbound('m1', 'Hola'));
    expect(sent).toEqual(['Hola Ana', '¿En qué te ayudo?']);
    const saved = await store.load(contact);
    expect(saved.state.name).toBe('Ana');
    expect(saved.history.at(-1)?.role).toBe('assistant');
  });

  it('ignores duplicate webhook deliveries', async () => {
    const { agent, sent } = setup([[{ type: 'text', text: 'Hola' }]]);
    await agent.handle(inbound('m1', 'Hola'));
    await agent.handle(inbound('m1', 'Hola'));
    expect(sent).toEqual(['Hola']);
  });

  it('answers several quick messages together, once', async () => {
    const { agent, sent, model, store } = setup([[{ type: 'text', text: 'Claro' }]]);
    await store.queueMessage(contact, 'm0', { text: 'Hola' });
    await agent.handle(inbound('m1', '¿tienen espacio mañana?'));
    expect(sent).toEqual(['Claro']);
    expect(model.requests[0]?.messages.at(-1)).toEqual({ role: 'user', content: 'Hola\n¿tienen espacio mañana?' });
  });

  it('books with the tools, hands off when completed and stays quiet afterwards', async () => {
    const { agent, sent, notices, store } = setup(
      [
        [{ type: 'tool_use', id: 't1', name: 'get_availability', input: {} }],
        [{ type: 'text', text: '¿Te sirve el miércoles a las 9?' }],
        [
          {
            type: 'tool_use',
            id: 't2',
            name: 'book_appointment',
            input: { name: 'Ana Mora', date: '2026-12-02', time: '09:00', reason: 'Limpieza', patient_type: 'new' },
          },
        ],
        [{ type: 'tool_use', id: 't3', name: 'hand_off', input: { reason: 'completed', summary: 'Cita agendada.' } }],
        [{ type: 'text', text: 'Listo, te esperamos. La doctora seguirá por aquí.' }],
      ],
      booking,
    );

    await agent.handle(inbound('m1', 'Quiero una limpieza'));
    expect(sent).toEqual(['¿Te sirve el miércoles a las 9?']);

    await agent.handle(inbound('m2', 'Sí, a nombre de Ana Mora, soy nueva'));
    expect(booked[0]).toMatchObject({ phone: contact, date: '2026-12-02', time: '09:00', fields: { reason: 'Limpieza', patient_type: 'new' } });
    expect(notices[0]).toMatchObject({ reason: 'completed', contact, name: 'Ana Mora' });
    expect(notices[0]?.transcript).toContain('Customer: Quiero una limpieza');
    expect(sent.at(-1)).toContain('te esperamos');

    const state = (await store.load(contact)).state;
    expect(state.pauseReason).toBe('handoff');

    await agent.handle(inbound('m3', 'Gracias!'));
    expect(sent).toHaveLength(2);
  });

  it('pauses when the owner writes from the app and resumes with /bot', async () => {
    const { agent, sent, store } = setup([[{ type: 'text', text: 'De vuelta' }]]);
    await agent.handle(echo('e1', 'Hola, soy la doctora'));
    await agent.handle(inbound('m1', 'Hola doctora'));
    expect(sent).toEqual([]);
    expect((await store.load(contact)).history.map((message) => message.content)).toEqual([
      '(la doctora Ramírez) Hola, soy la doctora',
      'Hola doctora',
    ]);

    await agent.handle(echo('e2', '/bot'));
    await agent.handle(inbound('m2', '¿Y el horario?'));
    expect(sent).toEqual(['De vuelta']);
  });

  it('resumes by itself when the pause expires', async () => {
    const { agent, sent, advance } = setup([[{ type: 'text', text: 'Hola otra vez' }]]);
    await agent.handle(echo('e1', 'Te escribo luego'));
    advance(25);
    await agent.handle(inbound('m1', 'Hola'));
    expect(sent).toEqual(['Hola otra vez']);
  });

  it('passes the payment link to the model when the booking waits for payment', async () => {
    const pending: BookingProvider = {
      availability: async () => [],
      book: async () => ({
        ok: true,
        id: 'p1',
        summary: 'Apartada el miércoles 2 de diciembre a las 9:00 a. m.',
        paymentUrl: 'https://example.com/pago/p1',
      }),
    };
    const result = await runTool(
      'book_appointment',
      { name: 'Ana Mora', date: '2026-12-02', time: '09:00' },
      {
        contact,
        config,
        booking: pending,
        onHandoff: async () => undefined,
        onLead: () => undefined,
      },
    );
    expect(result).toContain('waiting for payment');
    expect(result).toContain('https://example.com/pago/p1');
  });

  it('reports tool failures to the model instead of crashing', async () => {
    const failing: BookingProvider = {
      availability: async () => {
        throw new Error('down');
      },
      book: async () => ({ ok: false, reason: 'unavailable', message: 'down' }),
    };
    const { agent, sent, model } = setup(
      [
        [{ type: 'tool_use', id: 't1', name: 'get_availability', input: {} }],
        [{ type: 'text', text: 'Disculpa, déjame revisarlo con el equipo.' }],
      ],
      failing,
    );
    await agent.handle(inbound('m1', '¿Qué horarios tienen?'));
    expect(sent).toEqual(['Disculpa, déjame revisarlo con el equipo.']);
    const result = model.requests[1]?.messages.at(-1);
    expect(result).toMatchObject({ role: 'user', content: [{ type: 'tool_result', is_error: true }] });
  });
});
