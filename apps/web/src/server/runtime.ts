import { FakeClock } from '@recoverkit/core';
import { FakeDomainProvider, FakeMailer } from '@recoverkit/mail';
import { FakeBilling, FakeStripe } from '@recoverkit/stripe';
import { createLogger, createRuntime, loadConfig, type Deps, type Runtime } from '@recoverkit/services';
import pg from 'pg';

export interface E2EControls {
  clock: FakeClock;
  mailer: FakeMailer;
  stripe: FakeStripe;
  domains: FakeDomainProvider;
  billing: FakeBilling;
}

export type WebRuntime = Runtime & { e2e: E2EControls | null };

const KEY = Symbol.for('recoverkit.web.runtime');

/** Mode E2E : adaptateurs factices pilotables par des routes réservées aux tests (jamais en production). */
export function isE2E(env: Record<string, string | undefined> = process.env): boolean {
  return env.RECOVERKIT_E2E === '1';
}

function createE2ERuntime(env: Record<string, string | undefined>): WebRuntime {
  const config = loadConfig(env);
  const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });
  const e2e: E2EControls = {
    clock: new FakeClock(new Date()),
    mailer: new FakeMailer(),
    stripe: new FakeStripe(),
    domains: new FakeDomainProvider(),
    billing: new FakeBilling(),
  };
  const deps: Deps = { pool, config, clock: e2e.clock, mailer: e2e.mailer, domains: e2e.domains, stripe: e2e.stripe, billing: e2e.billing, log: createLogger({ level: env.LOG_LEVEL ?? 'warn' }) };
  return { deps, e2e, close: () => pool.end() };
}

export function getRuntime(): WebRuntime {
  const g = globalThis as unknown as Record<symbol, WebRuntime | undefined>;
  if (!g[KEY]) {
    g[KEY] = isE2E() ? createE2ERuntime(process.env) : { ...createRuntime(process.env), e2e: null };
  }
  return g[KEY]!;
}

export function getDeps(): Deps {
  return getRuntime().deps;
}
