import { Hono } from 'hono';
import { verifySignature } from './whatsapp/signature.js';
import { parseWebhook } from './whatsapp/webhook.js';
import type { AgentService } from './agent/service.js';

export const MAX_WEBHOOK_BYTES = 512 * 1024;

export interface AppDependencies {
  verifyToken: string;
  appSecret: string;
  phoneNumberId?: string;
  agent: () => Promise<AgentService>;
  runInBackground: (task: Promise<unknown>) => void;
}

export function createApp(deps: AppDependencies) {
  const app = new Hono();

  app.get('/', (c) => c.json({ name: 'whatsapp-ai-agent', ok: true }));
  app.get('/health', (c) => c.json({ ok: true }));

  app.get('/webhook', (c) => {
    const mode = c.req.query('hub.mode');
    const token = c.req.query('hub.verify_token');
    const challenge = c.req.query('hub.challenge');
    if (mode === 'subscribe' && token === deps.verifyToken && challenge) return c.text(challenge);
    return c.text('Forbidden', 403);
  });

  app.post('/webhook', async (c) => {
    const declared = Number(c.req.header('content-length') ?? 0);
    if (declared > MAX_WEBHOOK_BYTES) return c.text('Payload too large', 413);
    const raw = await c.req.text();
    if (Buffer.byteLength(raw) > MAX_WEBHOOK_BYTES) return c.text('Payload too large', 413);
    if (!verifySignature(raw, c.req.header('x-hub-signature-256'), deps.appSecret)) {
      console.warn('Rejected webhook with an invalid signature');
      return c.text('Invalid signature', 401);
    }

    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      return c.text('Invalid JSON', 400);
    }

    const events = parseWebhook(payload, deps.phoneNumberId);
    console.info(`Webhook received: ${events.length ? events.map((event) => event.kind).join(', ') : 'no events'}`);
    if (events.length) {
      deps.runInBackground(
        (async () => {
          const agent = await deps.agent();
          await Promise.all(
            events.map((event) =>
              agent.handle(event).catch((error) => console.error(`Failed to handle ${event.kind} ${event.id}`, error)),
            ),
          );
        })(),
      );
    }
    return c.text('OK');
  });

  return app;
}
