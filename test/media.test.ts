import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AgentService } from '../src/agent/service.js';
import type { AssistantBlock, ChatMessage, LanguageModel, ModelRequest, ModelResponse } from '../src/agent/types.js';
import { parseBusinessConfig } from '../src/config/business.js';
import { MediaReader, stripAttachments } from '../src/media/reader.js';
import { OpenAICompatibleTranscriber, type Transcriber } from '../src/media/transcriber.js';
import { MemoryStore } from '../src/store/memory.js';
import { toQueuedMessage } from '../src/store/types.js';
import { MediaTooLargeError, WhatsAppClient, type MediaDownloader } from '../src/whatsapp/client.js';
import { parseWebhook } from '../src/whatsapp/webhook.js';

const config = parseBusinessConfig(JSON.parse(readFileSync('examples/business.example.json', 'utf8')));

class FakeDownloader implements MediaDownloader {
  calls: string[] = [];
  constructor(private readonly files: Record<string, { data: Uint8Array; mimeType: string } | Error>) {}

  async downloadMedia(mediaId: string) {
    this.calls.push(mediaId);
    const file = this.files[mediaId];
    if (!file) throw new Error('not found');
    if (file instanceof Error) throw file;
    return file;
  }
}

const bytes = (value: string) => new TextEncoder().encode(value);
const transcriber = (text: string): Transcriber => ({ transcribe: async () => text });

describe('parseWebhook media', () => {
  it('keeps a media reference next to the fallback text', () => {
    const [event] = parseWebhook({
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                messages: [{ id: 'w1', from: '506', type: 'image', image: { id: 'IMG1', mime_type: 'image/jpeg', caption: 'Así quiero mi logo' } }],
              },
            },
          ],
        },
      ],
    });
    expect(event).toMatchObject({
      kind: 'inbound',
      media: { type: 'image', id: 'IMG1', mimeType: 'image/jpeg', caption: 'Así quiero mi logo' },
    });
    expect(event?.text).toContain('could not open');
  });

  it('describes shared locations and contacts', () => {
    const events = parseWebhook({
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                messages: [
                  { id: 'w2', from: '506', type: 'location', location: { name: 'Oficina', latitude: 9.93, longitude: -84.08 } },
                  { id: 'w3', from: '506', type: 'contacts', contacts: [{ name: { formatted_name: 'Luis' }, phones: [{ phone: '+506 8888 0000' }] }] },
                ],
              },
            },
          ],
        },
      ],
    });
    expect(events[0]?.text).toContain('Oficina (9.93, -84.08)');
    expect(events[1]?.text).toContain('Luis +506 8888 0000');
  });
});

