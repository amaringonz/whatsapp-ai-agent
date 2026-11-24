import { describe, expect, it } from 'vitest';
import { fromOpenAIResponse, OpenAIModel, toOpenAIMessages } from '../src/agent/openai.js';
import type { ChatMessage } from '../src/agent/types.js';
import { readEnv } from '../src/config/env.js';

const base = {
  WHATSAPP_TOKEN: 't',
  WHATSAPP_PHONE_NUMBER_ID: 'p',
  WHATSAPP_APP_SECRET: 's',
  WHATSAPP_VERIFY_TOKEN: 'v',
};

describe('toOpenAIMessages', () => {
  it('maps text, photos, PDFs, tool calls and tool results', () => {
    const history: ChatMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } },
          { type: 'text', text: '[Photo from the customer]' },
          { type: 'document', title: 'menu.pdf', source: { type: 'base64', media_type: 'application/pdf', data: 'BBB' } },
          { type: 'document', title: 'notas.txt', source: { type: 'text', media_type: 'text/plain', data: 'hola' } },
        ],
      },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Déjame revisar' },
          { type: 'tool_use', id: 'call_1', name: 'get_availability', input: {} },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '{"days":[]}' }] },
      { role: 'assistant', content: 'No hay espacios' },
    ];

    expect(toOpenAIMessages('SYSTEM', history)).toEqual([
      { role: 'system', content: 'SYSTEM' },
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
          { type: 'text', text: '[Photo from the customer]' },
          { type: 'file', file: { filename: 'menu.pdf', file_data: 'data:application/pdf;base64,BBB' } },
          { type: 'text', text: 'File "notas.txt":\nhola' },
        ],
      },
      {
        role: 'assistant',
        content: 'Déjame revisar',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_availability', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: '{"days":[]}' },
      { role: 'assistant', content: 'No hay espacios' },
    ]);
  });
});

describe('fromOpenAIResponse', () => {
  it('turns tool calls into tool_use blocks', () => {
    const response = fromOpenAIResponse({
      choices: [
        {
          finish_reason: 'tool_calls',
          message: {
            content: null,
            tool_calls: [{ id: 'call_9', type: 'function', function: { name: 'hand_off', arguments: '{"reason":"urgent"}' } }],
          },
        },
      ],
    });
    expect(response).toEqual({
      content: [{ type: 'tool_use', id: 'call_9', name: 'hand_off', input: { reason: 'urgent' } }],
      stopReason: 'tool_use',
    });
  });

  it('returns plain text replies', () => {
    expect(fromOpenAIResponse({ choices: [{ finish_reason: 'stop', message: { content: 'Hola' } }] })).toEqual({
      content: [{ type: 'text', text: 'Hola' }],
      stopReason: 'stop',
    });
  });
});

describe('OpenAIModel', () => {
  it('calls chat completions with the tools as functions', async () => {
    let sent: { url: string; body: Record<string, unknown>; auth: string | null } | undefined;
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      sent = { url, body: JSON.parse(String(init?.body)), auth: new Headers(init?.headers).get('authorization') };
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'Listo' } }] }));
    }) as typeof fetch;

    const model = new OpenAIModel({ apiKey: 'K', model: 'gpt-6.2-sol', fetch: fakeFetch });
    const result = await model.respond({
      system: 'S',
      messages: [{ role: 'user', content: 'Hola' }],
      tools: [{ name: 'hand_off', description: 'd', input_schema: { type: 'object', properties: {} } }],
    });

    expect(result.content).toEqual([{ type: 'text', text: 'Listo' }]);
    expect(sent?.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(sent?.auth).toBe('Bearer K');
    expect(sent?.body).toMatchObject({
      model: 'gpt-6.2-sol',
      tools: [{ type: 'function', function: { name: 'hand_off', description: 'd' } }],
    });
  });

  it('surfaces API errors', async () => {
    const fakeFetch = (async () => new Response('bad key', { status: 401 })) as typeof fetch;
    const model = new OpenAIModel({ apiKey: 'K', model: 'm', fetch: fakeFetch });
    await expect(model.respond({ system: 'S', messages: [], tools: [] })).rejects.toThrow('OpenAI 401');
  });
});

describe('provider selection', () => {
  it('uses OpenAI for the agent and the voice notes with a single key', () => {
    const env = readEnv({ ...base, OPENAI_API_KEY: 'sk-1' });
    expect(env.AI_PROVIDER).toBe('openai');
    expect(env.OPENAI_MODEL).toBe('gpt-6.2-sol');
    expect(env.TRANSCRIPTION_API_KEY).toBe('sk-1');
  });

  it('honours AI_PROVIDER when both keys exist', () => {
    expect(readEnv({ ...base, OPENAI_API_KEY: 'sk', ANTHROPIC_API_KEY: 'ak' }).AI_PROVIDER).toBe('anthropic');
    expect(readEnv({ ...base, OPENAI_API_KEY: 'sk', ANTHROPIC_API_KEY: 'ak', AI_PROVIDER: 'openai' }).AI_PROVIDER).toBe('openai');
  });

  it('requires the key of the chosen provider', () => {
    expect(() => readEnv({ ...base, AI_PROVIDER: 'openai', ANTHROPIC_API_KEY: 'ak' })).toThrow('OPENAI_API_KEY');
    expect(() => readEnv(base)).toThrow('ANTHROPIC_API_KEY');
  });

  it('keeps a separate transcription key for other providers', () => {
    const env = readEnv({
      ...base,
      OPENAI_API_KEY: 'sk',
      TRANSCRIPTION_BASE_URL: 'https://api.groq.com/openai/v1',
      TRANSCRIPTION_API_KEY: 'gk',
    });
    expect(env.TRANSCRIPTION_API_KEY).toBe('gk');
    expect(readEnv({ ...base, OPENAI_API_KEY: 'sk', TRANSCRIPTION_BASE_URL: 'https://api.groq.com/openai/v1' }).TRANSCRIPTION_API_KEY).toBeUndefined();
  });
});
