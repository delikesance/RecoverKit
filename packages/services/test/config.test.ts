import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';

const valid = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  APP_URL: 'https://app.recoverkit.example',
  STRIPE_SECRET_KEY: 'sk_test_x',
  STRIPE_CONNECT_WEBHOOK_SECRET: 'whsec_connect',
  STRIPE_PLATFORM_WEBHOOK_SECRET: 'whsec_platform',
  STRIPE_CONNECT_CLIENT_ID: 'ca_123',
  RESEND_API_KEY: 're_x',
  SYSTEM_FROM_EMAIL: 'no-reply@mail.recoverkit.example',
  TOKEN_SECRET: 'x'.repeat(32),
};

describe('loadConfig', () => {
  it('charge une configuration valide avec des valeurs par défaut', () => {
    const c = loadConfig(valid);
    expect(c.appUrl).toBe('https://app.recoverkit.example');
    expect(c.nodeEnv).toBe('development');
    expect(c.plans).toEqual([]);
    expect(c.inboxBatchSize).toBeGreaterThan(0);
    expect(c.stripePublishableKey).toBe('');
    expect(c.trialDays).toBe(14);
    expect(c.billingGraceDays).toBe(7);
    expect(loadConfig({ ...valid, TRIAL_DAYS: '30', BILLING_GRACE_DAYS: '3' })).toMatchObject({ trialDays: 30, billingGraceDays: 3 });
    expect(loadConfig({ ...valid, STRIPE_PUBLISHABLE_KEY: 'pk_test_1' }).stripePublishableKey).toBe('pk_test_1');
  });

  it('échoue avec un message qui nomme chaque variable manquante', () => {
    const { DATABASE_URL: _a, STRIPE_SECRET_KEY: _b, ...partial } = valid;
    expect(() => loadConfig(partial)).toThrow(/DATABASE_URL/);
    expect(() => loadConfig(partial)).toThrow(/STRIPE_SECRET_KEY/);
  });

  it('refuse un secret de jeton trop court', () => {
    expect(() => loadConfig({ ...valid, TOKEN_SECRET: 'court' })).toThrow(/TOKEN_SECRET/);
  });

  it('refuse une APP_URL invalide', () => {
    expect(() => loadConfig({ ...valid, APP_URL: 'pas-une-url' })).toThrow(/APP_URL/);
  });

  it('lit les paliers PLANS depuis du JSON (D6) et valide leur forme', () => {
    const plans = [{ key: 'start', name: 'Départ', priceId: 'price_1', maxMrr: 500000, monthlyPrice: 2900 }];
    expect(loadConfig({ ...valid, PLANS: JSON.stringify(plans) }).plans).toEqual(plans);
    expect(() => loadConfig({ ...valid, PLANS: '{pas du json' })).toThrow(/PLANS/);
    expect(() => loadConfig({ ...valid, PLANS: JSON.stringify([{ key: 'x' }]) })).toThrow(/PLANS/);
  });

  it('exige HTTPS en production', () => {
    expect(() => loadConfig({ ...valid, NODE_ENV: 'production', APP_URL: 'http://app.example' })).toThrow(/HTTPS/);
    expect(loadConfig({ ...valid, NODE_ENV: 'production' }).nodeEnv).toBe('production');
  });

  it('tolère http uniquement sur localhost en production (démarrage local, E2E)', () => {
    expect(loadConfig({ ...valid, NODE_ENV: 'production', APP_URL: 'http://localhost:3100' }).appUrl).toBe('http://localhost:3100');
    expect(() => loadConfig({ ...valid, NODE_ENV: 'production', APP_URL: 'http://localhost.evil.example' })).toThrow(/HTTPS/);
  });
});