describe('MediaReader', () => {
  it('turns a photo into an image block with its caption', async () => {
    const reader = new MediaReader({ downloader: new FakeDownloader({ IMG1: { data: bytes('jpg'), mimeType: 'image/jpeg' } }) });
    const content = await reader.read([
      { text: 'Hola' },
      { text: '[fallback]', media: { type: 'image', id: 'IMG1', mimeType: 'image/jpeg', caption: 'Mi logo' } },
    ]);
    expect(content).toEqual([
      { type: 'text', text: 'Hola' },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: Buffer.from('jpg').toString('base64') } },
      { type: 'text', text: '[Photo from the customer: "Mi logo"]' },
    ]);
  });

  it('reads PDFs and plain text files as documents', async () => {
    const reader = new MediaReader({
      downloader: new FakeDownloader({
        PDF1: { data: bytes('%PDF'), mimeType: 'application/pdf' },
        TXT1: { data: bytes('lista de precios'), mimeType: 'text/plain' },
      }),
    });
    const content = await reader.read([
      { text: '[fallback]', media: { type: 'document', id: 'PDF1', mimeType: 'application/pdf', filename: 'cotizacion.pdf' } },
      { text: '[fallback]', media: { type: 'document', id: 'TXT1', mimeType: 'text/plain', filename: 'notas.txt' } },
    ]);
    expect(content).toMatchObject([
      { type: 'document', title: 'cotizacion.pdf', source: { type: 'base64', media_type: 'application/pdf' } },
      { type: 'text', text: '[Document from the customer "cotizacion.pdf"]' },
      { type: 'document', title: 'notas.txt', source: { type: 'text', media_type: 'text/plain', data: 'lista de precios' } },
      { type: 'text', text: '[Document from the customer "notas.txt"]' },
    ]);
  });

  it('does not download files it cannot open and keeps the fallback text', async () => {
    const downloader = new FakeDownloader({});
    const reader = new MediaReader({ downloader });
    const content = await reader.read([
      {
        text: '[cannot open docx]',
        media: { type: 'document', id: 'DOC1', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
      },
      { text: '[cannot watch video]', media: { type: 'video', id: 'VID1', mimeType: 'video/mp4' } },
    ]);
    expect(content).toBe('[cannot open docx]\n[cannot watch video]');
    expect(downloader.calls).toEqual([]);
  });

  it('transcribes voice notes when a transcriber is configured', async () => {
    const downloader = new FakeDownloader({ AUD1: { data: bytes('ogg'), mimeType: 'audio/ogg' } });
    const withTranscriber = new MediaReader({ downloader, transcriber: transcriber('Quiero una tienda en línea') });
    expect(await withTranscriber.read([{ text: '[fallback]', media: { type: 'audio', id: 'AUD1' } }])).toBe(
      '[Voice note, transcribed] Quiero una tienda en línea',
    );

    const without = new MediaReader({ downloader });
    expect(await without.read([{ text: '[fallback]', media: { type: 'audio', id: 'AUD1' } }])).toBe('[fallback]');
    expect(downloader.calls).toEqual(['AUD1']);
  });

  it('falls back when a download fails or a file is too large', async () => {
    const reader = new MediaReader({
      downloader: new FakeDownloader({ BIG: new MediaTooLargeError(9_000_000), BAD: new Error('boom') }),
    });
    const content = await reader.read([
      { text: '[fallback big]', media: { type: 'image', id: 'BIG' } },
      { text: '[fallback bad]', media: { type: 'image', id: 'BAD' } },
    ]);
    expect(content).toContain('too large');
    expect(content).toContain('[fallback bad]');
  });

  it('keeps the ad context of a media message', async () => {
    const reader = new MediaReader({ downloader: new FakeDownloader({ IMG1: { data: bytes('x'), mimeType: 'image/png' } }) });
    const content = await reader.read([
      { text: '[fallback]\n[Came from an ad: Tu tienda en línea]', media: { type: 'image', id: 'IMG1' } },
    ]);
    expect(JSON.stringify(content)).toContain('Came from an ad: Tu tienda en línea');
  });
});

describe('stripAttachments', () => {
  it('replaces photos and documents with notes so the saved history stays small', () => {
    const history: ChatMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
          { type: 'text', text: '[Photo from the customer]' },
          { type: 'document', title: 'menu.pdf', source: { type: 'base64', media_type: 'application/pdf', data: 'BBBB' } },
        ],
      },
      { role: 'assistant', content: 'Qué buen logo' },
    ];
    expect(stripAttachments(history)).toEqual([
      {
        role: 'user',
        content: '[The photo is no longer attached]\n[Photo from the customer]\n[The document "menu.pdf" is no longer attached]',
      },
      { role: 'assistant', content: 'Qué buen logo' },
    ]);
  });
});

describe('queued messages', () => {
  it('reads the old plain text queue entries and the new ones', () => {
    expect(toQueuedMessage('Hola')).toEqual({ text: 'Hola' });
    expect(toQueuedMessage('{"text":"x","media":{"type":"image","id":"I"}}')).toEqual({ text: 'x', media: { type: 'image', id: 'I' } });
    expect(toQueuedMessage({ text: 'y' })).toEqual({ text: 'y' });
  });
});

