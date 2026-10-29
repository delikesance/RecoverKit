import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getCaseByInvoice, listCaseActions, listLedger, listStepsForCase } from '@recoverkit/db';
import { createTestDb, type TestDb } from '@recoverkit/testkit';
import { reconcileInBackground } from '../src/stripe/connect';
import { processInbox, replayDeadEvent } from '../src/webhooks/process';
import { makeDeps, type TestDeps } from './helpers';
import { deliver, insertSentEmail, invoiceObject, setupScenario, type Scenario } from './scenario';
import { GatewayError } from '@recoverkit/stripe';

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.dispose();
});

const inbox = async (eventId: string) =>
  (await db.pool.query(`select status, attempts, next_attempt_at, last_error from inbox_events where stripe_event_id = $1`, [eventId])).rows[0];

async function failAndGetCase(deps: TestDeps, s: Scenario) {
  await deliver(deps, s, 'invoice.payment_failed', invoiceObject(s));
  await processInbox(deps);
  const c = await getCaseByInvoice(db.pool, s.tenantId, s.invoiceId);
  if (!c) throw new Error('dossier attendu');
  return c;
}

describe('invoice.payment_failed', () => {
  it('crée le dossier RECOVERING, planifie les 4 étapes, journalise', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    const { eventId } = await deliver(deps, s, 'invoice.payment_failed', invoiceObject(s));
    const stats = await processInbox(deps);
    expect(stats.processed).toBe(1);

    const c = await getCaseByInvoice(db.pool, s.tenantId, s.invoiceId);
    expect(c).toMatchObject({
      state: 'RECOVERING', amountDue: 2900, currency: 'EUR', attemptCount: 1, sequenceVersion: 1,
      stripeCustomerId: s.customerId, planName: 'Pro',
    });
    const steps = await listStepsForCase(db.pool, s.tenantId, c!.id);
    expect(steps.map((x) => x.dueAt.toISOString())).toEqual([
      '2026-10-01T09:00:00.000Z',
      '2026-10-04T08:00:00.000Z',
      '2026-10-08T08:00:00.000Z',
      '2026-10-13T08:00:00.000Z',
    ]);
    expect(steps.every((x) => x.status === 'SCHEDULED')).toBe(true);
    const actions = (await listCaseActions(db.pool, s.tenantId, c!.id)).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['case.opened', 'steps.scheduled']));
    expect((await inbox(eventId)).status).toBe('processed');

    const cust = await db.pool.query(`select email, name, locale from end_customers where tenant_id = $1`, [s.tenantId]);
    expect(cust.rows[0]).toMatchObject({ email: expect.stringContaining('@example.com'), name: 'Camille Roux', locale: 'fr' });
  });

  it('un échec répété (nouvel événement, même facture) met à jour la tentative sans replanifier', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    const c = await failAndGetCase(deps, s);
    const before = await listStepsForCase(db.pool, s.tenantId, c.id);

    deps.clock.advance({ hours: 2 });
    deps.stripe.addInvoice(s.account, { id: s.invoiceId, customerId: s.customerId, subscriptionId: s.subscriptionId, status: 'open', amountDue: 2900, amountPaid: 0, currency: 'EUR', attemptCount: 2, lastErrorCode: 'insufficient_funds' });
    await deliver(deps, s, 'invoice.payment_failed', invoiceObject(s, { attempt_count: 2 }));
    await processInbox(deps);

    const after = await getCaseByInvoice(db.pool, s.tenantId, s.invoiceId);
    expect(after).toMatchObject({ attemptCount: 2, state: 'RECOVERING' });
    expect(await listStepsForCase(db.pool, s.tenantId, c.id)).toEqual(before);
    const n = await db.pool.query(`select count(*)::int n from recovery_cases where tenant_id = $1`, [s.tenantId]);
    expect(n.rows[0].n).toBe(1);
  });

  it('facture déjà payée côté Stripe (événement en retard) : aucun dossier', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    deps.stripe.markPaid(s.account, s.invoiceId);
    await deliver(deps, s, 'invoice.payment_failed', invoiceObject(s));
    await processInbox(deps);
    expect(await getCaseByInvoice(db.pool, s.tenantId, s.invoiceId)).toBeNull();
  });

  it('facture hors abonnement : ignorée (D4)', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps, { subscription: false });
    const { eventId } = await deliver(deps, s, 'invoice.payment_failed', invoiceObject(s, { subscription: null }));
    await processInbox(deps);
    expect(await getCaseByInvoice(db.pool, s.tenantId, s.invoiceId)).toBeNull();
    expect((await inbox(eventId)).status).toBe('processed');
  });

  it('client sans email : dossier OPEN, aucune étape, alerte', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps, { email: null });
    await deliver(deps, s, 'invoice.payment_failed', invoiceObject(s));
    await processInbox(deps);
    const c = await getCaseByInvoice(db.pool, s.tenantId, s.invoiceId);
    expect(c!.state).toBe('OPEN');
    expect(await listStepsForCase(db.pool, s.tenantId, c!.id)).toHaveLength(0);
    const alerts = await db.pool.query(`select kind from system_alerts where tenant_id = $1`, [s.tenantId]);
    expect(alerts.rows.map((r) => r.kind)).toContain('customer_email_missing');
  });

  it('les étapes de séquence inactives ne sont pas planifiées', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    await db.pool.query(
      `update sequences set steps = $2::jsonb where tenant_id = $1`,
      [s.tenantId, JSON.stringify([{ index: 0, delayMinutes: 60, active: true }, { index: 1, delayMinutes: 4320, active: false }])],
    );
    const c = await failAndGetCase(deps, s);
    expect((await listStepsForCase(db.pool, s.tenantId, c.id)).map((x) => x.stepIndex)).toEqual([0]);
  });
});

