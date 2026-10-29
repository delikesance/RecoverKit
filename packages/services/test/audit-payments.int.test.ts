import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getCaseByInvoice } from '@recoverkit/db';
import { GatewayError } from '@recoverkit/stripe';
import { createTestDb, type TestDb } from '@recoverkit/testkit';
import { processInbox } from '../src/webhooks/process';
import { runDueSteps } from '../src/engine/send-steps';
import { runPreFinalRetries } from '../src/engine/pre-final';
import { confirmSetup, startSetup } from '../src/payments/pay';
import { makeDeps, type TestDeps } from './helpers';
import { deliver, invoiceObject, setupScenario, type Scenario } from './scenario';

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.dispose();
});
beforeEach(async () => {
  await db.pool.query(`update scheduled_steps set status = 'CANCELED' where status in ('SCHEDULED', 'SENDING')`);
});

let ipCounter = 0;

/** Dossier ouvert, premier email envoyé, SetupIntent terminé avec la carte `pm` (qui réussit). */
async function ready(deps: TestDeps, s: Scenario, pm = 'pm_new') {
  await deliver(deps, s, 'invoice.payment_failed', invoiceObject(s));
  await processInbox(deps);
  deps.clock.advance({ minutes: 90 });
  await runDueSteps(deps);
  const token = deps.mailer.sent.at(-1)!.text.match(/\/pay\/([\w-]{43})/)![1]!;
  const c = (await getCaseByInvoice(db.pool, s.tenantId, s.invoiceId))!;
  const ip = `203.0.114.${++ipCounter}`;
  const start = await startSetup(deps, token, { ip });
  if (start.status !== 'ok') throw new Error('setup');
  deps.stripe.setCardBehavior(pm, 'succeed');
  deps.stripe.completeSetupIntent(s.account, start.setupIntentId, pm);
  return { token, c, ip, setupIntentId: start.setupIntentId };
}

describe('audit : clé d’idempotence et débit unique', () => {
  it('le paiement par lien envoie la clé retry:<dossier>:<moyen de paiement>', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    const { token, c, ip, setupIntentId } = await ready(deps, s);
    expect(await confirmSetup(deps, token, setupIntentId, { ip })).toEqual({ status: 'paid' });
    expect(deps.stripe.idempotencyKeys).toEqual([`retry:${c.id}:pm_new`]);
  });

  it('le retry de la veille du dernier avis envoie la même forme de clé', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    deps.stripe.addCustomer(s.account, { id: s.customerId, email: 'c@example.com', name: 'Camille', locale: 'fr', defaultPaymentMethodId: 'pm_old' });
    deps.stripe.addInvoice(s.account, { id: s.invoiceId, customerId: s.customerId, subscriptionId: s.subscriptionId, status: 'open', amountDue: 2900, amountPaid: 0, currency: 'EUR', attemptCount: 1, failedPaymentMethodId: 'pm_old' });
    await deliver(deps, s, 'invoice.payment_failed', invoiceObject(s));
    await processInbox(deps);
    const c = (await getCaseByInvoice(db.pool, s.tenantId, s.invoiceId))!;
    await deps.stripe.setDefaultPaymentMethod(s.account, { customerId: s.customerId, paymentMethodId: 'pm_new' });
    deps.clock.set(new Date('2026-10-12T12:00:00Z'));
    expect(await runPreFinalRetries(deps)).toEqual({ attempted: 1 });
    expect(deps.stripe.idempotencyKeys).toEqual([`retry:${c.id}:pm_new`]);
  });

  it('réponse Stripe perdue après un débit réussi : le rejeu réutilise la clé, un seul débit', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    const { token, c, ip, setupIntentId } = await ready(deps, s);
    const real = deps.stripe.payInvoice.bind(deps.stripe);
    let lost = true;
    deps.stripe.payInvoice = async (...a: Parameters<typeof real>) => {
      const r = await real(...a); // le débit a bien lieu chez Stripe
      if (lost) {
        lost = false;
        throw new GatewayError('connexion coupée', { kind: 'api', retryable: true });
      }
      return r;
    };
    expect(await confirmSetup(deps, token, setupIntentId, { ip })).toEqual({ status: 'error' });
    expect(deps.stripe.chargeCount(s.invoiceId)).toBe(1);
    // la tentative n'a pas été enregistrée (transaction annulée) : le rejeu repasse par Stripe avec la même clé
    expect(await confirmSetup(deps, token, setupIntentId, { ip })).toEqual({ status: 'paid' });
    expect(deps.stripe.chargeCount(s.invoiceId)).toBe(1);
    expect(new Set(deps.stripe.idempotencyKeys)).toEqual(new Set([`retry:${c.id}:pm_new`]));
    expect(deps.stripe.idempotencyKeys).toHaveLength(2);
    const att = await db.pool.query(`select status from payment_attempts where case_id = $1`, [c.id]);
    expect(att.rows).toEqual([{ status: 'SUCCEEDED' }]);
  });

  it('échec de la base après un débit réussi : le rejeu ne débite pas une seconde fois', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    const { token, c, ip, setupIntentId } = await ready(deps, s);
    // la mise à jour de la tentative échoue une fois (le débit a déjà eu lieu)
    await db.pool.query(`
      create or replace function audit_fail_attempt_update() returns trigger language plpgsql as $$
      begin
        raise exception 'panne simulée après débit';
      end $$`);
    await db.pool.query(`drop trigger if exists audit_fail_attempt on payment_attempts`);
    await db.pool.query(`create trigger audit_fail_attempt before update on payment_attempts for each row execute function audit_fail_attempt_update()`);
    try {
      expect(await confirmSetup(deps, token, setupIntentId, { ip })).toEqual({ status: 'error' });
      expect(deps.stripe.chargeCount(s.invoiceId)).toBe(1);
      const lost = await db.pool.query(`select 1 from payment_attempts where case_id = $1`, [c.id]);
      expect(lost.rowCount).toBe(0); // rien d'enregistré côté base : seule la clé protège
      await db.pool.query(`drop trigger if exists audit_fail_attempt on payment_attempts`); // la base est rétablie

      expect(await confirmSetup(deps, token, setupIntentId, { ip })).toEqual({ status: 'paid' });
      expect(deps.stripe.chargeCount(s.invoiceId)).toBe(1);
      expect(deps.stripe.idempotencyKeys).toEqual([`retry:${c.id}:pm_new`, `retry:${c.id}:pm_new`]);
    } finally {
      await db.pool.query(`drop trigger if exists audit_fail_attempt on payment_attempts`);
    }
  });

  it('une seconde carte donne une autre clé (jamais de collision entre moyens de paiement)', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    const { token, c, ip } = await ready(deps, s, 'pm_first');
    deps.stripe.setCardBehavior('pm_first', 'decline', 'card_declined');
    const first = await startSetup(deps, token, { ip });
    if (first.status !== 'ok') throw new Error('setup');
    deps.stripe.completeSetupIntent(s.account, first.setupIntentId, 'pm_first');
    expect(await confirmSetup(deps, token, first.setupIntentId, { ip })).toMatchObject({ status: 'card_failed' });
    const second = await startSetup(deps, token, { ip });
    if (second.status !== 'ok') throw new Error('setup');
    deps.stripe.setCardBehavior('pm_second', 'succeed');
    deps.stripe.completeSetupIntent(s.account, second.setupIntentId, 'pm_second');
    expect(await confirmSetup(deps, token, second.setupIntentId, { ip })).toEqual({ status: 'paid' });
    expect(deps.stripe.idempotencyKeys).toEqual([`retry:${c.id}:pm_first`, `retry:${c.id}:pm_second`]);
    expect(deps.stripe.chargeCount(s.invoiceId)).toBe(1);
  });
});

