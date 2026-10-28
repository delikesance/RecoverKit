import { DEFAULT_SEQUENCE } from '@recoverkit/core';
import { seedTenant, signStripePayload, stripeEvent, type TestDb } from '@recoverkit/testkit';
import { receiveStripeWebhook } from '../src/webhooks/receive';
import { TEST_ENV, type TestDeps } from './helpers';

let counter = 0;

export interface Scenario {
  tenantId: string;
  account: string;
  customerId: string;
  subscriptionId: string;
  invoiceId: string;
}

/** Tenant relié à Stripe + client, abonnement et facture impayée côté FakeStripe. */
export async function setupScenario(
  db: TestDb,
  deps: TestDeps,
  o: Partial<{ dryRun: boolean; email: string | null; emailsEnabled: boolean; amountDue: number; subscription: boolean }> = {},
): Promise<Scenario> {
  const n = ++counter;
  const account = `acct_s${n}`;
  const customerId = `cus_s${n}`;
  const subscriptionId = `sub_s${n}`;
  const invoiceId = `in_s${n}`;
  const tenant = await seedTenant(db.pool, { dryRun: o.dryRun ?? false, emailsEnabled: o.emailsEnabled ?? true });
  await db.pool.query(`insert into stripe_connections (tenant_id, stripe_account_id, status) values ($1,$2,'ACTIVE')`, [
    tenant.id,
    account,
  ]);
  await db.pool.query(`insert into sequences (tenant_id, version, steps) values ($1, 1, $2::jsonb)`, [
    tenant.id,
    JSON.stringify(DEFAULT_SEQUENCE),
  ]);
  deps.stripe.addCustomer(account, {
    id: customerId,
    email: o.email === undefined ? `client${n}@example.com` : o.email,
    name: 'Camille Roux',
    locale: 'fr',
    defaultPaymentMethodId: null,
  });
  deps.stripe.addSubscription(account, {
    id: subscriptionId,
    customerId,
    status: 'past_due',
    planName: 'Pro',
    amount: o.amountDue ?? 2900,
    currency: 'EUR',
    interval: 'month',
  });
  deps.stripe.addInvoice(account, {
    id: invoiceId,
    customerId,
    subscriptionId: o.subscription === false ? null : subscriptionId,
    status: 'open',
    amountDue: o.amountDue ?? 2900,
    amountPaid: 0,
    currency: 'EUR',
    attemptCount: 1,
    planName: 'Pro',
    lastErrorCode: 'card_declined',
  });
  return { tenantId: tenant.id, account, customerId, subscriptionId, invoiceId };
}

export function invoiceObject(s: Scenario, over: Record<string, unknown> = {}) {
  return {
    id: s.invoiceId,
    object: 'invoice',
    customer: s.customerId,
    subscription: s.subscriptionId,
    status: 'open',
    amount_due: 2900,
    amount_paid: 0,
    currency: 'eur',
    attempt_count: 1,
    ...over,
  };
}

export async function deliver(
  deps: TestDeps,
  s: Scenario,
  type: string,
  object: Record<string, unknown>,
  o: { id?: string; previous?: Record<string, unknown> } = {},
) {
  const evt = stripeEvent(type, object, { account: s.account, id: o.id, created: deps.clock.now(), previousAttributes: o.previous });
  const raw = JSON.stringify(evt);
  const res = await receiveStripeWebhook(deps, { rawBody: raw, signature: signStripePayload(raw, TEST_ENV.STRIPE_CONNECT_WEBHOOK_SECRET, deps.clock.now()) });
  return { eventId: evt.id, res };
}

export async function insertSentEmail(
  db: TestDb,
  s: Scenario,
  caseId: string,
  o: { stepIndex?: number; sentAt: Date; dryRun?: boolean; status?: string },
) {
  await db.pool.query(
    `insert into email_messages (tenant_id, case_id, step_index, idempotency_key, to_email, subject, status, dry_run, sent_at)
     values ($1,$2,$3,$4,'x@example.com','s',$5,$6,$7)`,
    [s.tenantId, caseId, o.stepIndex ?? 0, `${caseId}:${o.stepIndex ?? 0}`, o.status ?? 'SENT', o.dryRun ?? false, o.sentAt],
  );
}
