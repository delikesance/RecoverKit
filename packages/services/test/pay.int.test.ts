import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getCaseByInvoice } from '@recoverkit/db';
import { GatewayError } from '@recoverkit/stripe';
import { createTestDb, type TestDb } from '@recoverkit/testkit';
import { processInbox } from '../src/webhooks/process';
import { runDueSteps } from '../src/engine/send-steps';
import { confirmSetup, resolvePaymentLink, startSetup } from '../src/payments/pay';
import { tokenFromUrl } from '../src/payments/link';
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

let ip = '203.0.113.1';
let ipCounter = 0;
beforeEach(() => {
  ip = `203.0.113.${++ipCounter}`;
});

/** Dossier ouvert, premier email envoyé : on renvoie le token présent dans l'email. */
async function withLink(deps: TestDeps, s: Scenario) {
  await deliver(deps, s, 'invoice.payment_failed', invoiceObject(s));
  await processInbox(deps);
  deps.clock.advance({ minutes: 90 });
  await runDueSteps(deps);
  const mail = deps.mailer.sent.at(-1)!;
  const token = mail.text.match(/\/pay\/([\w-]{43})/)![1]!;
  const c = (await getCaseByInvoice(db.pool, s.tenantId, s.invoiceId))!;
  return { token, c };
}

describe('resolvePaymentLink', () => {
  it('lien valide : affiche tenant, montant, offre et langue, et note la première ouverture', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    await db.pool.query(`update tenants set name = 'Nimbus Notes' where id = $1`, [s.tenantId]);
    const { token, c } = await withLink(deps, s);
    const r = await resolvePaymentLink(deps, token, { ip });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.view).toMatchObject({ tenantName: 'Nimbus Notes', plan: 'Pro', locale: 'fr', publishableKey: '', account: s.account });
    expect(r.view.amount.replace(/\s/g, ' ')).toBe('29,00 €');
    expect(JSON.stringify(r.view)).not.toContain(c.id);
    const t = await db.pool.query(`select first_opened_at from payment_tokens where case_id = $1`, [c.id]);
    expect(t.rows[0].first_opened_at).not.toBeNull();
  });

  it('inconnu, vide, expiré ou révoqué : exactement la même réponse neutre (aucune fuite)', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    const { token, c } = await withLink(deps, s);
    const neutral = { status: 'unavailable' };

    expect(await resolvePaymentLink(deps, 'n-importe-quoi', { ip })).toEqual(neutral);
    expect(await resolvePaymentLink(deps, '', { ip })).toEqual(neutral);
    await db.pool.query(`update payment_tokens set revoked_at = now() where case_id = $1`, [c.id]);
    expect(await resolvePaymentLink(deps, token, { ip })).toEqual(neutral);
    await db.pool.query(`update payment_tokens set revoked_at = null, expires_at = $2 where case_id = $1`, [c.id, new Date('2026-10-01T00:00:00Z')]);
    expect(await resolvePaymentLink(deps, token, { ip })).toEqual(neutral);
  });

  it('dossier déjà payé ou lien utilisé : « déjà payé »', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    const { token, c } = await withLink(deps, s);
    await db.pool.query(`update payment_tokens set used_at = now() where case_id = $1`, [c.id]);
    expect(await resolvePaymentLink(deps, token, { ip })).toEqual({ status: 'paid' });

    const deps2 = makeDeps(db);
    const s2 = await setupScenario(db, deps2);
    const w = await withLink(deps2, s2);
    await db.pool.query(`update recovery_cases set state = 'RECOVERED' where id = $1`, [w.c.id]);
    await db.pool.query(`update payment_tokens set revoked_at = null where case_id = $1`, [w.c.id]);
    expect(await resolvePaymentLink(deps2, w.token, { ip })).toEqual({ status: 'paid' });
  });

  it('dossier annulé, perdu ou clos manuellement : réponse neutre', async () => {
    for (const state of ['CANCELED', 'LOST', 'CLOSED_MANUAL']) {
      const deps = makeDeps(db);
      const s = await setupScenario(db, deps);
      const { token, c } = await withLink(deps, s);
      await db.pool.query(`update recovery_cases set state = $2 where id = $1`, [c.id, state]);
      expect(await resolvePaymentLink(deps, token, { ip })).toEqual({ status: 'unavailable' });
    }
  });

  it('limite le débit par IP puis par token (429)', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    const { token } = await withLink(deps, s);
    const results = [];
    for (let i = 0; i < 32; i++) results.push((await resolvePaymentLink(deps, token, { ip: '198.51.100.9' })).status);
    expect(results.slice(0, 30).every((x) => x === 'ok')).toBe(true);
    expect(results.slice(30)).toEqual(['rate_limited', 'rate_limited']);

    for (let i = 0; i < 61; i++) await resolvePaymentLink(deps, `x${i}`, { ip: '198.51.100.10' });
    expect(await resolvePaymentLink(deps, token, { ip: '198.51.100.10' })).toEqual({ status: 'rate_limited' });
  });
});

