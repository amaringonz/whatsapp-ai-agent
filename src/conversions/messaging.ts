export type MessagingEventName = 'LeadSubmitted' | 'QualifiedLead' | 'Purchase';

export interface MessagingEvent {
  name: MessagingEventName;
  clickId: string;
  time: Date;
  value?: number;
  currency?: string;
}

export interface ConversionSender {
  send(event: MessagingEvent): Promise<void>;
}

export class MessagingConversions implements ConversionSender {
  private datasetId?: string;

  constructor(
    private readonly options: {
      token: string;
      businessAccountId: string;
      datasetId?: string;
      version: string;
      fetch?: typeof fetch;
    },
  ) {
    this.datasetId = options.datasetId;
  }

  private get request(): typeof fetch {
    return this.options.fetch ?? fetch;
  }

  private async dataset(): Promise<string> {
    if (this.datasetId) return this.datasetId;
    const response = await this.request(
      `https://graph.facebook.com/${this.options.version}/${this.options.businessAccountId}/dataset`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.options.token}` },
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!response.ok) throw new Error(`Meta dataset ${response.status}: ${await response.text()}`);
    const data = (await response.json()) as { id?: string };
    if (!data.id) throw new Error('Meta did not return a dataset id');
    this.datasetId = data.id;
    return data.id;
  }

  async send(event: MessagingEvent): Promise<void> {
    const datasetId = await this.dataset();
    const payload = {
      data: [
        {
          event_name: event.name,
          event_time: Math.floor(event.time.getTime() / 1000),
          action_source: 'business_messaging',
          messaging_channel: 'whatsapp',
          user_data: {
            whatsapp_business_account_id: this.options.businessAccountId,
            ctwa_clid: event.clickId,
          },
          ...(event.value !== undefined ? { custom_data: { value: event.value, currency: event.currency ?? 'USD' } } : {}),
        },
      ],
    };
    const response = await this.request(`https://graph.facebook.com/${this.options.version}/${datasetId}/events`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.options.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Meta conversions ${response.status}: ${await response.text()}`);
  }
}
