export interface WhatsAppSender {
  markReadAndTyping(messageId: string): Promise<void>;
  sendText(to: string, body: string): Promise<void>;
}

export class WhatsAppClient implements WhatsAppSender {
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
}
