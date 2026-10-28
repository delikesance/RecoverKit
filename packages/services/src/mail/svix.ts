import { createHmac, timingSafeEqual } from 'node:crypto';

const TOLERANCE_SECONDS = 300;

/** Vérifie la signature Svix (utilisée par Resend) : HMAC-SHA256 de `${id}.${timestamp}.${corps}`. */
export function verifySvixSignature(
  rawBody: string,
  h: { id: string | null; timestamp: string | null; signature: string | null },
  secret: string,
  now: Date,
): boolean {
  if (!h.id || !h.timestamp || !h.signature) return false;
  if (!/^\d+$/.test(h.timestamp)) return false;
  if (Math.abs(Math.floor(now.getTime() / 1000) - Number(h.timestamp)) > TOLERANCE_SECONDS) return false;

  const key = Buffer.from(secret.startsWith('whsec_') ? secret.slice(6) : secret, 'base64');
  const expected = createHmac('sha256', key).update(`${h.id}.${h.timestamp}.${rawBody}`).digest();
  return h.signature.split(' ').some((part) => {
    const [version, sig] = part.split(',');
    if (version !== 'v1' || !sig) return false;
    const given = Buffer.from(sig, 'base64');
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}
