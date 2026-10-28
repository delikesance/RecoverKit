import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifySvixSignature } from '../src/mail/svix';

const raw = Buffer.from('un-secret-de-test-assez-long');
const secret = `whsec_${raw.toString('base64')}`;
const now = new Date('2026-10-01T08:00:00Z');
const ts = String(Math.floor(now.getTime() / 1000));
const body = '{"type":"email.delivered"}';
const sign = (id: string, t: string, b: string, key = raw) => 'v1,' + createHmac('sha256', key).update(`${id}.${t}.${b}`).digest('base64');

describe('verifySvixSignature', () => {
  it('accepte une signature valide', () => {
    expect(verifySvixSignature(body, { id: 'msg_1', timestamp: ts, signature: sign('msg_1', ts, body) }, secret, now)).toBe(true);
  });
  it('refuse un mauvais secret, un corps modifié ou un autre identifiant', () => {
    expect(verifySvixSignature(body, { id: 'msg_1', timestamp: ts, signature: sign('msg_1', ts, body, Buffer.from('autre')) }, secret, now)).toBe(false);
    expect(verifySvixSignature(body + ' ', { id: 'msg_1', timestamp: ts, signature: sign('msg_1', ts, body) }, secret, now)).toBe(false);
    expect(verifySvixSignature(body, { id: 'msg_2', timestamp: ts, signature: sign('msg_1', ts, body) }, secret, now)).toBe(false);
  });
  it('accepte plusieurs signatures séparées par un espace', () => {
    const header = `v1,AAAA ${sign('msg_1', ts, body)}`;
    expect(verifySvixSignature(body, { id: 'msg_1', timestamp: ts, signature: header }, secret, now)).toBe(true);
  });
  it('refuse un horodatage hors tolérance (5 min) ou invalide', () => {
    const old = String(Number(ts) - 301);
    expect(verifySvixSignature(body, { id: 'msg_1', timestamp: old, signature: sign('msg_1', old, body) }, secret, now)).toBe(false);
    expect(verifySvixSignature(body, { id: 'msg_1', timestamp: 'abc', signature: sign('msg_1', 'abc', body) }, secret, now)).toBe(false);
  });
  it('refuse des en-têtes manquants', () => {
    expect(verifySvixSignature(body, { id: null, timestamp: ts, signature: 'v1,x' }, secret, now)).toBe(false);
    expect(verifySvixSignature(body, { id: 'm', timestamp: null, signature: 'v1,x' }, secret, now)).toBe(false);
    expect(verifySvixSignature(body, { id: 'm', timestamp: ts, signature: null }, secret, now)).toBe(false);
  });
});
