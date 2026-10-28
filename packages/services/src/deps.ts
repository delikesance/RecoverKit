import type { Pool } from 'pg';
import type { Clock } from '@recoverkit/core';
import type { DomainProvider, Mailer } from '@recoverkit/mail';
import type { BillingGateway, StripeGateway } from '@recoverkit/stripe';
import type { AppConfig } from './config';
import type { Logger } from './logger';

/** Dépendances injectées : tout effet externe passe par une interface fakeable. */
export interface Deps {
  pool: Pool;
  clock: Clock;
  mailer: Mailer;
  domains: DomainProvider;
  stripe: StripeGateway;
  billing: BillingGateway;
  config: AppConfig;
  log: Logger;
}
