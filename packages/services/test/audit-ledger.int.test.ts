import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getCaseByInvoice } from '@recoverkit/db';
import { createTestDb, type TestDb } from '@recoverkit/testkit';
import { processInbox } from '../src/webhooks/process';
import { makeDeps } from './helpers';
import { deliver, invoiceObject, setupScenario } from './scenario';

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.dispose();
});

const ledger = async (tenantId: string) =>
  (await db.pool.query(`select kind, amount, currency from recovery_ledger where tenant_id = $1 order by id`, [tenantId])).rows;

describe('audit : le ledger enregistre le montant réellement encaissé (amount_paid), pas amount_due', () => {
  it('facture de 29,00 € payée 20,00 € (avoir, remise) : 2000 au ledger', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    await deliver(deps, s, 'invoice.payment_failed', invoiceObject(s));
    await processInbox(deps);
    deps.stripe.addInvoice(s.account, {
      id: s.invoiceId, customerId: s.customerId, subscriptionId: s.subscriptionId, status: 'paid',
      amountDue: 2900, amountPaid: 2000, currency: 'EUR', attemptCount: 2, paidAt: deps.clock.now(),
    });
    // le contenu de l'évènement annonce 2900 : seule la valeur lue chez Stripe fait foi
    await deliver(deps, s, 'invoice.paid', invoiceObject(s, { status: 'paid', amount_due: 2900, amount_paid: 2900 }));
    await processInbox(deps);
    expect(await ledger(s.tenantId)).toEqual([{ kind: 'RECOVERY', amount: 2000, currency: 'EUR' }]);
    expect((await getCaseByInvoice(db.pool, s.tenantId, s.invoiceId))!.state).toBe('RECOVERED');
  });

  it('facture payée 0 € (avoir intégral) : dossier clos, aucune ligne de revenu', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    await deliver(deps, s, 'invoice.payment_failed', invoiceObject(s));
    await processInbox(deps);
    deps.stripe.addInvoice(s.account, {
      id: s.invoiceId, customerId: s.customerId, subscriptionId: s.subscriptionId, status: 'paid',
      amountDue: 2900, amountPaid: 0, currency: 'EUR', attemptCount: 2, paidAt: deps.clock.now(),
    });
    await deliver(deps, s, 'invoice.paid', invoiceObject(s, { status: 'paid', amount_paid: 2900 }));
    await processInbox(deps);
    expect(await ledger(s.tenantId)).toEqual([]);
  });

  it('paiement partiel puis remboursement : l’ajustement part du montant encaissé', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    await deliver(deps, s, 'invoice.payment_failed', invoiceObject(s));
    await processInbox(deps);
    deps.stripe.addInvoice(s.account, {
      id: s.invoiceId, customerId: s.customerId, subscriptionId: s.subscriptionId, status: 'paid',
      amountDue: 2900, amountPaid: 2000, currency: 'EUR', attemptCount: 2, paidAt: deps.clock.now(),
    });
    await deliver(deps, s, 'invoice.paid', invoiceObject(s, { status: 'paid', amount_paid: 2000 }));
    await deliver(deps, s, 'charge.refunded', { id: 'ch_l', object: 'charge', invoice: s.invoiceId, amount: 2000, amount_refunded: 2000, currency: 'eur' });
    await processInbox(deps);
    const rows = await ledger(s.tenantId);
    expect(rows.map((r) => r.amount)).toEqual([2000, -2000]);
    expect(rows.reduce((a, r) => a + r.amount, 0)).toBe(0);
  });
});
