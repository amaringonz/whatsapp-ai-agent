import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifySignature } from '../src/whatsapp/signature.js';
import { parseWebhook } from '../src/whatsapp/webhook.js';

const payload = (field: string, value: Record<string, unknown>) => ({
  object: 'whatsapp_business_account',
  entry: [{ changes: [{ field, value: { metadata: { phone_number_id: 'PN1' }, ...value } }] }],
});

describe('verifySignature', () => {
  const body = JSON.stringify({ hello: 'world' });
  const sign = (secret: string) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

  it('accepts a valid signature', () => {
    expect(verifySignature(body, sign('secret'), 'secret')).toBe(true);
  });

  it('rejects a wrong or missing signature', () => {
    expect(verifySignature(body, sign('other'), 'secret')).toBe(false);
    expect(verifySignature(body, undefined, 'secret')).toBe(false);
    expect(verifySignature(body, 'sha256=abc', 'secret')).toBe(false);
  });
});

describe('parseWebhook', () => {
  it('reads text messages with the contact name', () => {
    const events = parseWebhook(
      payload('messages', {
        contacts: [{ wa_id: '50688887777', profile: { name: 'Ana' } }],
        messages: [{ id: 'wamid.1', from: '50688887777', timestamp: '1700000000', type: 'text', text: { body: 'Hola' } }],
      }),
      'PN1',
    );
    expect(events).toEqual([
      { kind: 'inbound', id: 'wamid.1', from: '50688887777', name: 'Ana', timestamp: 1700000000, text: 'Hola' },
    ]);
  });

  it('describes media the agent cannot read and keeps ad context', () => {
    const [event] = parseWebhook(
      payload('messages', {
        messages: [
          {
            id: 'wamid.2',
            from: '506',
            type: 'audio',
            referral: { headline: 'Tu tienda en línea', body: 'Vende las 24 horas' },
          },
        ],
      }),
    );
    expect(event?.kind).toBe('inbound');
    expect(event?.text).toContain('voice note');
    expect(event?.text).toContain('Tu tienda en línea');
  });

  it('turns business app echoes into owner events', () => {
    const events = parseWebhook(
      payload('smb_message_echoes', {
        message_echoes: [{ id: 'wamid.3', from: 'PN1', to: '50688887777', type: 'text', text: { body: '/bot' } }],
      }),
    );
    expect(events).toEqual([{ kind: 'echo', id: 'wamid.3', to: '50688887777', timestamp: 0, text: '/bot' }]);
  });

  it('ignores statuses, reactions, other numbers and other objects', () => {
    expect(parseWebhook(payload('messages', { statuses: [{ id: 'x', status: 'read' }] }))).toEqual([]);
    expect(
      parseWebhook(payload('messages', { messages: [{ id: 'r', from: '506', type: 'reaction' }] })),
    ).toEqual([]);
    expect(
      parseWebhook(payload('messages', { messages: [{ id: 'm', from: '506', type: 'text', text: { body: 'hi' } }] }), 'OTHER'),
    ).toEqual([]);
    expect(parseWebhook({ object: 'page' })).toEqual([]);
  });
});