describe('startSetup', () => {
  it('crée un SetupIntent pour le client du dossier', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    const { token } = await withLink(deps, s);
    const r = await startSetup(deps, token, { ip });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.clientSecret).toMatch(/_secret_/);
    expect(r.account).toBe(s.account);
  });

  it('refuse un lien invalide ou un dossier clos', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    const { token, c } = await withLink(deps, s);
    expect(await startSetup(deps, 'faux', { ip })).toEqual({ status: 'unavailable' });
    await db.pool.query(`update recovery_cases set state = 'RECOVERED' where id = $1`, [c.id]);
    expect((await startSetup(deps, token, { ip })).status).not.toBe('ok');
  });
});

describe('confirmSetup', () => {
  async function ready(deps: TestDeps, s: Scenario, pm = 'pm_new', behavior: 'succeed' | 'decline' | '3ds' = 'succeed', code = 'card_declined') {
    const { token, c } = await withLink(deps, s);
    const start = await startSetup(deps, token, { ip });
    if (start.status !== 'ok') throw new Error('setup');
    deps.stripe.setCardBehavior(pm, behavior, code);
    deps.stripe.completeSetupIntent(s.account, start.setupIntentId, pm);
    return { token, c, setupIntentId: start.setupIntentId };
  }

  it('succès : carte par défaut mise à jour, paiement réussi, lien utilisé, dossier clos par le webhook', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    const { token, c, setupIntentId } = await ready(deps, s);

    const r = await confirmSetup(deps, token, setupIntentId, { ip });
    expect(r).toEqual({ status: 'paid' });
    expect((await deps.stripe.retrieveCustomer(s.account, s.customerId)).defaultPaymentMethodId).toBe('pm_new');
    expect(deps.stripe.subscriptionDefaultPm(s.account, s.subscriptionId)).toBe('pm_new');
    expect(deps.stripe.chargeCount(s.invoiceId)).toBe(1);
    const attempt = await db.pool.query(`select status, source from payment_attempts where case_id = $1`, [c.id]);
    expect(attempt.rows).toEqual([{ status: 'SUCCEEDED', source: 'link' }]);
    const tok = await db.pool.query(`select used_at from payment_tokens where case_id = $1`, [c.id]);
    expect(tok.rows[0].used_at).not.toBeNull();
    // la clôture reste pilotée par invoice.paid
    expect((await getCaseByInvoice(db.pool, s.tenantId, s.invoiceId))!.state).toBe('RECOVERING');
    expect(await resolvePaymentLink(deps, token, { ip })).toEqual({ status: 'paid' });
  });

  it('carte refusée : message clair, lien toujours actif, nouvel essai possible avec une autre carte', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    const { token, c, setupIntentId } = await ready(deps, s, 'pm_bad', 'decline', 'insufficient_funds');
    expect(await confirmSetup(deps, token, setupIntentId, { ip })).toEqual({ status: 'card_failed', errorCode: 'insufficient_funds' });
    const tok = await db.pool.query(`select used_at from payment_tokens where case_id = $1`, [c.id]);
    expect(tok.rows[0].used_at).toBeNull();
    expect((await resolvePaymentLink(deps, token, { ip })).status).toBe('ok');

    const retry = await startSetup(deps, token, { ip });
    if (retry.status !== 'ok') throw new Error('retry');
    deps.stripe.setCardBehavior('pm_good', 'succeed');
    deps.stripe.completeSetupIntent(s.account, retry.setupIntentId, 'pm_good');
    expect(await confirmSetup(deps, token, retry.setupIntentId, { ip })).toEqual({ status: 'paid' });
  });

  it('3D Secure : requires_action avec le lien de la facture Stripe', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    deps.stripe.addInvoice(s.account, { id: s.invoiceId, customerId: s.customerId, subscriptionId: s.subscriptionId, status: 'open', amountDue: 2900, amountPaid: 0, currency: 'EUR', attemptCount: 1, hostedInvoiceUrl: 'https://invoice.stripe.com/i/x' });
    const { token, setupIntentId } = await ready(deps, s, 'pm_3ds', '3ds');
    expect(await confirmSetup(deps, token, setupIntentId, { ip })).toEqual({ status: 'requires_action', hostedInvoiceUrl: 'https://invoice.stripe.com/i/x' });
  });

  it('rejouer la confirmation (rafraîchissement) ne débite pas deux fois', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    const { token, setupIntentId } = await ready(deps, s);
    await confirmSetup(deps, token, setupIntentId, { ip });
    const again = await confirmSetup(deps, token, setupIntentId, { ip });
    expect(again.status).toBe('paid');
    expect(deps.stripe.chargeCount(s.invoiceId)).toBe(1);
  });

  it('refuse le SetupIntent d’un autre client, ou non finalisé', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    const { token } = await withLink(deps, s);
    deps.stripe.addCustomer(s.account, { id: 'cus_other', email: 'x@y.z', name: 'X', locale: 'fr', defaultPaymentMethodId: null });
    const foreign = await deps.stripe.createSetupIntent(s.account, { customerId: 'cus_other', idempotencyKey: 'f' });
    deps.stripe.completeSetupIntent(s.account, foreign.id, 'pm_f');
    expect(await confirmSetup(deps, token, foreign.id, { ip })).toEqual({ status: 'invalid' });

    const start = await startSetup(deps, token, { ip });
    if (start.status !== 'ok') throw new Error('x');
    expect(await confirmSetup(deps, token, start.setupIntentId, { ip })).toEqual({ status: 'setup_incomplete' });
    expect(deps.stripe.chargeCount(s.invoiceId)).toBe(0);
  });

  it('lien invalide : unavailable, rien n’est débité', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    const { setupIntentId } = await ready(deps, s);
    expect(await confirmSetup(deps, 'faux', setupIntentId, { ip })).toEqual({ status: 'unavailable' });
    expect(deps.stripe.chargeCount(s.invoiceId)).toBe(0);
  });

  it('panne Stripe : erreur générique sans détail technique', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    const { token, setupIntentId } = await ready(deps, s);
    deps.stripe.failNext(new GatewayError('secret interne', { kind: 'api', retryable: true }));
    const r = await confirmSetup(deps, token, setupIntentId, { ip });
    expect(r).toEqual({ status: 'error' });
  });

  it('tenant en dry-run : aucun paiement, statut dédié', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps, { dryRun: true });
    await deliver(deps, s, 'invoice.payment_failed', invoiceObject(s));
    await processInbox(deps);
    deps.clock.advance({ minutes: 90 });
    await runDueSteps(deps);
    const c = (await getCaseByInvoice(db.pool, s.tenantId, s.invoiceId))!;
    // en dry-run aucun email n'est parti : on émet le lien comme le ferait un test du fondateur
    const { ensurePaymentLink } = await import('../src/payments/link');
    const token = tokenFromUrl(await ensurePaymentLink(deps, s.tenantId, c.id));
    const start = await startSetup(deps, token, { ip });
    if (start.status !== 'ok') throw new Error('setup');
    deps.stripe.completeSetupIntent(s.account, start.setupIntentId, 'pm_new');
    expect(await confirmSetup(deps, token, start.setupIntentId, { ip })).toEqual({ status: 'dry_run' });
    expect(deps.stripe.chargeCount(s.invoiceId)).toBe(0);
  });
});

