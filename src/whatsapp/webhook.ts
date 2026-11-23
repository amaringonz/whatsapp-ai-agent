export interface InboundMessage {
  kind: 'inbound';
  id: string;
  from: string;
  name?: string;
  timestamp: number;
  text: string;
}

export interface BusinessEcho {
  kind: 'echo';
  id: string;
  to: string;
  timestamp: number;
  text: string;
}

export type WebhookEvent = InboundMessage | BusinessEcho;

interface RawMessage {
  id?: string;
  from?: string;
  to?: string;
  timestamp?: string;
  type?: string;
  text?: { body?: string };
  button?: { text?: string };
  interactive?: {
    button_reply?: { title?: string };
    list_reply?: { title?: string; description?: string };
  };
  location?: { name?: string; address?: string };
  image?: { caption?: string };
  video?: { caption?: string };
  document?: { caption?: string; filename?: string };
  referral?: { headline?: string; body?: string; source_url?: string };
}

interface RawValue {
  metadata?: { phone_number_id?: string };
  contacts?: { wa_id?: string; profile?: { name?: string } }[];
  messages?: RawMessage[];
  message_echoes?: RawMessage[];
}

interface RawPayload {
  object?: string;
  entry?: { changes?: { field?: string; value?: RawValue }[] }[];
}

export function describeMessage(message: RawMessage): string {
  const caption = (value?: string) => (value ? `: ${value}` : '');
  switch (message.type) {
    case 'text':
      return message.text?.body ?? '';
    case 'button':
      return message.button?.text ?? '';
    case 'interactive':
      return message.interactive?.button_reply?.title ?? message.interactive?.list_reply?.title ?? '';
    case 'audio':
      return '[The customer sent a voice note that you cannot listen to]';
    case 'image':
      return `[The customer sent an image you cannot see${caption(message.image?.caption)}]`;
    case 'video':
      return `[The customer sent a video you cannot watch${caption(message.video?.caption)}]`;
    case 'document':
      return `[The customer sent a document${caption(message.document?.filename)}]`;
    case 'sticker':
      return '[The customer sent a sticker]';
    case 'location':
      return `[The customer shared a location${caption(message.location?.name ?? message.location?.address)}]`;
    case 'reaction':
      return '';
    default:
      return `[The customer sent a ${message.type ?? 'message'} you cannot read]`;
  }
}

function withReferral(message: RawMessage, text: string): string {
  const ad = message.referral;
  if (!ad) return text;
  const about = [ad.headline, ad.body].filter(Boolean).join(' — ');
  return `${text}\n[Came from an ad${about ? `: ${about}` : ''}]`;
}

export function parseWebhook(payload: unknown, phoneNumberId?: string): WebhookEvent[] {
  const body = payload as RawPayload;
  if (body?.object !== 'whatsapp_business_account') return [];

  const events: WebhookEvent[] = [];
  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value;
      if (!value) continue;
      if (phoneNumberId && value.metadata?.phone_number_id && value.metadata.phone_number_id !== phoneNumberId) {
        continue;
      }

      if (change.field === 'messages') {
        for (const message of value.messages ?? []) {
          if (!message.id || !message.from) continue;
          const text = describeMessage(message);
          if (!text) continue;
          const contact = value.contacts?.find((item) => item.wa_id === message.from);
          events.push({
            kind: 'inbound',
            id: message.id,
            from: message.from,
            name: contact?.profile?.name,
            timestamp: Number(message.timestamp ?? 0),
            text: withReferral(message, text),
          });
        }
      }

      if (change.field === 'smb_message_echoes') {
        for (const message of value.message_echoes ?? value.messages ?? []) {
          if (!message.id || !message.to) continue;
          events.push({
            kind: 'echo',
            id: message.id,
            to: message.to,
            timestamp: Number(message.timestamp ?? 0),
            text: message.type === 'text' ? (message.text?.body ?? '') : '',
          });
        }
      }
    }
  }
  return events;
}
