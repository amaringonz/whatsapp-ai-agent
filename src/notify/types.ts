export type HandoffReason = 'completed' | 'urgent' | 'requested_human' | 'out_of_scope';

export interface HandoffNotice {
  reason: HandoffReason;
  contact: string;
  name?: string;
  summary: string;
  lead: Record<string, string>;
  transcript: string;
  business: string;
}

export interface Notifier {
  notify(notice: HandoffNotice): Promise<void>;
}

export const reasonLabels: Record<HandoffReason, string> = {
  completed: 'Ready for you',
  urgent: 'Urgent',
  requested_human: 'Asked for a person',
  out_of_scope: 'Needs your answer',
};

export function renderNotice(notice: HandoffNotice): { subject: string; text: string } {
  const who = notice.name ? `${notice.name} (+${notice.contact})` : `+${notice.contact}`;
  const lead = Object.entries(notice.lead)
    .filter(([, value]) => value)
    .map(([key, value]) => `${key}: ${value}`);
  return {
    subject: `[${notice.business}] ${reasonLabels[notice.reason]}: ${who}`,
    text: [
      `${reasonLabels[notice.reason]} — ${who}`,
      '',
      notice.summary,
      ...(lead.length ? ['', ...lead] : []),
      '',
      `Open the chat: https://wa.me/${notice.contact}`,
      'The assistant stays quiet in this chat until you reply "/bot" from the WhatsApp Business app or the pause ends.',
      '',
      '— Conversation —',
      notice.transcript,
    ].join('\n'),
  };
}
