import { describe, expect, it } from 'vitest';
import { derivePaymentToken, signUnsubscribe, verifyUnsubscribe, hashToken } from '../src';

const secret = 's'.repeat(40);

describe('derivePaymentToken', () => {
  it('est déterministe : même dossier et génération = même lien', () => {
    expect(derivePaymentToken(secret, 'case-1', 1)).toBe(derivePaymentToken(secret, 'case-1', 1));
  });

  it('change avec le dossier, la génération et le secret', () => {
    const base = derivePaymentToken(secret, 'case-1', 1);
    expect(derivePaymentToken(secret, 'case-2', 1)).not.toBe(base);
    expect(derivePaymentToken(secret, 'case-1', 2)).not.toBe(base);
    expect(derivePaymentToken('t'.repeat(40), 'case-1', 1)).not.toBe(base);
  });

  it('est URL-safe, de 256 bits, et son hash est stable', () => {
    const t = derivePaymentToken(secret, 'case-1', 1);
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(hashToken(t)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuse un secret trop court', () => {
    expect(() => derivePaymentToken('court', 'c', 1)).toThrow(/secret/);
  });
});

describe('signUnsubscribe / verifyUnsubscribe', () => {
  it('valide une signature authentique', () => {
    const s = signUnsubscribe(secret, 'tenant-1', 'camille@example.com');
    expect(verifyUnsubscribe(secret, 'tenant-1', 'camille@example.com', s)).toBe(true);
  });

  it('refuse un autre email, un autre tenant ou une signature altérée', () => {
    const s = signUnsubscribe(secret, 'tenant-1', 'camille@example.com');
    expect(verifyUnsubscribe(secret, 'tenant-1', 'autre@example.com', s)).toBe(false);
    expect(verifyUnsubscribe(secret, 'tenant-2', 'camille@example.com', s)).toBe(false);
    expect(verifyUnsubscribe(secret, 'tenant-1', 'camille@example.com', s.slice(0, -2) + 'xx')).toBe(false);
    expect(verifyUnsubscribe(secret, 'tenant-1', 'camille@example.com', '')).toBe(false);
  });

  it('ignore la casse de l’adresse', () => {
    const s = signUnsubscribe(secret, 'tenant-1', 'Camille@Example.com');
    expect(verifyUnsubscribe(secret, 'tenant-1', 'camille@example.com', s)).toBe(true);
  });

  it("une signature de désinscription n'est jamais un token de paiement", () => {
    expect(signUnsubscribe(secret, 'case-1', 'a@b.c')).not.toBe(derivePaymentToken(secret, 'case-1', 1));
  });
});
