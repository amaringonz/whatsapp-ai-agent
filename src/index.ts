import { waitUntil } from '@vercel/functions';
import { createApp } from './app.js';
import { createAgent } from './bootstrap.js';
import { readEnv } from './config/env.js';
import type { AgentService } from './agent/service.js';

const env = readEnv();
let agent: Promise<AgentService> | undefined;

const app = createApp({
  verifyToken: env.WHATSAPP_VERIFY_TOKEN,
  appSecret: env.WHATSAPP_APP_SECRET,
  phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID,
  agent: () => (agent ??= createAgent(env)),
  runInBackground: (task) => waitUntil(task),
});

export default app;
