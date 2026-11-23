import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { AgentService } from '../src/agent/service.js';
import type { WebhookEvent } from '../src/whatsapp/webhook.js';

function setup() {
  const handled: WebhookEvent[] = [];
  const tasks: Promise<unknown>[] = [];
  const app = createApp({
    verifyToken: 'verify-me',
    appSecret: 'secret',
    phoneNumberId: 'PN1',
    agent: async () => ({ handle: async (event: WebhookEvent) => void handled.push(event) }) as unknown as AgentService,
    runInBackground: (task) => void tasks.push(task),
  });
  return { app, handled, tasks };
}

const body = JSON.stringify({
  object: 'whatsapp_business_account',
  entry: [
    {
      changes: [
        {
          field: 'messages',
          value: {
            metadata: { phone_number_id: 'PN1' },
            messages: [{ id: 'wamid.1', from: '506', type: 'text', text: { body: 'Hola' } }],
          },
        },
      ],
    },
  ],
});
const signature = `sha256=${createHmac('sha256', 'secret').update(body).digest('hex')}`;

describe('webhook endpoint', () => {
  it('answers the Meta verification challenge only with the right token', async () => {
    const { app } = setup();
    const ok = await app.request('/webhook?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=42');
    expect(await ok.text()).toBe('42');
    const bad = await app.request('/webhook?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=42');
    expect(bad.status).toBe(403);
  });

  it('rejects unsigned payloads', async () => {
    const { app, handled } = setup();
    const response = await app.request('/webhook', { method: 'POST', body });
    expect(response.status).toBe(401);
    expect(handled).toEqual([]);
  });

  it('acknowledges right away and handles events in the background', async () => {
    const { app, handled, tasks } = setup();
    const response = await app.request('/webhook', {
      method: 'POST',
      body,
      headers: { 'x-hub-signature-256': signature, 'content-type': 'application/json' },
    });
    expect(response.status).toBe(200);
    await Promise.all(tasks);
    expect(handled).toHaveLength(1);
    expect(handled[0]).toMatchObject({ kind: 'inbound', text: 'Hola' });
  });
});
