import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AgentService } from '../src/agent/service.js';
import type { AssistantBlock, ModelRequest } from '../src/agent/types.js';
import { parseBusinessConfig } from '../src/config/business.js';
import { MemoryStore } from '../src/store/memory.js';

const base = JSON.parse(readFileSync('examples/business.example.json', 'utf8'));
const config = parseBusinessConfig({
  ...base,
  handoff: { ...base.handoff, ownerHours: { days: [1, 2, 3, 4, 5], start: '08:00', end: '18:00' } },
});
const contact = '50688887777';

function setup(start: string) {
  let clock = new Date(start);
  const store = new MemoryStore(() => clock.getTime());
  const sent: string[] = [];
  const requests: ModelRequest[] = [];
  let first = true;
  const agent = new AgentService({
    config,
    store,
    model: {
      respond: async (request) => {
        requests.push(structuredClone(request));
        const handoff: AssistantBlock[] = [
          { type: 'tool_use', id: 't', name: 'hand_off', input: { reason: 'out_of_scope', summary: 'Pregunta si atienden niños' } },
        ];
        const last = request.messages.at(-1);
        const afterTool = Array.isArray(last?.content) && last.content[0]?.type === 'tool_result';
        if (first && !afterTool) {
          first = false;
          return { content: handoff, stopReason: 'tool_use' };
        }
        return { content: [{ type: 'text', text: afterTool ? 'Gabriel te escribe' : 'respuesta' }], stopReason: 'end_turn' };
      },
    },
    whatsapp: { markReadAndTyping: async () => undefined, sendText: async (_to, body) => void sent.push(body) },
    notifier: { notify: async () => undefined },
    debounceMs: 0,
    humanPauseHours: 24,
    historyLimit: 40,
    now: () => clock,
    sleep: async () => undefined,
  });
  let n = 0;
  const say = (text: string) => agent.handle({ kind: 'inbound', id: `m${(n += 1)}`, from: contact, timestamp: 0, text });
  const owner = (text: string) => agent.handle({ kind: 'echo', id: `e${(n += 1)}`, to: contact, timestamp: 0, text });
  return { agent, store, sent, requests, say, owner, set: (iso: string) => (clock = new Date(iso)) };
}

describe('covering for the owner after hours', () => {
  it('knows when the owner is away in the business time zone', () => {
    const { agent } = setup('2026-12-01T15:00:00Z');
    expect(agent.ownerAway(new Date('2026-12-01T15:00:00Z').getTime())).toBe(false);
    expect(agent.ownerAway(new Date('2026-12-02T03:00:00Z').getTime())).toBe(true);
    expect(agent.ownerAway(new Date('2026-12-05T16:00:00Z').getTime())).toBe(true);
  });

  it('keeps answering after a handoff outside working hours, without handing off again', async () => {
    const { say, sent, requests, set } = setup('2026-12-02T03:00:00Z');
    await say('¿Atienden niños?');
    expect(sent).toEqual(['Gabriel te escribe']);
    set('2026-12-02T03:10:00Z');
    await say('¿Y dónde quedan?');
    expect(sent).toEqual(['Gabriel te escribe', 'respuesta']);
    const covering = requests.at(-1)!;
    expect(covering.system).toContain('Covering while the owner is away');
    expect(covering.system).toContain('Pregunta si atienden niños');
    expect(covering.tools.map((tool) => tool.name)).not.toContain('hand_off');
  });

  it('stays quiet during working hours or once the owner replied', async () => {
    const day = setup('2026-12-01T15:00:00Z');
    await day.say('¿Atienden niños?');
    await day.say('¿Y dónde quedan?');
    expect(day.sent).toEqual(['Gabriel te escribe']);

    const night = setup('2026-12-02T03:00:00Z');
    await night.say('¿Atienden niños?');
    await night.owner('Hola, soy el doctor');
    await night.say('Perfecto');
    expect(night.sent).toEqual(['Gabriel te escribe']);
  });

  it('never covers without owner hours in the config', async () => {
    const store = new MemoryStore();
    const agent = new AgentService({
      config: parseBusinessConfig({ ...base, handoff: { ...base.handoff, ownerHours: undefined } }),
      store,
      model: { respond: async () => ({ content: [], stopReason: 'end_turn' }) },
      whatsapp: { markReadAndTyping: async () => undefined, sendText: async () => undefined },
      notifier: { notify: async () => undefined },
      debounceMs: 0,
      humanPauseHours: 24,
      historyLimit: 40,
    });
    expect(agent.ownerAway()).toBe(false);
  });
});
