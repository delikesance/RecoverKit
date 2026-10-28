import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getCaseByInvoice, listLedger } from '@recoverkit/db';
import { createTestDb, type TestDb } from '@recoverkit/testkit';
import { processInbox } from '../src/webhooks/process';
import { reconcileAll, reconcileTenant } from '../src/ops/reconcile';
import { getHealthDetails } from '../src/ops/health';
import { makeDeps } from './helpers';
import { deliver, invoiceObject, setupScenario } from './scenario';

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.dispose();
});

describe('réconciliation avec Stripe', () => {
  it('ouvre un dossier pour une facture impayée dont le webhook a été perdu', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    deps.stripe.addInvoice(s.account, { id: s.invoiceId, customerId: s.customerId, subscriptionId: s.subscriptionId, status: 'open', amountDue: 2900, amountPaid: 0, currency: 'EUR', attemptCount: 2 });
    expect(await reconcileTenant(deps, s.tenantId)).toEqual({ opened: 1, closed: 0 });
    await processInbox(deps);
    expect((await getCaseByInvoice(db.pool, s.tenantId, s.invoiceId))!.state).toBe('RECOVERING');
    // idempotent : un second passage ne refait rien
    expect(await reconcileTenant(deps, s.tenantId)).toEqual({ opened: 0, closed: 0 });
  });

  it('ignore les factures sans tentative de paiement, ponctuelles ou déjà suivies', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    deps.stripe.addInvoice(s.account, { id: 'in_upcoming', customerId: s.customerId, subscriptionId: s.subscriptionId, status: 'open', amountDue: 2900, amountPaid: 0, currency: 'EUR', attemptCount: 0 });
    deps.stripe.addInvoice(s.account, { id: 'in_oneoff', customerId: s.customerId, subscriptionId: null, status: 'open', amountDue: 2900, amountPaid: 0, currency: 'EUR', attemptCount: 3 });
    // la facture du scénario (tentative 1) est déjà suivie par un dossier
    await deliver(deps, s, 'invoice.payment_failed', invoiceObject(s));
    await processInbox(deps);
    expect(await reconcileTenant(deps, s.tenantId)).toEqual({ opened: 0, closed: 0 });
  });

  it('clôture les dossiers dont la facture a été payée ou annulée sans que l’on ait reçu l’événement', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    await deliver(deps, s, 'invoice.payment_failed', invoiceObject(s));
    await processInbox(deps);
    deps.stripe.markPaid(s.account, s.invoiceId);
    expect(await reconcileTenant(deps, s.tenantId)).toEqual({ opened: 0, closed: 1 });
    await processInbox(deps);
    expect((await getCaseByInvoice(db.pool, s.tenantId, s.invoiceId))!.state).toBe('RECOVERED');
    expect(await listLedger(db.pool, s.tenantId)).toHaveLength(1);

    const s2 = await setupScenario(db, deps);
    await deliver(deps, s2, 'invoice.payment_failed', invoiceObject(s2));
    await processInbox(deps);
    deps.stripe.addInvoice(s2.account, { id: s2.invoiceId, customerId: s2.customerId, subscriptionId: s2.subscriptionId, status: 'void', amountDue: 2900, amountPaid: 0, currency: 'EUR', attemptCount: 1 });
    expect(await reconcileTenant(deps, s2.tenantId)).toEqual({ opened: 0, closed: 1 });
    await processInbox(deps);
    expect((await getCaseByInvoice(db.pool, s2.tenantId, s2.invoiceId))!.state).toBe('CANCELED');
  });

  it('reconcileAll parcourt les tenants actifs et survit à la panne de l’un d’eux', async () => {
    const deps = makeDeps(db);
    const a = await setupScenario(db, deps);
    const b = await setupScenario(db, deps);
    deps.stripe.addInvoice(b.account, { id: b.invoiceId, customerId: b.customerId, subscriptionId: b.subscriptionId, status: 'open', amountDue: 2900, amountPaid: 0, currency: 'EUR', attemptCount: 2 });
    const original = deps.stripe.listOpenInvoices.bind(deps.stripe);
    deps.stripe.listOpenInvoices = async (account: string) => {
      if (account === a.account) throw new Error('Stripe indisponible pour ce compte');
      return original(account);
    };
    const r = await reconcileAll(deps);
    expect(r.failed).toBeGreaterThanOrEqual(1);
    expect(r.opened).toBeGreaterThanOrEqual(1);
  });

  it('ignore les tenants sans connexion active ou suspendus', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    await db.pool.query(`update stripe_connections set status = 'REVOKED' where tenant_id = $1`, [s.tenantId]);
    expect(await reconcileTenant(deps, s.tenantId)).toEqual({ opened: 0, closed: 0 });
  });
});

describe('indicateurs de santé', () => {
  it('rapporte la file des webhooks, des envois et des alertes', async () => {
    const deps = makeDeps(db, new Date('2026-10-28T10:00:00Z'));
    const s = await setupScenario(db, deps);
    await db.pool.query(
      `insert into inbox_events (stripe_event_id, stripe_account_id, tenant_id, type, payload, status, received_at, next_attempt_at) values
        ('evt_h1', $1, $2, 'invoice.paid', '{}', 'pending', $3, $3),
        ('evt_h2', $1, $2, 'invoice.paid', '{}', 'dead', $3, $3)`,
      [s.account, s.tenantId, new Date('2026-10-28T09:50:00Z')],
    );
    await db.pool.query(`insert into system_alerts (tenant_id, kind, dedupe_key, message) values ($1,'email_failed','h1','x')`, [s.tenantId]);
    const h = await getHealthDetails(deps);
    expect(h.db).toBe('ok');
    expect(h.inbox.pending).toBeGreaterThanOrEqual(1);
    expect(h.inbox.dead).toBeGreaterThanOrEqual(1);
    expect(h.inbox.oldestPendingAgeSeconds).toBeGreaterThanOrEqual(600);
    expect(h.alerts.open).toBeGreaterThanOrEqual(1);
    expect(h.steps).toMatchObject({ overdue: expect.any(Number), sending: expect.any(Number) });
    expect(h.emails).toMatchObject({ sent24h: expect.any(Number), failed24h: expect.any(Number) });
    expect(h.status).toBe('degraded'); // un événement mort => dégradé
  });
});
