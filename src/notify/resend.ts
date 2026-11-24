import { Resend } from 'resend';
import { renderNotice, type HandoffNotice, type Notifier } from './types.js';

export class ResendNotifier implements Notifier {
  private readonly resend: Resend;

  constructor(
    apiKey: string,
    private readonly from: string,
    private readonly to: string,
  ) {
    this.resend = new Resend(apiKey);
  }

  async notify(notice: HandoffNotice): Promise<void> {
    const { subject, text } = renderNotice(notice);
    await this.send(subject, text);
  }

  async alert(subject: string, text: string): Promise<void> {
    await this.send(subject, text);
  }

  private async send(subject: string, text: string): Promise<void> {
    const { error } = await this.resend.emails.send({ from: this.from, to: this.to, subject, text });
    if (error) throw new Error(`Resend: ${error.message}`);
  }
}

export class ConsoleNotifier implements Notifier {
  async notify(notice: HandoffNotice): Promise<void> {
    const { subject, text } = renderNotice(notice);
    console.info(`\n${subject}\n${text}\n`);
  }

  async alert(subject: string, text: string): Promise<void> {
    console.warn(`\n${subject}\n${text}\n`);
  }
}
