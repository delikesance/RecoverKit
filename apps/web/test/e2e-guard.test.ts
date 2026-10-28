import { describe, expect, it } from 'vitest';
import { e2eAllowed } from '../src/server/e2e-guard';

const req = (token?: string) => new Request('https://app.test/api/e2e/x', { headers: token ? { 'x-e2e-token': token } : {} });

describe('e2eAllowed', () => {
  it('refuse hors mode E2E, même avec le bon jeton', () => {
    expect(e2eAllowed({ E2E_TOKEN: 'secret' }, req('secret'))).toBe(false);
    expect(e2eAllowed({ RECOVERKIT_E2E: '0', E2E_TOKEN: 'secret' }, req('secret'))).toBe(false);
  });
  it('exige un jeton configuré et correct', () => {
    expect(e2eAllowed({ RECOVERKIT_E2E: '1' }, req('secret'))).toBe(false);
    expect(e2eAllowed({ RECOVERKIT_E2E: '1', E2E_TOKEN: 'secret' }, req())).toBe(false);
    expect(e2eAllowed({ RECOVERKIT_E2E: '1', E2E_TOKEN: 'secret' }, req('autre'))).toBe(false);
    expect(e2eAllowed({ RECOVERKIT_E2E: '1', E2E_TOKEN: 'secret' }, req('secret'))).toBe(true);
  });
});
