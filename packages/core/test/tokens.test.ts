import { describe, expect, it } from 'vitest';
import {
  PAYMENT_TOKEN_TTL_DAYS,
  evaluateToken,
  generatePaymentToken,
  hashToken,
  newTokenExpiry,
  tokenMatches,
} from '../src/tokens';

describe('generatePaymentToken', () => {
  it('produit ≥ 128 bits d’entropie, URL-safe', () => {
    const { token } = generatePaymentToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(token, 'base64url').length).toBeGreaterThanOrEqual(16);
  });

  it('deux tokens ne sont jamais identiques', () => {
    const set = new Set(Array.from({ length: 500 }, () => generatePaymentToken().token));
    expect(set.size).toBe(500);
  });

  it('renvoie le hash, jamais le token, comme valeur à stocker', () => {
    const { token, hash } = generatePaymentToken();
    expect(hash).toBe(hashToken(token));
    expect(hash).not.toContain(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('hashToken / tokenMatches', () => {
  it('le hash est stable et dépend du token', () => {
    expect(hashToken('abc')).toBe(hashToken('abc'));
    expect(hashToken('abc')).not.toBe(hashToken('abd'));
  });

  it('compare en temps constant et refuse les entrées invalides', () => {
    const { token, hash } = generatePaymentToken();
    expect(tokenMatches(token, hash)).toBe(true);
    expect(tokenMatches(token + 'x', hash)).toBe(false);
    expect(tokenMatches(token, 'zz')).toBe(false);
    expect(tokenMatches('', hash)).toBe(false);
  });
});

describe('evaluateToken', () => {
  const now = new Date('2026-10-10T12:00:00Z');
  const base = { expiresAt: new Date('2026-10-20T12:00:00Z'), usedAt: null, revokedAt: null };

  it('ACTIVE tant qu’il n’est ni utilisé, ni révoqué, ni expiré', () => {
    expect(evaluateToken(base, now)).toBe('ACTIVE');
  });

  it('EXPIRED à l’instant exact d’expiration', () => {
    expect(evaluateToken({ ...base, expiresAt: now }, now)).toBe('EXPIRED');
    expect(evaluateToken({ ...base, expiresAt: new Date(now.getTime() - 1) }, now)).toBe('EXPIRED');
  });

  it('USED après usage', () => {
    expect(evaluateToken({ ...base, usedAt: new Date('2026-10-09T00:00:00Z') }, now)).toBe('USED');
  });

  it('REVOKED prime sur tout le reste', () => {
    const revoked = new Date('2026-10-09T00:00:00Z');
    expect(evaluateToken({ expiresAt: new Date(0), usedAt: revoked, revokedAt: revoked }, now)).toBe('REVOKED');
  });
});

describe('newTokenExpiry', () => {
  it('expire après 14 jours', () => {
    expect(PAYMENT_TOKEN_TTL_DAYS).toBe(14);
    const now = new Date('2026-10-01T00:00:00Z');
    expect(newTokenExpiry(now).toISOString()).toBe('2026-10-15T00:00:00.000Z');
  });
});
