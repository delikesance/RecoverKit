import pg from 'pg';
import { SystemClock } from '@recoverkit/core';
import { ResendDomainProvider, ResendMailer } from '@recoverkit/mail';
import { StripeSdkBillingGateway, StripeSdkGateway } from '@recoverkit/stripe';
import { loadConfig } from './config';
import type { Deps } from './deps';
import { createLogger } from './logger';

export interface Runtime {
  deps: Deps;
  close(): Promise<void>;
}

/** Composition racine de production : adaptateurs réels, pool PostgreSQL, journal structuré. */
export function createRuntime(env: Record<string, string | undefined>): Runtime {
  const config = loadConfig(env);
  const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });
  const log = createLogger({ level: env.LOG_LEVEL ?? 'info' });
  if (config.nodeEnv === 'production' && config.legalMissing.length > 0) {
    log.warn({ missing: config.legalMissing }, 'mentions légales incomplètes : variables LEGAL_* manquantes');
  }
  pool.on('error', (e) => log.error({ err: e.message }, 'erreur du pool PostgreSQL'));

  const deps: Deps = {
    pool,
    clock: new SystemClock(),
    log,
    config,
    mailer: new ResendMailer({ apiKey: config.resendApiKey }),
    domains: new ResendDomainProvider({ apiKey: config.resendApiKey }),
    stripe: new StripeSdkGateway({ secretKey: config.stripeSecretKey }),
    billing: new StripeSdkBillingGateway({ secretKey: config.stripeSecretKey }),
  };
  return { deps, close: () => pool.end() };
}
