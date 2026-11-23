import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { AnthropicModel } from '../src/agent/anthropic.js';
import { AgentService } from '../src/agent/service.js';
import { HttpBookingProvider } from '../src/booking/http.js';
import { loadBusinessConfig } from '../src/config/business.js';
import { ConsoleNotifier } from '../src/notify/resend.js';
import { MemoryStore } from '../src/store/memory.js';

const apiKey = process.env.ANTHROPIC_API_KEY;
const configPath = process.argv[2] ?? process.env.BUSINESS_CONFIG_PATH ?? 'examples/business.example.json';
if (!apiKey) throw new Error('Set ANTHROPIC_API_KEY to chat with the agent.');

const config = await loadBusinessConfig({ path: configPath });
const contact = '50600000000';
let counter = 0;

const agent = new AgentService({
  config,
  store: new MemoryStore(),
  model: new AnthropicModel(apiKey, process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-5-5'),
  notifier: new ConsoleNotifier(),
  booking:
    process.env.BOOKING_API_URL && process.env.BOOKING_API_TOKEN
      ? new HttpBookingProvider({ baseUrl: process.env.BOOKING_API_URL, token: process.env.BOOKING_API_TOKEN })
      : undefined,
  whatsapp: {
    markReadAndTyping: async () => undefined,
    sendText: async (_to, body) => {
      console.info(`\n${config.assistant.name}: ${body}`);
    },
  },
  debounceMs: 0,
  humanPauseHours: 24,
  historyLimit: 40,
});

const rl = createInterface({ input, output });
console.info(`Chatting with ${config.assistant.name}. Type /owner <text> to reply as the owner, /bot to resume, Ctrl+C to exit.`);

while (true) {
  const line = (await rl.question('\nYou: ')).trim();
  if (!line) continue;
  counter += 1;
  if (line.startsWith('/owner ') || line === '/bot') {
    await agent.handle({ kind: 'echo', id: `echo-${counter}`, to: contact, timestamp: Date.now() / 1000, text: line.replace(/^\/owner /, '') });
    console.info('(owner message recorded)');
    continue;
  }
  await agent.handle({ kind: 'inbound', id: `local-${counter}`, from: contact, name: 'Test', timestamp: Date.now() / 1000, text: line });
}
