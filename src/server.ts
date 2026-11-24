import { serve } from '@hono/node-server';
import { createApp } from './routes.js';
import { createAgent } from './bootstrap.js';
import { readEnv } from './config/env.js';
import type { AgentService } from './agent/service.js';

const env = readEnv();
let agent: Promise<AgentService> | undefined;
const port = Number(process.env.PORT ?? 3000);

const app = createApp({
  verifyToken: env.WHATSAPP_VERIFY_TOKEN,
  appSecret: env.WHATSAPP_APP_SECRET,
  phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID,
  agent: () => (agent ??= createAgent(env)),
  runInBackground: (task) => {
    task.catch((error) => console.error(error));
  },
});

serve({ fetch: app.fetch, port }, () => console.info(`Listening on http://localhost:${port}`));