describe('AgentService with media', () => {
  it('shows the photo to the model and saves only a note', async () => {
    const requests: ModelRequest[] = [];
    const model: LanguageModel = {
      respond: async (request): Promise<ModelResponse> => {
        requests.push(structuredClone(request));
        const content: AssistantBlock[] = [{ type: 'text', text: 'Se ve muy bien tu logo' }];
        return { content, stopReason: 'end_turn' };
      },
    };
    const store = new MemoryStore();
    const sent: string[] = [];
    const agent = new AgentService({
      config,
      store,
      model,
      whatsapp: { markReadAndTyping: async () => undefined, sendText: async (_to, body) => void sent.push(body) },
      notifier: { notify: async () => undefined },
      media: new MediaReader({ downloader: new FakeDownloader({ IMG1: { data: bytes('png'), mimeType: 'image/png' } }) }),
      debounceMs: 0,
      humanPauseHours: 24,
      historyLimit: 40,
      sleep: async () => undefined,
    });

    await agent.handle({
      kind: 'inbound',
      id: 'w1',
      from: '506',
      timestamp: 0,
      text: '[fallback]',
      media: { type: 'image', id: 'IMG1', mimeType: 'image/png' },
    });

    expect(sent).toEqual(['Se ve muy bien tu logo']);
    const lastUser = requests[0]?.messages.at(-1);
    expect(JSON.stringify(lastUser)).toContain('"type":"image"');

    const saved = await store.load('506');
    expect(JSON.stringify(saved.history)).not.toContain('"type":"image"');
    expect(saved.history[0]).toEqual({ role: 'user', content: '[The photo is no longer attached]\n[Photo from the customer]' });
  });
});

describe('WhatsAppClient.downloadMedia', () => {
  it('looks up the media URL and downloads it with the token', async () => {
    const seen: { url: string; auth: string | null }[] = [];
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      seen.push({ url, auth: new Headers(init?.headers).get('authorization') });
      if (url.endsWith('/MEDIA1')) {
        return new Response(JSON.stringify({ url: 'https://lookaside.example/file', mime_type: 'image/jpeg', file_size: 3 }));
      }
      return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/jpeg' } });
    }) as typeof fetch;

    const client = new WhatsAppClient({ token: 'T', phoneNumberId: 'P', version: 'v26.0', fetch: fakeFetch });
    const file = await client.downloadMedia('MEDIA1', 10);
    expect(file.mimeType).toBe('image/jpeg');
    expect([...file.data]).toEqual([1, 2, 3]);
    expect(seen).toEqual([
      { url: 'https://graph.facebook.com/v26.0/MEDIA1', auth: 'Bearer T' },
      { url: 'https://lookaside.example/file', auth: 'Bearer T' },
    ]);

    await expect(client.downloadMedia('MEDIA1', 2)).rejects.toBeInstanceOf(MediaTooLargeError);
  });
});

describe('OpenAICompatibleTranscriber', () => {
  it('posts the audio as a form and returns the text', async () => {
    let request: { url: string; body: FormData } | undefined;
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      request = { url, body: init?.body as FormData };
      return new Response(JSON.stringify({ text: ' Hola, quiero una app ' }));
    }) as typeof fetch;

    const transcriberClient = new OpenAICompatibleTranscriber({
      apiKey: 'K',
      baseUrl: 'https://api.groq.com/openai/v1/',
      model: 'whisper-large-v3-turbo',
      fetch: fakeFetch,
    });
    expect(await transcriberClient.transcribe(bytes('ogg'), 'audio/ogg; codecs=opus', 'es')).toBe('Hola, quiero una app');
    expect(request?.url).toBe('https://api.groq.com/openai/v1/audio/transcriptions');
    expect(request?.body.get('model')).toBe('whisper-large-v3-turbo');
    expect(request?.body.get('language')).toBe('es');
    expect((request?.body.get('file') as File).name).toBe('voice-note.ogg');
  });
});
