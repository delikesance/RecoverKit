import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getCaseByInvoice, listCaseActions } from '@recoverkit/db';
import { createTestDb, type TestDb } from '@recoverkit/testkit';
import { processInbox } from '../src/webhooks/process';
import { runPreFinalRetries } from '../src/engine/pre-final';
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
  await db.pool.query(`update recovery_cases set state = 'CANCELED' where state in ('RECOVERING','PAUSED')`);
});

/** Dossier ouvert alors que la carte par défaut du client est `pm_old` ; dernier avis prévu le 13 oct. à 08:00Z. */
async function open(deps: TestDeps, s: Scenario) {
  deps.stripe.addCustomer(s.account, { id: s.customerId, email: 'c@example.com', name: 'Camille', locale: 'fr', defaultPaymentMethodId: 'pm_old' });
  deps.stripe.addInvoice(s.account, { id: s.invoiceId, customerId: s.customerId, subscriptionId: s.subscriptionId, status: 'open', amountDue: 2900, amountPaid: 0, currency: 'EUR', attemptCount: 1, lastErrorCode: 'card_declined', failedPaymentMethodId: 'pm_old' });
  await deliver(deps, s, 'invoice.payment_failed', invoiceObject(s));
  await processInbox(deps);
  return (await getCaseByInvoice(db.pool, s.tenantId, s.invoiceId))!;
}

describe('retry la veille du dernier avis', () => {
  it('enregistre la carte en échec à l’ouverture du dossier', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    const c = await open(deps, s);
    const rows = await db.pool.query(`select payment_method_id, status, error_code from payment_attempts where case_id = $1`, [c.id]);
    expect(rows.rows).toEqual([{ payment_method_id: 'pm_old', status: 'FAILED', error_code: 'initial_failure' }]);
  });

  it('carte changée depuis l’échec : une seule tentative, journalisée', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    const c = await open(deps, s);
    await deps.stripe.setDefaultPaymentMethod(s.account, { customerId: s.customerId, paymentMethodId: 'pm_new' });
    deps.stripe.setCardBehavior('pm_new', 'succeed');
    deps.clock.set(new Date('2026-10-12T12:00:00Z'));

    expect(await runPreFinalRetries(deps)).toEqual({ attempted: 1 });
    expect(deps.stripe.chargeCount(s.invoiceId)).toBe(1);
    expect((await listCaseActions(db.pool, s.tenantId, c.id)).map((a) => a.action)).toContain('retry.pre_final');
    expect(await runPreFinalRetries(deps)).toEqual({ attempted: 0 });
    expect(deps.stripe.chargeCount(s.invoiceId)).toBe(1);
  });

  it('dossier clôturé manuellement entre la sélection et le paiement : la carte n’est pas débitée', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    const c = await open(deps, s);
    await deps.stripe.setDefaultPaymentMethod(s.account, { customerId: s.customerId, paymentMethodId: 'pm_new' });
    deps.stripe.setCardBehavior('pm_new', 'succeed');
    deps.clock.set(new Date('2026-10-12T12:00:00Z'));
    const real = deps.stripe.retrieveCustomer.bind(deps.stripe);
    deps.stripe.retrieveCustomer = async (...a: Parameters<typeof real>) => {
      const cu = await real(...a);
      await db.pool.query(`update recovery_cases set state = 'CLOSED_MANUAL' where id = $1`, [c.id]);
      return cu;
    };
    expect(await runPreFinalRetries(deps)).toEqual({ attempted: 0 });
    expect(deps.stripe.chargeCount(s.invoiceId)).toBe(0);
  });

  it('même carte que celle en échec : aucun retry', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    await open(deps, s);
    deps.clock.set(new Date('2026-10-12T12:00:00Z'));
    expect(await runPreFinalRetries(deps)).toEqual({ attempted: 0 });
    expect(deps.stripe.chargeCount(s.invoiceId)).toBe(0);
  });

  it('hors de la fenêtre de 24 h avant le dernier avis : aucun retry', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    await open(deps, s);
    await deps.stripe.setDefaultPaymentMethod(s.account, { customerId: s.customerId, paymentMethodId: 'pm_new' });
    deps.clock.set(new Date('2026-10-10T12:00:00Z'));
    expect(await runPreFinalRetries(deps)).toEqual({ attempted: 0 });
  });

  it('sans carte par défaut, en pause ou en dry-run : aucun retry', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    const c = await open(deps, s);
    deps.stripe.addCustomer(s.account, { id: s.customerId, email: 'c@example.com', name: 'C', locale: 'fr', defaultPaymentMethodId: null });
    deps.clock.set(new Date('2026-10-12T12:00:00Z'));
    expect(await runPreFinalRetries(deps)).toEqual({ attempted: 0 });

    await deps.stripe.setDefaultPaymentMethod(s.account, { customerId: s.customerId, paymentMethodId: 'pm_new' });
    await db.pool.query(`update recovery_cases set state = 'PAUSED' where id = $1`, [c.id]);
    expect(await runPreFinalRetries(deps)).toEqual({ attempted: 0 });

    await db.pool.query(`update recovery_cases set state = 'RECOVERING' where id = $1`, [c.id]);
    await db.pool.query(`update tenants set dry_run = true where id = $1`, [s.tenantId]);
    expect(await runPreFinalRetries(deps)).toEqual({ attempted: 0 });
    expect(deps.stripe.chargeCount(s.invoiceId)).toBe(0);
  });

  it('carte refusée : tentative FAILED enregistrée, jamais réessayée', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    const c = await open(deps, s);
    await deps.stripe.setDefaultPaymentMethod(s.account, { customerId: s.customerId, paymentMethodId: 'pm_bad' });
    deps.stripe.setCardBehavior('pm_bad', 'decline', 'insufficient_funds');
    deps.clock.set(new Date('2026-10-12T12:00:00Z'));
    expect(await runPreFinalRetries(deps)).toEqual({ attempted: 1 });
    const att = await db.pool.query(`select status, error_code from payment_attempts where case_id = $1 and payment_method_id = 'pm_bad'`, [c.id]);
    expect(att.rows[0]).toEqual({ status: 'FAILED', error_code: 'insufficient_funds' });
    expect(await runPreFinalRetries(deps)).toEqual({ attempted: 0 });
  });
});
