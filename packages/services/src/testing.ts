import { FakeClock } from '@recoverkit/core';
import { FakeDomainProvider, FakeMailer } from '@recoverkit/mail';
import { FakeBilling, FakeStripe } from '@recoverkit/stripe';
import type { Pool } from 'pg';
import { loadConfig } from './config';
import type { Deps } from './deps';
import { silentLogger } from './logger';

export interface TestDeps extends Deps {
  clock: FakeClock;
  mailer: FakeMailer;
  domains: FakeDomainProvider;
  stripe: FakeStripe;
  billing: FakeBilling;
}

export const TEST_ENV = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://unused',
  APP_URL: 'https://app.recoverkit.test',
  STRIPE_SECRET_KEY: 'sk_test_x',
  STRIPE_CONNECT_WEBHOOK_SECRET: 'whsec_connect_test',
  STRIPE_PLATFORM_WEBHOOK_SECRET: 'whsec_platform_test',
  STRIPE_CONNECT_CLIENT_ID: 'ca_test',
  RESEND_API_KEY: 're_test',
  SYSTEM_FROM_EMAIL: 'no-reply@mail.recoverkit.test',
  TOKEN_SECRET: 't'.repeat(40),
  RESEND_WEBHOOK_SECRET: `whsec_${Buffer.from('resend-webhook-secret-for-tests').toString('base64')}`,
};

export function makeDeps(db: { pool: Pool }, start = new Date('2026-10-01T08:00:00Z')): TestDeps {
  return {
    pool: db.pool,
    clock: new FakeClock(start),
    mailer: new FakeMailer(),
    domains: new FakeDomainProvider(),
    stripe: new FakeStripe(),
    billing: new FakeBilling(),
    config: loadConfig(TEST_ENV),
    log: silentLogger(),
  };
}