describe('invoice.paid et attribution', () => {
  it('payé après un email : RECOVERED, étapes annulées, ledger ASSISTED au montant encaissé', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    const c = await failAndGetCase(deps, s);
    await insertSentEmail(db, s, c.id, { sentAt: new Date('2026-10-01T09:05:00Z') });
    await db.pool.query(`insert into payment_tokens (case_id, tenant_id, token_hash, expires_at) values ($1,$2,$3,$4)`, [c.id, s.tenantId, 'f'.repeat(64), new Date('2026-10-15T00:00:00Z')]);

    deps.clock.advance({ days: 1 });
    deps.stripe.markPaid(s.account, s.invoiceId, deps.clock.now());
    await deliver(deps, s, 'invoice.paid', invoiceObject(s, { status: 'paid', amount_paid: 2900 }));
    await processInbox(deps);

    const after = await getCaseByInvoice(db.pool, s.tenantId, s.invoiceId);
    expect(after).toMatchObject({ state: 'RECOVERED' });
    expect(after!.closedAt).not.toBeNull();
    const steps = await listStepsForCase(db.pool, s.tenantId, c.id);
    expect(steps.every((x) => x.status === 'CANCELED')).toBe(true);
    const ledger = await listLedger(db.pool, s.tenantId);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ kind: 'RECOVERY', attribution: 'ASSISTED', amount: 2900, currency: 'EUR', invoiceId: s.invoiceId });
    const tok = await db.pool.query(`select revoked_at from payment_tokens where case_id = $1`, [c.id]);
    expect(tok.rows[0].revoked_at).not.toBeNull();
  });

  it('payé avant tout email : NATURAL', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    await failAndGetCase(deps, s);
    deps.stripe.markPaid(s.account, s.invoiceId, deps.clock.now());
    await deliver(deps, s, 'invoice.paid', invoiceObject(s, { status: 'paid', amount_paid: 2900 }));
    await processInbox(deps);
    const ledger = await listLedger(db.pool, s.tenantId);
    expect(ledger[0]).toMatchObject({ attribution: 'NATURAL', amount: 2900 });
  });

  it('un email en dry-run ou échoué ne rend pas le paiement ASSISTED', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    const c = await failAndGetCase(deps, s);
    await insertSentEmail(db, s, c.id, { stepIndex: 0, sentAt: new Date('2026-10-01T09:05:00Z'), dryRun: true });
    deps.clock.advance({ days: 1 });
    deps.stripe.markPaid(s.account, s.invoiceId, deps.clock.now());
    await deliver(deps, s, 'invoice.paid', invoiceObject(s, { status: 'paid', amount_paid: 2900 }));
    await processInbox(deps);
    expect((await listLedger(db.pool, s.tenantId))[0]!.attribution).toBe('NATURAL');
  });

  it('invoice.paid puis invoice.payment_succeeded : une seule écriture au ledger', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    await failAndGetCase(deps, s);
    deps.stripe.markPaid(s.account, s.invoiceId, deps.clock.now());
    await deliver(deps, s, 'invoice.paid', invoiceObject(s, { status: 'paid', amount_paid: 2900 }));
    await deliver(deps, s, 'invoice.payment_succeeded', invoiceObject(s, { status: 'paid', amount_paid: 2900 }));
    await processInbox(deps);
    expect(await listLedger(db.pool, s.tenantId)).toHaveLength(1);
  });

  it('paiement d’une facture sans dossier : ignoré', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    deps.stripe.markPaid(s.account, s.invoiceId);
    const { eventId } = await deliver(deps, s, 'invoice.paid', invoiceObject(s, { status: 'paid', amount_paid: 2900 }));
    await processInbox(deps);
    expect(await listLedger(db.pool, s.tenantId)).toHaveLength(0);
    expect((await inbox(eventId)).status).toBe('processed');
  });

  it('événement invoice.paid obsolète (Stripe dit encore impayée) : dossier inchangé', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    const c = await failAndGetCase(deps, s);
    await deliver(deps, s, 'invoice.paid', invoiceObject(s, { status: 'paid', amount_paid: 2900 }));
    await processInbox(deps);
    expect((await getCaseByInvoice(db.pool, s.tenantId, s.invoiceId))!.state).toBe('RECOVERING');
    expect(await listLedger(db.pool, s.tenantId)).toHaveLength(0);
    expect(c.state).toBe('RECOVERING');
  });

  it('un dossier en pause est aussi clôturé par le paiement', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    const c = await failAndGetCase(deps, s);
    await db.pool.query(`update recovery_cases set state = 'PAUSED' where id = $1`, [c.id]);
    deps.stripe.markPaid(s.account, s.invoiceId);
    await deliver(deps, s, 'invoice.paid', invoiceObject(s, { status: 'paid', amount_paid: 2900 }));
    await processInbox(deps);
    expect((await getCaseByInvoice(db.pool, s.tenantId, s.invoiceId))!.state).toBe('RECOVERED');
  });
});

describe('annulations', () => {
  it.each([
    ['invoice.voided', 'void'],
    ['invoice.marked_uncollectible', 'uncollectible'],
  ])('%s : dossier CANCELED, étapes annulées', async (type, status) => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    const c = await failAndGetCase(deps, s);
    await deliver(deps, s, type, invoiceObject(s, { status }));
    await processInbox(deps);
    expect((await getCaseByInvoice(db.pool, s.tenantId, s.invoiceId))!.state).toBe('CANCELED');
    expect((await listStepsForCase(db.pool, s.tenantId, c.id)).every((x) => x.status === 'CANCELED')).toBe(true);
  });

  it('customer.subscription.deleted : dossiers de l’abonnement CANCELED', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    await failAndGetCase(deps, s);
    await deliver(deps, s, 'customer.subscription.deleted', { id: s.subscriptionId, object: 'subscription', customer: s.customerId, status: 'canceled' });
    await processInbox(deps);
    expect((await getCaseByInvoice(db.pool, s.tenantId, s.invoiceId))!.state).toBe('CANCELED');
  });

  it('customer.subscription.updated vers active avec facture payée : RECOVERED', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    await failAndGetCase(deps, s);
    deps.stripe.markPaid(s.account, s.invoiceId);
    await deliver(deps, s, 'customer.subscription.updated', { id: s.subscriptionId, object: 'subscription', customer: s.customerId, status: 'active' });
    await processInbox(deps);
    expect((await getCaseByInvoice(db.pool, s.tenantId, s.invoiceId))!.state).toBe('RECOVERED');
    expect(await listLedger(db.pool, s.tenantId)).toHaveLength(1);
  });

  it('customer.subscription.updated vers active mais facture impayée : rien ne change', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    await failAndGetCase(deps, s);
    await deliver(deps, s, 'customer.subscription.updated', { id: s.subscriptionId, object: 'subscription', customer: s.customerId, status: 'active' });
    await processInbox(deps);
    expect((await getCaseByInvoice(db.pool, s.tenantId, s.invoiceId))!.state).toBe('RECOVERING');
  });

  it('un dossier terminal n’est jamais rouvert par un nouvel échec', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    await failAndGetCase(deps, s);
    deps.stripe.markPaid(s.account, s.invoiceId);
    await deliver(deps, s, 'invoice.paid', invoiceObject(s, { status: 'paid', amount_paid: 2900 }));
    await processInbox(deps);
    await deliver(deps, s, 'invoice.payment_failed', invoiceObject(s));
    await processInbox(deps);
    expect((await getCaseByInvoice(db.pool, s.tenantId, s.invoiceId))!.state).toBe('RECOVERED');
  });
});

