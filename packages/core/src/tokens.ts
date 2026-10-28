import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { durationToMs } from './clock';

export const PAYMENT_TOKEN_TTL_DAYS = 14;

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Génère un token de 256 bits ; seul `hash` doit être stocké en base. */
export function generatePaymentToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashToken(token) };
}

export function tokenMatches(token: string, storedHash: string): boolean {
  if (!token) return false;
  const a = Buffer.from(hashToken(token), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export type TokenStatus = 'ACTIVE' | 'USED' | 'EXPIRED' | 'REVOKED';

export function evaluateToken(
  t: { expiresAt: Date; usedAt: Date | null; revokedAt: Date | null },
  now: Date,
): TokenStatus {
  if (t.revokedAt) return 'REVOKED';
  if (t.usedAt) return 'USED';
  if (t.expiresAt.getTime() <= now.getTime()) return 'EXPIRED';
  return 'ACTIVE';
}

export function newTokenExpiry(now: Date): Date {
  return new Date(now.getTime() + durationToMs({ days: PAYMENT_TOKEN_TTL_DAYS }));
}