describe('Jalon A : échec, email, clic, carte, paiement, clôture et ledger', () => {
  it('parcours complet de bout en bout', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    const { token, c } = await withLink(deps, s);
    expect(deps.mailer.sent).toHaveLength(1);

    const view = await resolvePaymentLink(deps, token, { ip });
    expect(view.status).toBe('ok');
    const start = await startSetup(deps, token, { ip });
    if (start.status !== 'ok') throw new Error('setup');
    deps.stripe.setCardBehavior('pm_ok', 'succeed');
    deps.stripe.completeSetupIntent(s.account, start.setupIntentId, 'pm_ok');
    expect(await confirmSetup(deps, token, start.setupIntentId, { ip })).toEqual({ status: 'paid' });

    deps.clock.advance({ minutes: 2 });
    await deliver(deps, s, 'invoice.paid', invoiceObject(s, { status: 'paid', amount_paid: 2900 }));
    await processInbox(deps);

    const closed = await getCaseByInvoice(db.pool, s.tenantId, s.invoiceId);
    expect(closed!.state).toBe('RECOVERED');
    const ledger = await db.pool.query(`select kind, attribution, amount, currency from recovery_ledger where case_id = $1`, [c.id]);
    expect(ledger.rows).toEqual([{ kind: 'RECOVERY', attribution: 'ASSISTED', amount: 2900, currency: 'EUR' }]);
    const steps = await db.pool.query(`select status from scheduled_steps where case_id = $1 order by step_index`, [c.id]);
    expect(steps.rows[0].status).toBe('SENT');
    expect(steps.rows.slice(1).every((r) => r.status === 'CANCELED')).toBe(true);
  });
});