describe('retry anticipé quand la carte change', () => {
  it('setup_intent.succeeded : une tentative de paiement, jamais deux (même carte)', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    const c0 = await failAndGetCase(deps, s);
    deps.stripe.setCardBehavior('pm_new', 'succeed');
    await deliver(deps, s, 'setup_intent.succeeded', { id: 'seti_1', object: 'setup_intent', customer: s.customerId, payment_method: 'pm_new' });
    await deliver(deps, s, 'payment_method.attached', { id: 'pm_new', object: 'payment_method', customer: s.customerId, type: 'card' });
    await processInbox(deps);
    expect(deps.stripe.chargeCount(s.invoiceId)).toBe(1);
    const attempts = await db.pool.query(`select status from payment_attempts where tenant_id = $1`, [s.tenantId]);
    expect(attempts.rows).toEqual([{ status: 'SUCCEEDED' }]);
    expect((await listCaseActions(db.pool, s.tenantId, c0.id)).map((a) => a.action)).toContain('retry.paid');
  });

  it('customer.updated avec un nouveau moyen de paiement par défaut déclenche le retry', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    await failAndGetCase(deps, s);
    deps.stripe.setCardBehavior('pm_def', 'succeed');
    await deliver(
      deps, s, 'customer.updated',
      { id: s.customerId, object: 'customer', invoice_settings: { default_payment_method: 'pm_def' } },
      { previous: { invoice_settings: { default_payment_method: null } } },
    );
    await processInbox(deps);
    expect(deps.stripe.chargeCount(s.invoiceId)).toBe(1);
  });

  it('customer.updated sans changement de moyen de paiement : aucun retry', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    await failAndGetCase(deps, s);
    await deliver(deps, s, 'customer.updated', { id: s.customerId, object: 'customer', name: 'Nouveau nom' }, { previous: { name: 'Ancien' } });
    await processInbox(deps);
    expect(deps.stripe.chargeCount(s.invoiceId)).toBe(0);
    const n = await db.pool.query(`select count(*)::int n from payment_attempts where tenant_id = $1`, [s.tenantId]);
    expect(n.rows[0].n).toBe(0);
  });

  it('carte refusée : tentative FAILED journalisée, dossier toujours actif', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    const c = await failAndGetCase(deps, s);
    deps.stripe.setCardBehavior('pm_bad', 'decline', 'insufficient_funds');
    await deliver(deps, s, 'setup_intent.succeeded', { id: 'seti_2', object: 'setup_intent', customer: s.customerId, payment_method: 'pm_bad' });
    await processInbox(deps);
    const attempts = await db.pool.query(`select status, error_code from payment_attempts where case_id = $1`, [c.id]);
    expect(attempts.rows).toEqual([{ status: 'FAILED', error_code: 'insufficient_funds' }]);
    expect((await listCaseActions(db.pool, s.tenantId, c.id)).map((a) => a.action)).toContain('retry.failed');
    expect((await getCaseByInvoice(db.pool, s.tenantId, s.invoiceId))!.state).toBe('RECOVERING');
  });

  it('mode dry-run : aucun paiement tenté, action journalisée', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps, { dryRun: true });
    const c = await failAndGetCase(deps, s);
    deps.stripe.setCardBehavior('pm_new', 'succeed');
    await deliver(deps, s, 'setup_intent.succeeded', { id: 'seti_3', object: 'setup_intent', customer: s.customerId, payment_method: 'pm_new' });
    await processInbox(deps);
    expect(deps.stripe.chargeCount(s.invoiceId)).toBe(0);
    expect((await listCaseActions(db.pool, s.tenantId, c.id)).map((a) => a.action)).toContain('retry.skipped_dry_run');
  });

  it('client sans dossier actif : aucun effet', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    await deliver(deps, s, 'setup_intent.succeeded', { id: 'seti_4', object: 'setup_intent', customer: s.customerId, payment_method: 'pm_new' });
    const stats = await processInbox(deps);
    expect(stats.failed).toBe(0);
    expect(deps.stripe.chargeCount(s.invoiceId)).toBe(0);
  });
});

