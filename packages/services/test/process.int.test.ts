import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getCaseByInvoice, listCaseActions, listLedger, listStepsForCase } from '@recoverkit/db';
import { createTestDb, type TestDb } from '@recoverkit/testkit';
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
    await failAndGetCase(deps, s);
    deps.stripe.setCardBehavior('pm_new', 'succeed');
    await deliver(deps, s, 'setup_intent.succeeded', { id: 'seti_1', object: 'setup_intent', customer: s.customerId, payment_method: 'pm_new' });
    await deliver(deps, s, 'payment_method.attached', { id: 'pm_new', object: 'payment_method', customer: s.customerId, type: 'card' });
    await processInbox(deps);
    expect(deps.stripe.chargeCount(s.invoiceId)).toBe(1);
    const attempts = await db.pool.query(`select status from payment_attempts where tenant_id = $1`, [s.tenantId]);
    expect(attempts.rows).toEqual([{ status: 'SUCCEEDED' }]);
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
