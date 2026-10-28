import { createHmac, timingSafeEqual } from 'node:crypto';

export type SignatureResult = { ok: true } | { ok: false; reason: 'malformed' | 'timestamp' | 'mismatch' };

const TOLERANCE_SECONDS = 300;

/** Vérifie l'en-tête `Stripe-Signature` (HMAC-SHA256 de `${t}.${corps}`), avec horloge injectée. */
export function verifyStripeSignature(
  rawBody: string,
  header: string | null | undefined,
  secret: string,
  now: Date,
): SignatureResult {
  if (!header) return { ok: false, reason: 'malformed' };
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of header.split(',')) {
    const [k, v] = part.split('=', 2);
    if (k === 't' && v && /^\d+$/.test(v)) timestamp = Number(v);
    else if (k === 'v1' && v) signatures.push(v);
  }
  if (timestamp === null || signatures.length === 0 || signatures.some((s) => !/^[0-9a-f]+$/i.test(s))) {
    return { ok: false, reason: 'malformed' };
  }
  if (Math.abs(Math.floor(now.getTime() / 1000) - timestamp) > TOLERANCE_SECONDS) {
    return { ok: false, reason: 'timestamp' };
  }
  const expected = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest();
  const matches = signatures.some((s) => {
    const given = Buffer.from(s, 'hex');
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
  return matches ? { ok: true } : { ok: false, reason: 'mismatch' };
}