describe('remboursements et litiges', () => {
  async function recovered(deps: TestDeps, s: Scenario) {
    await failAndGetCase(deps, s);
    deps.stripe.markPaid(s.account, s.invoiceId);
    await deliver(deps, s, 'invoice.paid', invoiceObject(s, { status: 'paid', amount_paid: 2900 }));
    await processInbox(deps);
  }

  it('charge.refunded : ajustement négatif, jamais de modification de la ligne d’origine', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    await recovered(deps, s);
    await deliver(deps, s, 'charge.refunded', { id: 'ch_1', object: 'charge', invoice: s.invoiceId, amount: 2900, amount_refunded: 1000, currency: 'eur' });
    await processInbox(deps);
    const ledger = await listLedger(db.pool, s.tenantId);
    expect(ledger.map((l) => [l.kind, l.amount])).toEqual([['RECOVERY', 2900], ['ADJUSTMENT', -1000]]);
    const acts = await db.pool.query(`select action from action_log where tenant_id = $1`, [s.tenantId]);
    expect(acts.rows.map((r) => r.action)).toContain('ledger.adjusted');
  });

  it('un rejeu et un remboursement cumulatif n’ajustent que la différence', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    await recovered(deps, s);
    const obj = (refunded: number) => ({ id: 'ch_1', object: 'charge', invoice: s.invoiceId, amount: 2900, amount_refunded: refunded, currency: 'eur' });
    await deliver(deps, s, 'charge.refunded', obj(1000));
    await deliver(deps, s, 'charge.refunded', obj(1000));
    await deliver(deps, s, 'charge.refunded', obj(2900));
    await processInbox(deps);
    const adj = (await listLedger(db.pool, s.tenantId)).filter((l) => l.kind === 'ADJUSTMENT').map((l) => l.amount);
    expect(adj).toEqual([-1000, -1900]);
  });

  it('charge.refunded retrouve la facture via le PaymentIntent', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    await recovered(deps, s);
    deps.stripe.linkPaymentIntent(s.account, 'pi_77', s.invoiceId);
    await deliver(deps, s, 'charge.refunded', { id: 'ch_2', object: 'charge', payment_intent: 'pi_77', amount: 2900, amount_refunded: 500, currency: 'eur' });
    await processInbox(deps);
    expect((await listLedger(db.pool, s.tenantId)).some((l) => l.amount === -500)).toBe(true);
  });

  it('charge.dispute.created : ajustement du montant contesté', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    await recovered(deps, s);
    deps.stripe.linkPaymentIntent(s.account, 'pi_88', s.invoiceId);
    await deliver(deps, s, 'charge.dispute.created', { id: 'dp_1', object: 'dispute', charge: 'ch_3', payment_intent: 'pi_88', amount: 2900, currency: 'eur' });
    await processInbox(deps);
    const adj = (await listLedger(db.pool, s.tenantId)).filter((l) => l.kind === 'ADJUSTMENT');
    expect(adj.map((l) => l.amount)).toEqual([-2900]);
  });

  it('remboursement d’une facture non récupérée : ignoré', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    await deliver(deps, s, 'charge.refunded', { id: 'ch_9', object: 'charge', invoice: s.invoiceId, amount: 2900, amount_refunded: 500, currency: 'eur' });
    const stats = await processInbox(deps);
    expect(stats.failed).toBe(0);
    expect(await listLedger(db.pool, s.tenantId)).toHaveLength(0);
  });
});

describe('connexion et événements non gérés', () => {
  it('account.application.deauthorized : connexion révoquée', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    await failAndGetCase(deps, s);
    await deliver(deps, s, 'account.application.deauthorized', { id: 'ca_1', object: 'application' });
    await processInbox(deps);
    const conn = await db.pool.query(`select status from stripe_connections where tenant_id = $1`, [s.tenantId]);
    expect(conn.rows[0].status).toBe('REVOKED');
  });

  it('événement d’un tenant révoqué : ignoré, aucun dossier créé', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    await db.pool.query(`update stripe_connections set status = 'REVOKED' where tenant_id = $1`, [s.tenantId]);
    const { eventId } = await deliver(deps, s, 'invoice.payment_failed', invoiceObject(s));
    await processInbox(deps);
    expect(await getCaseByInvoice(db.pool, s.tenantId, s.invoiceId)).toBeNull();
    expect((await inbox(eventId)).status).toBe('ignored');
  });

  it('type d’événement non géré : marqué ignoré', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    const { eventId } = await deliver(deps, s, 'charge.succeeded', { id: 'ch_x', object: 'charge' });
    await processInbox(deps);
    expect((await inbox(eventId)).status).toBe('ignored');
  });
});

