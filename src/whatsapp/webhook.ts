export type MediaType = 'image' | 'audio' | 'document' | 'video' | 'sticker';

export interface MediaRef {
  type: MediaType;
  id: string;
  mimeType?: string;
  filename?: string;
  caption?: string;
}

export interface InboundMessage {
  kind: 'inbound';
  id: string;
  from: string;
  name?: string;
  timestamp: number;
  text: string;
  media?: MediaRef;
}

export interface BusinessEcho {
  kind: 'echo';
  id: string;
  to: string;
  timestamp: number;
  text: string;
}

export type WebhookEvent = InboundMessage | BusinessEcho;

interface RawMedia {
  id?: string;
  mime_type?: string;
  caption?: string;
  filename?: string;
}

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
  location?: { name?: string; address?: string; latitude?: number; longitude?: number };
  image?: RawMedia;
  audio?: RawMedia;
  video?: RawMedia;
  sticker?: RawMedia;
  document?: RawMedia;
  contacts?: { name?: { formatted_name?: string }; phones?: { phone?: string }[] }[];
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
      return '[The customer sent a voice note you could not listen to. Ask them kindly to write it.]';
    case 'image':
      return `[The customer sent an image you could not open${caption(message.image?.caption)}]`;
    case 'video':
      return `[The customer sent a video you cannot watch${caption(message.video?.caption)}. Ask them to tell you what it shows or send a photo.]`;
    case 'document':
      return `[The customer sent a file you could not open${caption(message.document?.filename)}${message.document?.caption ? ` with the note "${message.document.caption}"` : ''}. Ask them to send it as a PDF or a photo, or to tell you what it says.]`;
    case 'sticker':
      return '[The customer sent a sticker]';
    case 'location': {
      const place = [message.location?.name, message.location?.address].filter(Boolean).join(', ');
      const point =
        message.location?.latitude !== undefined && message.location?.longitude !== undefined
          ? ` (${message.location.latitude}, ${message.location.longitude})`
          : '';
      return `[The customer shared a location${caption(place)}${point}]`;
    }
    case 'contacts': {
      const cards = (message.contacts ?? []).map((card) =>
        [card.name?.formatted_name, ...(card.phones ?? []).map((phone) => phone.phone)].filter(Boolean).join(' '),
      );
      return `[The customer shared a contact${caption(cards.join('; '))}]`;
    }
    case 'reaction':
      return '';
    default:
      return `[The customer sent a ${message.type ?? 'message'} you cannot read]`;
  }
}

const MEDIA_TYPES: MediaType[] = ['image', 'audio', 'document', 'video', 'sticker'];

export function mediaOf(message: RawMessage): MediaRef | undefined {
  const type = MEDIA_TYPES.find((item) => item === message.type);
  if (!type) return undefined;
  const raw = message[type];
  if (!raw?.id) return undefined;
  return {
    type,
    id: raw.id,
    mimeType: raw.mime_type,
    filename: raw.filename,
    caption: raw.caption,
  };
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
            ...(mediaOf(message) ? { media: mediaOf(message) } : {}),
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
