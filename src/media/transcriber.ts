export interface Transcriber {
  transcribe(audio: Uint8Array, mimeType: string, language?: string): Promise<string>;
}

const EXTENSIONS: Record<string, string> = {
  'audio/ogg': 'ogg',
  'audio/opus': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/amr': 'amr',
  'audio/wav': 'wav',
  'audio/webm': 'webm',
};

export class OpenAICompatibleTranscriber implements Transcriber {
  constructor(
    private readonly options: {
      apiKey: string;
      baseUrl: string;
      model: string;
      fetch?: typeof fetch;
    },
  ) {}

  async transcribe(audio: Uint8Array, mimeType: string, language?: string): Promise<string> {
    const type = mimeType.split(';')[0]!.trim();
    const form = new FormData();
    form.append('file', new Blob([audio], { type }), `voice-note.${EXTENSIONS[type] ?? 'ogg'}`);
    form.append('model', this.options.model);
    if (language) form.append('language', language.slice(0, 2));
    form.append('response_format', 'json');

    const request = this.options.fetch ?? fetch;
    const response = await request(`${this.options.baseUrl.replace(/\/$/, '')}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.options.apiKey}` },
      body: form,
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Transcription ${response.status}: ${await response.text()}`);
    const result = (await response.json()) as { text?: string };
    return result.text?.trim() ?? '';
  }
}