describe('moteur de traitement', () => {
  it('échec temporaire : retry avec backoff 1, 5, 30, 120 min puis mort + alerte', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    const { eventId } = await deliver(deps, s, 'invoice.payment_failed', invoiceObject(s));
    const delays = [1, 5, 30, 120];
    for (let i = 0; i < 4; i++) {
      deps.stripe.failNext(new GatewayError('Stripe indisponible', { kind: 'api', retryable: true }));
      const t = deps.clock.now();
      const stats = await processInbox(deps);
      expect(stats.failed).toBe(1);
      const row = await inbox(eventId);
      expect(row).toMatchObject({ status: 'pending', attempts: i + 1 });
      expect(row.last_error).toContain('Stripe indisponible');
      expect(new Date(row.next_attempt_at).getTime() - t.getTime()).toBe(delays[i]! * 60_000);
      // pas encore échu : rien n'est traité
      expect((await processInbox(deps)).processed).toBe(0);
      deps.clock.advance({ minutes: delays[i]! });
    }
    deps.stripe.failNext(new GatewayError('Stripe indisponible', { kind: 'api', retryable: true }));
    await processInbox(deps);
    expect(await inbox(eventId)).toMatchObject({ status: 'dead', attempts: 5 });
    const alerts = await db.pool.query(`select kind from system_alerts where tenant_id = $1`, [s.tenantId]);
    expect(alerts.rows.map((r) => r.kind)).toContain('webhook_dead');
    expect(await getCaseByInvoice(db.pool, s.tenantId, s.invoiceId)).toBeNull();
  });

  it('un échec n’écrit rien à moitié (transaction annulée)', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    await deliver(deps, s, 'invoice.payment_failed', invoiceObject(s));
    // 1er appel Stripe (retrieveInvoice) ok, la panne arrive sur retrieveCustomer
    const original = deps.stripe.retrieveCustomer.bind(deps.stripe);
    deps.stripe.retrieveCustomer = async () => {
      throw new GatewayError('panne client', { kind: 'api', retryable: true });
    };
    await processInbox(deps);
    deps.stripe.retrieveCustomer = original;
    expect(await getCaseByInvoice(db.pool, s.tenantId, s.invoiceId)).toBeNull();
    const steps = await db.pool.query(`select count(*)::int n from scheduled_steps where tenant_id = $1`, [s.tenantId]);
    expect(steps.rows[0].n).toBe(0);
  });

  it('échec en milieu de handler (après plusieurs écritures) : aucune écriture partielle, puis reprise complète', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    deps.stripe.addInvoice(s.account, { id: s.invoiceId, customerId: s.customerId, subscriptionId: s.subscriptionId, status: 'open', amountDue: 2900, amountPaid: 0, currency: 'EUR', attemptCount: 1, failedPaymentMethodId: 'pm_old' });
    const { eventId } = await deliver(deps, s, 'invoice.payment_failed', invoiceObject(s));
    // la dernière écriture du handler (journal « steps.scheduled ») échoue : end_customer, dossier, tentative, étapes sont déjà écrits dans la transaction
    await db.pool.query(`create or replace function audit_boom() returns trigger language plpgsql as $$ begin raise exception 'panne simulée en fin de handler'; end $$`);
    await db.pool.query(`create trigger audit_boom before insert on action_log for each row when (new.action = 'steps.scheduled') execute function audit_boom()`);
    try {
      const stats = await processInbox(deps);
      expect(stats.failed).toBe(1);
      expect(await inbox(eventId)).toMatchObject({ status: 'pending', attempts: 1 });
      const count = async (table: string) => (await db.pool.query(`select count(*)::int n from ${table} where tenant_id = $1`, [s.tenantId])).rows[0].n;
      expect(await count('recovery_cases')).toBe(0);
      expect(await count('end_customers')).toBe(0);
      expect(await count('scheduled_steps')).toBe(0);
      expect(await count('payment_attempts')).toBe(0);
      expect(await count('action_log')).toBe(0);
    } finally {
      await db.pool.query(`drop trigger audit_boom on action_log`);
    }
    deps.clock.advance({ minutes: 2 });
    await processInbox(deps);
    expect((await inbox(eventId)).status).toBe('processed');
    const c = (await getCaseByInvoice(db.pool, s.tenantId, s.invoiceId))!;
    expect(c.state).toBe('RECOVERING');
    const steps = await db.pool.query(`select count(*)::int n from scheduled_steps where case_id = $1`, [c.id]);
    expect(steps.rows[0].n).toBeGreaterThan(0);
  });

  it('exception JS après des écritures déjà faites dans la transaction : tout est annulé (pas de demi-dossier)', async () => {
    // Une erreur SQL met de toute façon la transaction en échec ; ici l'erreur est côté Node, la base ne la voit pas :
    // seul un vrai rollback empêche de committer un dossier sans journal ni état.
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    const { eventId } = await deliver(deps, s, 'invoice.payment_failed', invoiceObject(s));
    const realNow = deps.clock.now.bind(deps.clock);
    let inSchedule = 0;
    deps.clock.now = () => {
      // 2e lecture de l'horloge dans scheduleCaseSteps : les étapes sont déjà insérées
      if (new Error().stack?.includes('scheduleCaseSteps') && ++inSchedule === 2) throw new Error('panne JS après écritures');
      return realNow();
    };
    const stats = await processInbox(deps);
    expect(inSchedule).toBeGreaterThanOrEqual(2); // garde-fou : la panne a bien été déclenchée au milieu du handler
    expect(stats.failed).toBe(1);
    const count = async (table: string) => (await db.pool.query(`select count(*)::int n from ${table} where tenant_id = $1`, [s.tenantId])).rows[0].n;
    expect(await count('recovery_cases')).toBe(0);
    expect(await count('end_customers')).toBe(0);
    expect(await count('scheduled_steps')).toBe(0);
    expect(await count('action_log')).toBe(0);
    expect((await inbox(eventId)).status).toBe('pending');
  });

  it('échec du ledger : la clôture du dossier est annulée avec lui (pas de dossier RECOVERED sans revenu)', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    await deliver(deps, s, 'invoice.payment_failed', invoiceObject(s));
    await processInbox(deps);
    deps.stripe.markPaid(s.account, s.invoiceId, deps.clock.now());
    const { eventId } = await deliver(deps, s, 'invoice.paid', invoiceObject(s, { status: 'paid', amount_paid: 2900 }));
    await db.pool.query(`create or replace function audit_boom_ledger() returns trigger language plpgsql as $$ begin raise exception 'panne simulée ledger'; end $$`);
    await db.pool.query(`create trigger audit_boom_ledger before insert on recovery_ledger for each row execute function audit_boom_ledger()`);
    try {
      expect((await processInbox(deps)).failed).toBe(1);
      const c = (await getCaseByInvoice(db.pool, s.tenantId, s.invoiceId))!;
      expect(c.state).toBe('RECOVERING');
      expect(c.closedAt).toBeNull();
      const steps = await db.pool.query(`select status from scheduled_steps where case_id = $1`, [c.id]);
      expect(steps.rows.every((r) => r.status === 'SCHEDULED')).toBe(true);
      const log = await db.pool.query(`select action from action_log where case_id = $1`, [c.id]);
      expect(log.rows.map((r) => r.action)).not.toContain('case.recovered');
    } finally {
      await db.pool.query(`drop trigger audit_boom_ledger on recovery_ledger`);
    }
    deps.clock.advance({ minutes: 2 });
    await processInbox(deps);
    expect((await inbox(eventId)).status).toBe('processed');
    expect((await getCaseByInvoice(db.pool, s.tenantId, s.invoiceId))!.state).toBe('RECOVERED');
    expect(await listLedger(db.pool, s.tenantId)).toHaveLength(1);
  });

  it('rejeu manuel d’un événement mort', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    const { eventId } = await deliver(deps, s, 'invoice.payment_failed', invoiceObject(s));
    await db.pool.query(`update inbox_events set status = 'dead', attempts = 5 where stripe_event_id = $1`, [eventId]);
    expect(await replayDeadEvent(deps, eventId)).toBe(true);
    expect(await replayDeadEvent(deps, eventId)).toBe(false);
    await processInbox(deps);
    expect((await inbox(eventId)).status).toBe('processed');
    expect(await getCaseByInvoice(db.pool, s.tenantId, s.invoiceId)).not.toBeNull();
  });

  it('deux workers en parallèle : chaque événement traité une seule fois, état final cohérent', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    await deliver(deps, s, 'invoice.payment_failed', invoiceObject(s));
    await processInbox(deps);
    deps.stripe.markPaid(s.account, s.invoiceId);
    for (let i = 0; i < 6; i++) {
      await deliver(deps, s, i % 2 ? 'invoice.paid' : 'invoice.payment_succeeded', invoiceObject(s, { status: 'paid', amount_paid: 2900 }));
    }
    const results = await Promise.all([processInbox(deps), processInbox(deps), processInbox(deps)]);
    expect(results.reduce((n, r) => n + r.processed, 0)).toBe(6);
    expect((await getCaseByInvoice(db.pool, s.tenantId, s.invoiceId))!.state).toBe('RECOVERED');
    expect(await listLedger(db.pool, s.tenantId)).toHaveLength(1);
  });

  it('rejouer deux fois la même séquence d’événements donne le même état final (idempotence)', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    const snapshot = async () => {
      const c = await getCaseByInvoice(db.pool, s.tenantId, s.invoiceId);
      const steps = c ? await listStepsForCase(db.pool, s.tenantId, c.id) : [];
      return JSON.stringify({
        c: c && { state: c.state, attempts: c.attemptCount, amount: c.amountDue },
        steps: steps.map((x) => [x.stepIndex, x.status, x.dueAt]),
        ledger: (await listLedger(db.pool, s.tenantId)).map((l) => [l.kind, l.amount, l.attribution]),
      });
    };
    const play = async () => {
      await deliver(deps, s, 'invoice.payment_failed', invoiceObject(s));
      deps.stripe.markPaid(s.account, s.invoiceId, new Date('2026-10-01T10:00:00Z'));
      await deliver(deps, s, 'invoice.paid', invoiceObject(s, { status: 'paid', amount_paid: 2900 }));
      await processInbox(deps);
    };
    await play();
    const first = await snapshot();
    await play();
    expect(await snapshot()).toBe(first);
  });

  it('chaque traitement écrit dans le journal d’actions', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    const c = await failAndGetCase(deps, s);
    deps.stripe.markPaid(s.account, s.invoiceId);
    await insertSentEmail(db, s, c.id, { sentAt: new Date('2026-10-01T09:05:00Z') });
    await deliver(deps, s, 'invoice.paid', invoiceObject(s, { status: 'paid', amount_paid: 2900 }));
    await processInbox(deps);
    const actions = (await listCaseActions(db.pool, s.tenantId, c.id)).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['case.opened', 'case.recovered', 'ledger.recorded']));
  });
});

