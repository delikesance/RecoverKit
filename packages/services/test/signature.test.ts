import { describe, expect, it } from 'vitest';
import { signStripePayload } from '@recoverkit/testkit';
import { verifyStripeSignature } from '../src/webhooks/signature';

const secret = 'whsec_test';
const body = '{"id":"evt_1"}';
const now = new Date('2026-10-01T08:00:00Z');

describe('verifyStripeSignature', () => {
  it('accepte une signature valide', () => {
    expect(verifyStripeSignature(body, signStripePayload(body, secret, now), secret, now)).toEqual({ ok: true });
  });

  it('refuse un mauvais secret', () => {
    const r = verifyStripeSignature(body, signStripePayload(body, 'autre', now), secret, now);
    expect(r).toEqual({ ok: false, reason: 'mismatch' });
  });

  it('refuse un corps modifié', () => {
    const header = signStripePayload(body, secret, now);
    expect(verifyStripeSignature(body + ' ', header, secret, now)).toEqual({ ok: false, reason: 'mismatch' });
  });

  it('refuse un horodatage hors tolérance (5 minutes)', () => {
    const old = new Date(now.getTime() - 301_000);
    expect(verifyStripeSignature(body, signStripePayload(body, secret, old), secret, now)).toEqual({ ok: false, reason: 'timestamp' });
    const future = new Date(now.getTime() + 301_000);
    expect(verifyStripeSignature(body, signStripePayload(body, secret, future), secret, now)).toEqual({ ok: false, reason: 'timestamp' });
  });

  it('accepte la limite de tolérance', () => {
    const edge = new Date(now.getTime() - 300_000);
    expect(verifyStripeSignature(body, signStripePayload(body, secret, edge), secret, now).ok).toBe(true);
  });

  it('accepte plusieurs signatures v1 si l’une est valide (rotation de secret)', () => {
    const good = signStripePayload(body, secret, now);
    const header = `${good},v1=${'0'.repeat(64)}`;
    expect(verifyStripeSignature(body, header, secret, now).ok).toBe(true);
  });

  it('refuse un en-tête absent ou malformé', () => {
    expect(verifyStripeSignature(body, null, secret, now)).toEqual({ ok: false, reason: 'malformed' });
    expect(verifyStripeSignature(body, 'n-importe-quoi', secret, now)).toEqual({ ok: false, reason: 'malformed' });
    expect(verifyStripeSignature(body, 't=abc,v1=zz', secret, now)).toEqual({ ok: false, reason: 'malformed' });
  });
});
