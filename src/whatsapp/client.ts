export interface WhatsAppSender {
  markReadAndTyping(messageId: string): Promise<void>;
  sendText(to: string, body: string): Promise<void>;
}

export interface DownloadedMedia {
  data: Uint8Array;
  mimeType: string;
}

export interface MediaDownloader {
  downloadMedia(mediaId: string, maxBytes: number): Promise<DownloadedMedia>;
}

export class MediaTooLargeError extends Error {
  constructor(readonly bytes: number) {
    super(`Media is ${bytes} bytes`);
  }
}

export class WhatsAppClient implements WhatsAppSender, MediaDownloader {
  constructor(
    private readonly options: {
      token: string;
      phoneNumberId: string;
      version: string;
      fetch?: typeof fetch;
    },
  ) {}

  private async post(body: Record<string, unknown>): Promise<void> {
    const request = this.options.fetch ?? fetch;
    const response = await request(
      `https://graph.facebook.com/${this.options.version}/${this.options.phoneNumberId}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.options.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ messaging_product: 'whatsapp', ...body }),
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!response.ok) {
      throw new Error(`WhatsApp API ${response.status}: ${await response.text()}`);
    }
  }

  async markReadAndTyping(messageId: string): Promise<void> {
    await this.post({ status: 'read', message_id: messageId, typing_indicator: { type: 'text' } });
  }

  async sendText(to: string, body: string): Promise<void> {
    await this.post({ recipient_type: 'individual', to, type: 'text', text: { preview_url: true, body } });
  }

  async downloadMedia(mediaId: string, maxBytes: number): Promise<DownloadedMedia> {
    const request = this.options.fetch ?? fetch;
    const headers = { Authorization: `Bearer ${this.options.token}` };

    const meta = await request(`https://graph.facebook.com/${this.options.version}/${mediaId}`, {
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    if (!meta.ok) throw new Error(`WhatsApp media ${meta.status}: ${await meta.text()}`);
    const info = (await meta.json()) as { url?: string; mime_type?: string; file_size?: number };
    if (!info.url) throw new Error('WhatsApp media has no URL');
    if (info.file_size && info.file_size > maxBytes) throw new MediaTooLargeError(info.file_size);

    const file = await request(info.url, { headers, signal: AbortSignal.timeout(20_000) });
    if (!file.ok) throw new Error(`WhatsApp media download ${file.status}`);
    const data = new Uint8Array(await file.arrayBuffer());
    if (data.byteLength > maxBytes) throw new MediaTooLargeError(data.byteLength);

    const mimeType = (info.mime_type ?? file.headers.get('content-type') ?? 'application/octet-stream').split(';')[0]!.trim();
    return { data, mimeType };
  }
}