describe('audit webhooks', () => {
  const caseState = async (s: Scenario) => (await getCaseByInvoice(db.pool, s.tenantId, s.invoiceId))!;
  const actionsOf = async (s: Scenario, caseId: string) => (await listCaseActions(db.pool, s.tenantId, caseId)).map((a) => a.action);

  describe.each([
    ['tenant SUSPENDED', (s: Scenario) => db.pool.query(`update tenants set status = 'SUSPENDED' where id = $1`, [s.tenantId])],
  ])('évènements de clôture avec %s', (_label, degrade) => {
    it('invoice.paid : dossier RECOVERED et ligne ledger, évènement traité', async () => {
      const deps = makeDeps(db);
      const s = await setupScenario(db, deps);
      const c = await failAndGetCase(deps, s);
      await degrade(s);
      deps.stripe.markPaid(s.account, s.invoiceId);
      const { eventId } = await deliver(deps, s, 'invoice.paid', invoiceObject(s, { status: 'paid', amount_paid: 2900 }));
      await processInbox(deps);
      expect((await inbox(eventId)).status).toBe('processed');
      expect((await caseState(s)).state).toBe('RECOVERED');
      expect((await listLedger(db.pool, s.tenantId)).map((l) => [l.kind, l.amount])).toEqual([['RECOVERY', 2900]]);
      expect((await listStepsForCase(db.pool, s.tenantId, c.id)).every((x) => x.status === 'CANCELED')).toBe(true);
    });

    it('voided et subscription.deleted sont aussi traités', async () => {
      const deps = makeDeps(db);
      const a = await setupScenario(db, deps);
      const b = await setupScenario(db, deps);
      await failAndGetCase(deps, a);
      await failAndGetCase(deps, b);
      await degrade(a);
      await degrade(b);
      await deliver(deps, a, 'invoice.voided', invoiceObject(a, { status: 'void' }));
      await deliver(deps, b, 'customer.subscription.deleted', { id: b.subscriptionId, object: 'subscription', customer: b.customerId });
      await processInbox(deps);
      expect((await caseState(a)).state).toBe('CANCELED');
      expect((await caseState(b)).state).toBe('CANCELED');
    });

    it('un évènement qui enverrait ou ouvrirait quelque chose reste ignoré', async () => {
      const deps = makeDeps(db);
      const s = await setupScenario(db, deps);
      await failAndGetCase(deps, s);
      await degrade(s);
      const { eventId } = await deliver(deps, s, 'setup_intent.succeeded', { id: 'seti_1', object: 'setup_intent', customer: s.customerId, payment_method: 'pm_x' });
      await processInbox(deps);
      expect((await inbox(eventId)).status).toBe('ignored');
      const n = await db.pool.query(`select count(*)::int n from payment_attempts where tenant_id = $1`, [s.tenantId]);
      expect(n.rows[0].n).toBe(0);
    });
  });

  describe('évènements de clôture avec connexion REVOKED', () => {
    it('ignorés (aucun appel à l’API du compte révoqué), journalisés ; la réconciliation rattrape à la reconnexion', async () => {
      const deps = makeDeps(db);
      const s = await setupScenario(db, deps);
      await failAndGetCase(deps, s);
      await db.pool.query(`update stripe_connections set status = 'REVOKED' where tenant_id = $1`, [s.tenantId]);
      deps.stripe.markPaid(s.account, s.invoiceId);
      const { eventId } = await deliver(deps, s, 'invoice.paid', invoiceObject(s, { status: 'paid', amount_paid: 2900 }));
      const stats = await processInbox(deps);
      expect(stats).toMatchObject({ failed: 0 });
      expect((await inbox(eventId)).status).toBe('ignored');
      expect((await caseState(s)).state).toBe('RECOVERING');
      expect((await db.pool.query(`select details from action_log where tenant_id = $1 and action = 'webhook.ignored'`, [s.tenantId])).rows[0].details).toMatchObject({ type: 'invoice.paid', reason: 'stripe_revoked' });

      // reconnexion : la réconciliation (reconcileInBackground → reconcileTenant) clôture le dossier payé
      await db.pool.query(`update stripe_connections set status = 'ACTIVE' where tenant_id = $1`, [s.tenantId]);
      await reconcileInBackground(deps, s.tenantId);
      await processInbox(deps);
      expect((await caseState(s)).state).toBe('RECOVERED');
    });
  });

  describe.each(['LOST', 'CLOSED_MANUAL', 'CANCELED'])('paiement après passage en %s', (state) => {
    it('écrit la ligne RECOVERY, journalise case.paid_after_close, ne rouvre pas, idempotent', async () => {
      const deps = makeDeps(db);
      const s = await setupScenario(db, deps);
      const c = await failAndGetCase(deps, s);
      await insertSentEmail(db, s, c.id, { sentAt: new Date('2026-10-01T09:05:00Z') });
      await db.pool.query(`update recovery_cases set state = $2, closed_at = now() where id = $1`, [c.id, state]);
      deps.clock.advance({ days: 1 });
      deps.stripe.markPaid(s.account, s.invoiceId, deps.clock.now());
      await deliver(deps, s, 'invoice.paid', invoiceObject(s, { status: 'paid', amount_paid: 2900 }));
      await deliver(deps, s, 'invoice.payment_succeeded', invoiceObject(s, { status: 'paid', amount_paid: 2900 }));
      await processInbox(deps);

      expect((await caseState(s)).state).toBe(state);
      const ledger = await listLedger(db.pool, s.tenantId);
      expect(ledger).toHaveLength(1);
      expect(ledger[0]).toMatchObject({ kind: 'RECOVERY', attribution: 'ASSISTED', amount: 2900 });
      const acts = (await actionsOf(s, c.id)).filter((x) => x === 'case.paid_after_close');
      expect(acts).toHaveLength(1);
      // une écriture ledger dédoublonnée ne doit pas produire un second « ledger.recorded »
      expect((await actionsOf(s, c.id)).filter((x) => x === 'ledger.recorded')).toHaveLength(1);
    });
  });

  it('remboursement traité avant l’écriture RECOVERY : évènement reporté puis appliqué', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    await failAndGetCase(deps, s);
    const { eventId } = await deliver(deps, s, 'charge.refunded', { id: 'ch_1', object: 'charge', invoice: s.invoiceId, amount: 2900, amount_refunded: 1000, currency: 'eur' });
    const stats = await processInbox(deps);
    expect(stats.failed).toBe(1);
    expect(await inbox(eventId)).toMatchObject({ status: 'pending', attempts: 1 });

    deps.stripe.markPaid(s.account, s.invoiceId);
    await deliver(deps, s, 'invoice.paid', invoiceObject(s, { status: 'paid', amount_paid: 2900 }));
    await processInbox(deps); // paid écrit RECOVERY (le refund n'est pas encore échu)
    deps.clock.advance({ minutes: 2 });
    await processInbox(deps);
    expect((await inbox(eventId)).status).toBe('processed');
    expect((await listLedger(db.pool, s.tenantId)).map((l) => [l.kind, l.amount])).toEqual([['RECOVERY', 2900], ['ADJUSTMENT', -1000]]);
  });

  it('dossier OPEN sans email : un échec ultérieur avec email planifie les étapes et passe en RECOVERING', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps, { email: null });
    const c = await failAndGetCase(deps, s);
    expect(c.state).toBe('OPEN');
    deps.stripe.addCustomer(s.account, { id: s.customerId, email: 'nouveau@example.com', name: 'Camille Roux', locale: 'fr', defaultPaymentMethodId: null });
    deps.clock.advance({ hours: 2 });
    await deliver(deps, s, 'invoice.payment_failed', invoiceObject(s, { attempt_count: 2 }));
    await processInbox(deps);
    const after = await caseState(s);
    expect(after.state).toBe('RECOVERING');
    expect((await listStepsForCase(db.pool, s.tenantId, c.id)).length).toBeGreaterThan(0);
    expect(await actionsOf(s, c.id)).toContain('steps.scheduled');
    const cust = await db.pool.query(`select email from end_customers where tenant_id = $1`, [s.tenantId]);
    expect(cust.rows[0].email).toBe('nouveau@example.com');
  });

  it('closeCase annule aussi les étapes SENDING', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    const c = await failAndGetCase(deps, s);
    await db.pool.query(`update scheduled_steps set status = 'SENDING', reserved_at = now() where case_id = $1 and step_index = 0`, [c.id]);
    deps.stripe.markPaid(s.account, s.invoiceId);
    await deliver(deps, s, 'invoice.paid', invoiceObject(s, { status: 'paid', amount_paid: 2900 }));
    await processInbox(deps);
    const steps = await listStepsForCase(db.pool, s.tenantId, c.id);
    expect(steps.some((x) => x.status === 'SENDING')).toBe(false);
    expect(steps.every((x) => x.status === 'CANCELED')).toBe(true);
  });

  it('client anonymisé puis ré-alimenté : anonymized_at remis à NULL', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    await db.pool.query(
      `insert into end_customers (tenant_id, stripe_customer_id, anonymized_at) values ($1,$2,now())`,
      [s.tenantId, s.customerId],
    );
    await failAndGetCase(deps, s);
    const cust = await db.pool.query(`select email, anonymized_at from end_customers where tenant_id = $1`, [s.tenantId]);
    expect(cust.rows[0].email).not.toBeNull();
    expect(cust.rows[0].anonymized_at).toBeNull();
  });

  it('dossier ouvert avec la date réelle du dernier échec quand la facture l’expose (failedAt)', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    const real = new Date('2026-09-28T10:00:00Z');
    deps.stripe.addInvoice(s.account, { id: s.invoiceId, customerId: s.customerId, subscriptionId: s.subscriptionId, status: 'open', amountDue: 2900, amountPaid: 0, currency: 'EUR', attemptCount: 1, lastErrorCode: 'card_declined', failedAt: real } as any);
    const c = await failAndGetCase(deps, s);
    expect(c.failedAt.toISOString()).toBe(real.toISOString());
  });

  it('montant encaissé : le ledger porte amount_paid, pas amount_due ; 0 encaissé : aucune ligne', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    const z = await setupScenario(db, deps);
    await failAndGetCase(deps, s);
    await failAndGetCase(deps, z);
    const paid = (sc: Scenario, amountPaid: number) =>
      deps.stripe.addInvoice(sc.account, { id: sc.invoiceId, customerId: sc.customerId, subscriptionId: sc.subscriptionId, status: 'paid', amountDue: 2900, amountPaid, currency: 'EUR', attemptCount: 1, paidAt: deps.clock.now() });
    paid(s, 2000);
    paid(z, 0);
    await deliver(deps, s, 'invoice.paid', invoiceObject(s, { status: 'paid', amount_paid: 2000 }));
    await deliver(deps, z, 'invoice.paid', invoiceObject(z, { status: 'paid', amount_paid: 0 }));
    const stats = await processInbox(deps);
    expect(stats.failed).toBe(0);
    expect((await listLedger(db.pool, s.tenantId)).map((l) => l.amount)).toEqual([2000]);
    expect(await listLedger(db.pool, z.tenantId)).toHaveLength(0);
    expect((await caseState(z)).state).toBe('RECOVERED');
  });
});