describe('audit : facture déjà payée côté Stripe avant la tentative', () => {
  it('aucun second débit n’est émis', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    const { token, ip, setupIntentId } = await ready(deps, s);
    deps.stripe.markPaid(s.account, s.invoiceId, deps.clock.now()); // Smart Retries a encaissé entre-temps
    await confirmSetup(deps, token, setupIntentId, { ip });
    expect(deps.stripe.chargeCount(s.invoiceId)).toBe(0); // aucun débit de notre fait
  });

  // Défaut corrigé (régression) : attemptPayment ne relit pas la facture, Stripe répond 400,
  // confirmSetup renvoie « error » au client qui vient pourtant de payer.
  it('le client qui a déjà payé ne reçoit pas de message d’erreur', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    const { token, ip, setupIntentId } = await ready(deps, s);
    deps.stripe.markPaid(s.account, s.invoiceId, deps.clock.now());
    const r = await confirmSetup(deps, token, setupIntentId, { ip });
    expect(r.status).not.toBe('error');
  });

  // Défaut corrigé (régression) : customer.updated arrivant après un paiement Smart Retries
  // fait lever invalid_request par payInvoice ; l'évènement est rejoué puis finit `dead`.
  it('customer.updated après un paiement Stripe : pas de débit, pas d’évènement mort', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    await deliver(deps, s, 'invoice.payment_failed', invoiceObject(s));
    await processInbox(deps);
    deps.stripe.markPaid(s.account, s.invoiceId, deps.clock.now());
    deps.stripe.setCardBehavior('pm_def', 'succeed');
    const { eventId } = await deliver(
      deps, s, 'customer.updated',
      { id: s.customerId, object: 'customer', invoice_settings: { default_payment_method: 'pm_def' } },
      { previous: { invoice_settings: { default_payment_method: null } } },
    );
    for (let i = 0; i < 6; i++) {
      deps.clock.advance({ hours: 3 });
      await processInbox(deps);
    }
    expect(deps.stripe.chargeCount(s.invoiceId)).toBe(0);
    const row = await db.pool.query(`select status from inbox_events where stripe_event_id = $1`, [eventId]);
    expect(row.rows[0].status).toBe('processed');
  });
});
