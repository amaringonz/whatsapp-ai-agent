import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifySignature(rawBody: string, header: string | null | undefined, appSecret: string): boolean {
  if (!header?.startsWith('sha256=')) return false;
  const received = Buffer.from(header.slice('sha256='.length), 'hex');
  const expected = createHmac('sha256', appSecret).update(rawBody, 'utf8').digest();
  return received.length === expected.length && timingSafeEqual(received, expected);
}
