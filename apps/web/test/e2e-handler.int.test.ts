import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, seedTenant, type TestDb } from '@recoverkit/testkit';
import { makeDeps, type TestDeps } from '@recoverkit/services/testing';
import { handleE2E } from '../src/server/handlers/e2e';
import type { WebRuntime } from '../src/server/runtime';

let db: TestDb;
let deps: TestDeps;
let rt: WebRuntime;
const env = { RECOVERKIT_E2E: '1', E2E_TOKEN: 'tok' };

beforeAll(async () => {
  db = await createTestDb();
  deps = makeDeps(db, new Date('2026-10-28T10:00:00Z'));
  rt = { deps, close: async () => {}, e2e: { clock: deps.clock, mailer: deps.mailer, stripe: deps.stripe, domains: deps.domains, billing: deps.billing } };
});
afterAll(async () => {
  await db.dispose();
});

const call = (action: string, body?: unknown, o: { method?: string; token?: string | null; env?: Record<string, string> } = {}) =>
  handleE2E(
    rt,
    new Request(`https://app.recoverkit.test/api/e2e/${action}`, {
      method: o.method ?? (body === undefined ? 'GET' : 'POST'),
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: { 'content-type': 'application/json', ...(o.token === null ? {} : { 'x-e2e-token': o.token ?? 'tok' }) },
    }),
    action,
    o.env ?? env,
  );

describe('routes E2E', () => {
  it('404 hors mode E2E ou sans jeton', async () => {
    expect((await call('mailbox', undefined, { env: {} })).status).toBe(404);
    expect((await call('mailbox', undefined, { token: null })).status).toBe(404);
    expect((await call('mailbox', undefined, { token: 'faux' })).status).toBe(404);
  });

  it('404 pour une action inconnue ; 404 quand le runtime n’a pas de contrôles E2E', async () => {
    expect((await call('nimporte-quoi')).status).toBe(404);
    const prod = { ...rt, e2e: null };
    const r = await handleE2E(prod, new Request('https://x/api/e2e/mailbox', { headers: { 'x-e2e-token': 'tok' } }), 'mailbox', env);
    expect(r.status).toBe(404);
  });

  it('boîte mail : liste les emails envoyés', async () => {
    await deps.mailer.send({ to: 'a@example.com', from: { name: 'N', email: 'n@example.com' }, subject: 'Sujet', html: '<p>x</p>', text: 'corps', idempotencyKey: 'k1' });
    const body = await (await call('mailbox')).json();
    expect(body.emails.at(-1)).toMatchObject({ to: 'a@example.com', subject: 'Sujet', text: 'corps' });
  });

  it('horloge : lecture, avance, réglage', async () => {
    expect(await (await call('clock')).json()).toEqual({ now: '2026-10-28T10:00:00.000Z' });
    expect(await (await call('clock', { advanceMinutes: 90 })).json()).toEqual({ now: '2026-10-28T11:30:00.000Z' });
    expect(await (await call('clock', { set: '2026-11-02T08:00:00Z' })).json()).toEqual({ now: '2026-11-02T08:00:00.000Z' });
    expect((await call('clock', { set: 'pas une date' })).status).toBe(400);
  });

  it('événement Stripe signé : livré dans l’inbox du bon tenant', async () => {
    const t = await seedTenant(db.pool);
    await db.pool.query(`insert into stripe_connections (tenant_id, stripe_account_id, status) values ($1,'acct_e2e','ACTIVE')`, [t.id]);
    const r = await call('events', { account: 'acct_e2e', type: 'invoice.paid', object: { id: 'in_e2e' } });
    expect(r.status).toBe(200);
    const { eventId } = await r.json();
    const row = await db.pool.query(`select status, tenant_id from inbox_events where stripe_event_id = $1`, [eventId]);
    expect(row.rows[0]).toEqual({ status: 'pending', tenant_id: t.id });
  });

  it('worker : traite l’inbox et les envois dus', async () => {
    const r = await call('worker', {});
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ inbox: { processed: expect.any(Number) }, steps: { sent: expect.any(Number) } });
  });

  it('pilotage de Stripe factice : client, abonnement, facture, carte, OAuth', async () => {
    const ops = [
      { op: 'addCustomer', account: 'acct_e2e', customer: { id: 'cus_e', email: 'c@example.com', name: 'C', locale: 'fr', defaultPaymentMethodId: null } },
      { op: 'addSubscription', account: 'acct_e2e', subscription: { id: 'sub_e', customerId: 'cus_e', status: 'past_due', planName: 'Pro', amount: 2900, currency: 'EUR', interval: 'month' } },
      { op: 'addInvoice', account: 'acct_e2e', invoice: { id: 'in_e', customerId: 'cus_e', subscriptionId: 'sub_e', status: 'open', amountDue: 2900, amountPaid: 0, currency: 'EUR', attemptCount: 1, planName: 'Pro' } },
      { op: 'setCardBehavior', paymentMethodId: 'pm_ok', behavior: 'succeed' },
      { op: 'setOAuthCode', code: 'code_e2e', stripeUserId: 'acct_e2e', livemode: false },
    ];
    for (const o of ops) expect((await call('stripe', o)).status, o.op).toBe(200);
    expect((await deps.stripe.retrieveInvoice('acct_e2e', 'in_e')).amountDue).toBe(2900);
    expect(await deps.stripe.exchangeOAuthCode('code_e2e')).toEqual({ stripeUserId: 'acct_e2e', livemode: false });
    expect((await call('stripe', { op: 'markPaid', account: 'acct_e2e', invoiceId: 'in_e' })).status).toBe(200);
    expect((await deps.stripe.retrieveInvoice('acct_e2e', 'in_e')).status).toBe('paid');
    expect((await call('stripe', { op: 'inconnue' })).status).toBe(400);
  });

  it('carte factice : termine le SetupIntent pour le formulaire de test', async () => {
    const si = await deps.stripe.createSetupIntent('acct_e2e', { customerId: 'cus_e', idempotencyKey: 'x' });
    const r = await call('fake-card', { account: 'acct_e2e', setupIntentId: si.id, paymentMethodId: 'pm_fake', behavior: 'decline', code: 'insufficient_funds' });
    expect(r.status).toBe(200);
    expect((await deps.stripe.retrieveSetupIntent('acct_e2e', si.id)).status).toBe('succeeded');
  });
});
