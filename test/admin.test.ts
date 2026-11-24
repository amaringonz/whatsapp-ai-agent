import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AgentService } from '../src/agent/service.js';
import { parseBusinessConfig } from '../src/config/business.js';
import { createApp } from '../src/routes.js';
import { MemoryStore } from '../src/store/memory.js';

const example = JSON.parse(readFileSync('examples/business.example.json', 'utf8'));
const config = parseBusinessConfig({ ...example, handoff: { ...example.handoff, ownerHours: undefined } });
const contact = '50688887777';

function setup() {
  const store = new MemoryStore();
  const sent: string[] = [];
  const typing: string[] = [];
  const agent = new AgentService({
    config,
    store,
    model: {
      respond: async () => ({
        content: [{ type: 'tool_use', id: 't', name: 'hand_off', input: { reason: 'requested_human', summary: 'Quiere hablar con alguien' } }],
        stopReason: 'tool_use',
      }),
    },
    whatsapp: {
      markReadAndTyping: async (id) => void typing.push(id),
      sendText: async (_to, body) => void sent.push(body),
    },
    notifier: { notify: async () => undefined },
    debounceMs: 0,
    humanPauseHours: 24,
    historyLimit: 40,
    sleep: async () => undefined,
  });
  const app = createApp({ verifyToken: 'v', appSecret: 's', adminToken: 'admin', agent: async () => agent, runInBackground: () => undefined });
  return { agent, store, sent, typing, app };
}

const say = (agent: AgentService, id: string, text: string) => agent.handle({ kind: 'inbound', id, from: contact, timestamp: 0, text });
const auth = { authorization: 'Bearer admin' };

describe('admin routes', () => {
  it('require the admin token', async () => {
    const { app } = setup();
    expect((await app.request(`/admin/chats/${contact}`)).status).toBe(401);
    const off = createApp({ verifyToken: 'v', appSecret: 's', agent: async () => setup().agent, runInBackground: () => undefined });
    expect((await off.request(`/admin/chats/${contact}`, { headers: auth })).status).toBe(503);
  });

  it('show a chat, resume it after a handoff and reset it', async () => {
    const { agent, app, typing } = setup();
    await say(agent, 'm1', 'Quiero hablar con una persona');
    const paused = await (await app.request(`/admin/chats/${contact}`, { headers: auth })).json();
    expect(paused).toMatchObject({ paused: true, blocked: false, state: { pauseReason: 'handoff' } });

    await say(agent, 'm2', '¿hola?');
    expect(typing).toEqual(['m1']);

    expect((await app.request(`/admin/chats/${contact}/resume`, { method: 'POST', headers: auth })).status).toBe(200);
    expect(await (await app.request(`/admin/chats/${contact}`, { headers: auth })).json()).toMatchObject({ paused: false });

    expect((await app.request(`/admin/chats/${contact}/reset`, { method: 'POST', headers: auth })).status).toBe(200);
    expect(await (await app.request(`/admin/chats/${contact}`, { headers: auth })).json()).toMatchObject({ history: [], state: {} });
  });

  it('reports the WhatsApp configuration or the Meta error', async () => {
    const make = (status: () => Promise<unknown>) =>
      createApp({ verifyToken: 'v', appSecret: 's', adminToken: 'admin', whatsappStatus: status, agent: async () => setup().agent, runInBackground: () => undefined });
    const ok = await make(async () => ({ phone: { verified_name: 'media0x' } })).request('/admin/whatsapp', { headers: auth });
    expect(await ok.json()).toEqual({ phone: { verified_name: 'media0x' } });
    const bad = await make(async () => {
      throw new Error('WhatsApp API 401');
    }).request('/admin/whatsapp', { headers: auth });
    expect(bad.status).toBe(502);
  });
});
