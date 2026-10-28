import { createHmac, timingSafeEqual } from 'node:crypto';

function hmac(secret: string, purpose: string, ...parts: string[]): Buffer {
  if (secret.length < 32) throw new Error('Le secret de signature doit contenir au moins 32 caractères');
  return createHmac('sha256', secret).update([purpose, ...parts].join('\u0000')).digest();
}

/**
 * Token de paiement dérivé du dossier : le même lien peut figurer dans tous les emails du dossier,
 * sans stocker le token en clair (seul son hash est en base). `generation` permet la rotation.
 */
export function derivePaymentToken(secret: string, caseId: string, generation: number): string {
  return hmac(secret, 'pay', caseId, String(generation)).toString('base64url');
}

export function signUnsubscribe(secret: string, tenantId: string, email: string): string {
  return hmac(secret, 'unsub', tenantId, email.trim().toLowerCase()).toString('base64url');
}

export function verifyUnsubscribe(secret: string, tenantId: string, email: string, signature: string): boolean {
  if (!signature) return false;
  const expected = hmac(secret, 'unsub', tenantId, email.trim().toLowerCase());
  const given = Buffer.from(signature, 'base64url');
  return given.length === expected.length && timingSafeEqual(given, expected);
}