describe('carte et code de l’échec (PaymentIntent de la facture)', () => {
  const failedInvoice = (s: Scenario, over: Record<string, unknown>) =>
    ({ id: s.invoiceId, customerId: s.customerId, subscriptionId: s.subscriptionId, status: 'open', amountDue: 2900, amountPaid: 0, currency: 'EUR', attemptCount: 1, ...over }) as any;

  it('mémorise la carte réellement refusée, pas la carte par défaut du client', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    deps.stripe.addCustomer(s.account, { id: s.customerId, email: 'c@example.com', name: 'Camille', locale: 'fr', defaultPaymentMethodId: 'pm_B' });
    deps.stripe.addInvoice(s.account, failedInvoice(s, { lastErrorCode: 'insufficient_funds', failedPaymentMethodId: 'pm_A' }));
    const c = await failAndGetCase(deps, s);
    const rows = await db.pool.query(`select payment_method_id, status, error_code from payment_attempts where case_id = $1`, [c.id]);
    expect(rows.rows).toEqual([{ payment_method_id: 'pm_A', status: 'FAILED', error_code: 'initial_failure' }]);

    // pm_B n'a jamais été essayé : le client peut l'utiliser, un rejeu de pm_A ne débite pas
    deps.stripe.setCardBehavior('pm_B', 'succeed');
    await deliver(deps, s, 'setup_intent.succeeded', { id: 'seti_b', object: 'setup_intent', customer: s.customerId, payment_method: 'pm_B' });
    await deliver(deps, s, 'payment_method.attached', { id: 'pm_A', object: 'payment_method', customer: s.customerId, type: 'card' });
    await processInbox(deps);
    expect(deps.stripe.chargeCount(s.invoiceId)).toBe(1);
  });

  it('carte inconnue (aucun défaut chez le client, aucune carte sur l’échec) : aucune tentative inventée', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    deps.stripe.addCustomer(s.account, { id: s.customerId, email: 'c@example.com', name: 'Camille', locale: 'fr', defaultPaymentMethodId: 'pm_B' });
    const c = await failAndGetCase(deps, s);
    const n = await db.pool.query(`select count(*)::int n from payment_attempts where case_id = $1`, [c.id]);
    expect(n.rows[0].n).toBe(0);
  });

  it('code d’échec : celui du PaymentIntent de la facture, pas celui de l’évènement', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    deps.stripe.addInvoice(s.account, failedInvoice(s, { lastErrorCode: 'insufficient_funds' }));
    await deliver(deps, s, 'invoice.payment_failed', invoiceObject(s, { last_payment_error: { code: 'card_declined' } }));
    await processInbox(deps);
    const r = await db.pool.query(`select last_failure_code from recovery_cases where tenant_id = $1`, [s.tenantId]);
    expect(r.rows[0].last_failure_code).toBe('insufficient_funds');
  });

  it('paiement asynchrone (SEPA) en cours : tentative PENDING, journal retry.processing, facture non marquée payée', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    const c = await failAndGetCase(deps, s);
    deps.stripe.setCardBehavior('pm_sepa', 'processing');
    await deliver(deps, s, 'setup_intent.succeeded', { id: 'seti_sepa', object: 'setup_intent', customer: s.customerId, payment_method: 'pm_sepa' });
    await processInbox(deps);
    const a = await db.pool.query(`select status, error_code from payment_attempts where case_id = $1`, [c.id]);
    expect(a.rows).toEqual([{ status: 'PENDING', error_code: null }]);
    expect((await listCaseActions(db.pool, s.tenantId, c.id)).map((x) => x.action)).toContain('retry.processing');
    expect((await getCaseByInvoice(db.pool, s.tenantId, s.invoiceId))!.state).toBe('RECOVERING');
    expect(await listLedger(db.pool, s.tenantId)).toHaveLength(0);
  });
});
