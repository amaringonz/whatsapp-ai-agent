import type { BookingProvider, BookingRequest, BookingResult, Day } from './types.js';

export class HttpBookingProvider implements BookingProvider {
  constructor(
    private readonly options: { baseUrl: string; token: string; fetch?: typeof fetch },
  ) {}

  private url(path: string): string {
    return `${this.options.baseUrl.replace(/\/$/, '')}/${path}`;
  }

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.options.token}`, 'Content-Type': 'application/json' };
  }

  async availability(): Promise<Day[]> {
    const request = this.options.fetch ?? fetch;
    const response = await request(this.url('availability'), {
      headers: this.headers(),
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) throw new Error(`Booking availability ${response.status}`);
    const data = (await response.json()) as { days?: Day[] };
    return data.days ?? [];
  }

  async book(body: BookingRequest): Promise<BookingResult> {
    const request = this.options.fetch ?? fetch;
    const response = await request(this.url('appointments'), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const data = (await response.json().catch(() => ({}))) as {
      id?: string;
      summary?: string;
      message?: string;
      paymentUrl?: string;
    };

    if (response.ok && data.id) {
      const paymentUrl = typeof data.paymentUrl === 'string' && data.paymentUrl.startsWith('https://') ? data.paymentUrl : undefined;
      return { ok: true, id: data.id, summary: data.summary ?? '', ...(paymentUrl ? { paymentUrl } : {}) };
    }
    if (response.status === 409) {
      return { ok: false, reason: 'slot_taken', message: data.message ?? 'That time was just taken.' };
    }
    if (response.status === 422) {
      return { ok: false, reason: 'invalid', message: data.message ?? 'Some details are missing or invalid.' };
    }
    return { ok: false, reason: 'unavailable', message: data.message ?? `Booking failed (${response.status}).` };
  }
}
