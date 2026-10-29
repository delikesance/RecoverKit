import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getCaseByInvoice, listCaseActions } from '@recoverkit/db';
import { GatewayError } from '@recoverkit/stripe';
import { createTestDb, seedCase, seedTenant, type TestDb } from '@recoverkit/testkit';
import { processInbox } from '../src/webhooks/process';
import { runDueSteps, sendReservedStep } from '../src/engine/send-steps';
import { confirmSetup, startSetup } from '../src/payments/pay';
import { exportRecoveredCsv } from '../src/dashboard/actions';
import { buildConnectUrl, handleOAuthCallback, reconcileInBackground } from '../src/stripe/connect';
import { requestLoginLink, consumeLoginLink, getSession } from '../src/auth/auth';
import { reserveDueSteps } from '@recoverkit/db';
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

/** Dossier ouvert, premier email envoyé, SetupIntent terminé avec la carte `pm`. */
async function ready(deps: TestDeps, s: Scenario, pm = 'pm_new', behavior: 'succeed' | 'processing' = 'succeed') {
  await deliver(deps, s, 'invoice.payment_failed', invoiceObject(s));
  await processInbox(deps);
  deps.clock.advance({ minutes: 90 });
  await runDueSteps(deps);
  const token = deps.mailer.sent.at(-1)!.text.match(/\/pay\/([\w-]{43})/)![1]!;
  const c = (await getCaseByInvoice(db.pool, s.tenantId, s.invoiceId))!;
  const ip = `203.0.115.${++ipCounter}`;
  const start = await startSetup(deps, token, { ip });
  if (start.status !== 'ok') throw new Error('setup');
  deps.stripe.setCardBehavior(pm, behavior);
  deps.stripe.completeSetupIntent(s.account, start.setupIntentId, pm);
  return { token, c, ip, setupIntentId: start.setupIntentId };
}

const logs = async (tenantId: string, caseId: string) => (await listCaseActions(db.pool, tenantId, caseId)).map((r) => r.action);

describe('facture déjà payée côté Stripe : résultat already_paid', () => {
  it('lien de paiement : pas de débit, pas d’erreur, jeton consommé, aucune tentative enregistrée, invoice.paid clôture', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    const { token, c, ip, setupIntentId } = await ready(deps, s);
    deps.stripe.markPaid(s.account, s.invoiceId, deps.clock.now()); // Smart Retries / facture hébergée

    expect(await confirmSetup(deps, token, setupIntentId, { ip })).toEqual({ status: 'paid' });
    expect(deps.stripe.chargeCount(s.invoiceId)).toBe(0);
    const att = await db.pool.query(`select 1 from payment_attempts where case_id = $1`, [c.id]);
    expect(att.rowCount).toBe(0); // un faux « lien utilisé » ne doit pas fausser l'attribution
    const tok = await db.pool.query(`select used_at from payment_tokens where case_id = $1`, [c.id]);
    expect(tok.rows[0].used_at).not.toBeNull();
    expect(await logs(s.tenantId, c.id)).toContain('retry.already_paid');

    await deliver(deps, s, 'invoice.paid', invoiceObject(s, { status: 'paid', amount_paid: 2900 }));
    await processInbox(deps);
    expect((await getCaseByInvoice(db.pool, s.tenantId, s.invoiceId))!.state).toBe('RECOVERED');
    const led = await db.pool.query(`select kind, amount from recovery_ledger where case_id = $1`, [c.id]);
    expect(led.rows).toEqual([{ kind: 'RECOVERY', amount: 2900 }]);
  });

  it('setup_intent.succeeded après un paiement Stripe : évènement traité du premier coup, jamais mort', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    await deliver(deps, s, 'invoice.payment_failed', invoiceObject(s));
    await processInbox(deps);
    const c = (await getCaseByInvoice(db.pool, s.tenantId, s.invoiceId))!;
    deps.stripe.markPaid(s.account, s.invoiceId, deps.clock.now());
    const { eventId } = await deliver(deps, s, 'setup_intent.succeeded', { id: 'seti_x', object: 'setup_intent', customer: s.customerId, payment_method: 'pm_x' });
    await processInbox(deps);
    const row = await db.pool.query(`select status, attempts from inbox_events where stripe_event_id = $1`, [eventId]);
    expect(row.rows[0].status).toBe('processed');
    expect(deps.stripe.chargeCount(s.invoiceId)).toBe(0);
    expect(await logs(s.tenantId, c.id)).toContain('retry.already_paid');
  });

  it('une erreur invalid_request alors que la facture reste ouverte n’est PAS masquée', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    const { token, ip, setupIntentId } = await ready(deps, s);
    deps.stripe.payInvoice = async () => {
      throw new GatewayError('requête invalide', { kind: 'invalid_request', retryable: false });
    };
    expect(await confirmSetup(deps, token, setupIntentId, { ip })).toEqual({ status: 'error' });
    const tok = await db.pool.query(`select used_at from payment_tokens where case_id = (select id from recovery_cases where stripe_invoice_id = $1)`, [s.invoiceId]);
    expect(tok.rows[0].used_at).toBeNull();
  });
});

describe('résultat « processing » (SEPA) de bout en bout', () => {
  it('tentative PENDING, jeton non consommé, pas de LOST prématuré, invoice.paid conclut', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    const { token, c, ip, setupIntentId } = await ready(deps, s, 'pm_sepa', 'processing');

    expect(await confirmSetup(deps, token, setupIntentId, { ip })).toEqual({ status: 'processing' });
    const att = await db.pool.query(`select status, error_code from payment_attempts where case_id = $1`, [c.id]);
    expect(att.rows).toEqual([{ status: 'PENDING', error_code: null }]);
    const tok = await db.pool.query(`select used_at, revoked_at from payment_tokens where case_id = $1`, [c.id]);
    expect(tok.rows[0]).toEqual({ used_at: null, revoked_at: null });
    expect(await logs(s.tenantId, c.id)).toContain('payment.processing');
    expect((await getCaseByInvoice(db.pool, s.tenantId, s.invoiceId))!.state).toBe('RECOVERING');

    // pendant le délai SEPA : aucune clôture LOST prématurée tant que des étapes restent planifiées
    deps.clock.advance({ days: 1 });
    await runDueSteps(deps);
    expect((await getCaseByInvoice(db.pool, s.tenantId, s.invoiceId))!.state).not.toBe('LOST');

    // le rejeu de la page ne débite pas une seconde fois
    expect(await confirmSetup(deps, token, setupIntentId, { ip })).toEqual({ status: 'processing' });
    expect(deps.stripe.idempotencyKeys.filter((k) => k.startsWith('retry:'))).toHaveLength(1);

    deps.stripe.markPaid(s.account, s.invoiceId, deps.clock.now());
    await deliver(deps, s, 'invoice.paid', invoiceObject(s, { status: 'paid', amount_paid: 2900 }));
    await processInbox(deps);
    expect((await getCaseByInvoice(db.pool, s.tenantId, s.invoiceId))!.state).toBe('RECOVERED');
    const led = await db.pool.query(`select kind, attribution, amount from recovery_ledger where case_id = $1`, [c.id]);
    expect(led.rows).toHaveLength(1);
    expect(led.rows[0]).toMatchObject({ kind: 'RECOVERY', attribution: 'ASSISTED', amount: 2900 });
  });
});

describe('emails des étapes 4 à 6 (séquence de 6 étapes)', () => {
  it('seule la dernière étape dit « dernier message » ; les étapes intermédiaires ont leur propre texte', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    const six = [0, 1, 2, 3, 4, 5].map((index) => ({ index, delayMinutes: 60 + index * 1440, active: true }));
    await db.pool.query(`insert into sequences (tenant_id, version, steps) values ($1, 2, $2::jsonb)`, [s.tenantId, JSON.stringify(six)]);
    await deliver(deps, s, 'invoice.payment_failed', invoiceObject(s));
    await processInbox(deps);
    for (let i = 0; i < 6; i++) {
      deps.clock.advance({ days: 2 });
      await runDueSteps(deps);
    }
    expect(deps.mailer.sent).toHaveLength(6);
    const subjects = deps.mailer.sent.map((m) => m.subject);
    expect(new Set(subjects.slice(0, 5)).size).toBe(5); // 5 sujets distincts avant l'avis final
    expect(subjects[3]).toContain('toujours en attente');
    expect(subjects[4]).toContain('Nouveau rappel');
    for (const i of [3, 4]) expect(deps.mailer.sent[i]!.text).not.toMatch(/dernier (message|avis)/i);
    // la dernière étape, elle, reprend le texte de l'avis final (identique à celui d'une séquence de 4 étapes)
    const d4 = makeDeps(db);
    const s4 = await setupScenario(db, d4);
    await deliver(d4, s4, 'invoice.payment_failed', invoiceObject(s4));
    await processInbox(d4);
    for (let i = 0; i < 4; i++) {
      d4.clock.advance({ days: 13 });
      await runDueSteps(d4);
    }
    expect(d4.mailer.sent).toHaveLength(4);
    expect(subjects[5]!.replace(/\d+[.,]\d+/g, '#')).toBe(d4.mailer.sent[3]!.subject.replace(/\d+[.,]\d+/g, '#'));
  });
});

describe('garde sous verrou de sendReservedStep', () => {
  async function reservedStep(deps: TestDeps, s: Scenario) {
    await deliver(deps, s, 'invoice.payment_failed', invoiceObject(s));
    await processInbox(deps);
    deps.clock.advance({ minutes: 90 });
    const [reserved] = await reserveDueSteps(db.pool, deps.clock.now(), 5, { tenantId: s.tenantId });
    expect(reserved).toBeDefined();
    return reserved!;
  }

  it('tenant suspendu entre la réservation et l’envoi : pas d’email, étape remise en file, lien révoqué', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    const step = await reservedStep(deps, s);
    const real = deps.stripe.retrieveInvoice.bind(deps.stripe);
    deps.stripe.retrieveInvoice = async (...a: Parameters<typeof real>) => {
      const r = await real(...a);
      await db.pool.query(`update tenants set status = 'SUSPENDED' where id = $1`, [s.tenantId]);
      return r;
    };
    expect(await sendReservedStep(deps, step)).toBe('released');
    expect(deps.mailer.sent).toHaveLength(0);
    const st = await db.pool.query(`select status, attempts from scheduled_steps where id = $1`, [step.id]);
    expect(st.rows[0].status).toBe('SCHEDULED');
    const tok = await db.pool.query(`select revoked_at from payment_tokens where case_id = $1`, [step.caseId]);
    expect(tok.rows.every((r) => r.revoked_at !== null)).toBe(true);
    await db.pool.query(`update tenants set status = 'ACTIVE' where id = $1`, [s.tenantId]);
  });

  it('connexion Stripe révoquée entre la réservation et l’envoi : pas d’email, étape annulée stripe_revoked', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    const step = await reservedStep(deps, s);
    const real = deps.stripe.retrieveInvoice.bind(deps.stripe);
    deps.stripe.retrieveInvoice = async (...a: Parameters<typeof real>) => {
      const r = await real(...a);
      await db.pool.query(`update stripe_connections set status = 'REVOKED' where tenant_id = $1`, [s.tenantId]);
      return r;
    };
    expect(await sendReservedStep(deps, step)).toBe('skipped');
    expect(deps.mailer.sent).toHaveLength(0);
    const st = await db.pool.query(`select status, skip_reason from scheduled_steps where id = $1`, [step.id]);
    expect(st.rows[0]).toEqual({ status: 'CANCELED', skip_reason: 'stripe_revoked' });
  });

  it('connexion déjà révoquée à la réservation : pas d’email non plus', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    const step = await reservedStep(deps, s);
    await db.pool.query(`update stripe_connections set status = 'REVOKED' where tenant_id = $1`, [s.tenantId]);
    expect(await sendReservedStep(deps, step)).toBe('skipped');
    expect(deps.mailer.sent).toHaveLength(0);
  });
});

describe('export CSV : décimales Stripe (currencyDigits)', () => {
  it('ISK : deux décimales côté Stripe (1234500 → 12345,00)', async () => {
    const deps = makeDeps(db, new Date('2026-10-28T10:00:00Z'));
    const t = await seedTenant(db.pool);
    const c = await seedCase(db.pool, t.id, { state: 'RECOVERED', currency: 'ISK' });
    await db.pool.query(
      `insert into recovery_ledger (tenant_id, case_id, invoice_id, kind, attribution, amount, currency, occurred_at) values ($1,$2,$3,'RECOVERY','ASSISTED',1234500,'ISK',$4)`,
      [t.id, c.id, c.invoiceId, new Date('2026-10-05T10:00:00Z')],
    );
    const chunks: string[] = [];
    for await (const ch of exportRecoveredCsv(deps, t.id, { year: 2026, month: 10 })) chunks.push(ch);
    expect(chunks.join('')).toContain(';Récupération;Récupéré;12345,00;ISK;');
  });

  it('JPY : aucune décimale', async () => {
    const deps = makeDeps(db, new Date('2026-10-28T10:00:00Z'));
    const t = await seedTenant(db.pool);
    const c = await seedCase(db.pool, t.id, { state: 'RECOVERED', currency: 'JPY' });
    await db.pool.query(
      `insert into recovery_ledger (tenant_id, case_id, invoice_id, kind, attribution, amount, currency, occurred_at) values ($1,$2,$3,'RECOVERY','ASSISTED',3000,'JPY',$4)`,
      [t.id, c.id, c.invoiceId, new Date('2026-10-05T10:00:00Z')],
    );
    const chunks: string[] = [];
    for await (const ch of exportRecoveredCsv(deps, t.id, { year: 2026, month: 10 })) chunks.push(ch);
    expect(chunks.join('')).toContain(';Récupéré;3000;JPY;');
  });
});

describe('reconnexion OAuth : réconciliation du tenant', () => {
  async function newSession(deps: TestDeps, email: string) {
    await requestLoginLink(deps, email, { ip: `10.7.${Math.floor(Math.random() * 250)}.1` });
    const token = deps.mailer.messagesTo(email).at(-1)!.text.match(/token=([\w-]+)/)![1]!;
    const out = await consumeLoginLink(deps, token);
    if (out.status !== 'ok') throw new Error('login');
    return (await getSession(deps, out.sessionToken))!;
  }
  const until = async (fn: () => Promise<boolean>) => {
    for (let i = 0; i < 50; i++) {
      if (await fn()) return true;
      await new Promise((r) => setTimeout(r, 20));
    }
    return false;
  };

  it('rattrape une facture impayée apparue pendant la déconnexion (sans bloquer le callback)', async () => {
    const deps = makeDeps(db);
    const sess = await newSession(deps, 'reco-oauth@example.com');
    const account = 'acct_reco_oauth';
    deps.stripe.addCustomer(account, { id: 'cus_ro', email: 'ro@example.com', name: 'R', locale: 'fr', defaultPaymentMethodId: null });
    deps.stripe.addSubscription(account, { id: 'sub_ro', customerId: 'cus_ro', status: 'past_due', planName: 'Pro', amount: 2900, currency: 'EUR', interval: 'month' });
    deps.stripe.addInvoice(account, { id: 'in_ro', customerId: 'cus_ro', subscriptionId: 'sub_ro', status: 'open', amountDue: 2900, amountPaid: 0, currency: 'EUR', attemptCount: 1 });
    const state = new URL(await buildConnectUrl(deps, sess)).searchParams.get('state')!;
    deps.stripe.setOAuthCode('code_ro', { stripeUserId: account, livemode: false });
    expect(await handleOAuthCallback(deps, sess, { code: 'code_ro', state })).toEqual({ status: 'connected', accountId: account });
    const found = await until(async () => {
      const r = await db.pool.query(`select 1 from inbox_events where tenant_id = $1 and type = 'invoice.payment_failed'`, [sess.tenantId]);
      return (r.rowCount ?? 0) > 0;
    });
    expect(found).toBe(true);
  });

  it('une erreur Stripe pendant la réconciliation ne fait jamais échouer la reconnexion', async () => {
    const deps = makeDeps(db);
    const sess = await newSession(deps, 'reco-oauth2@example.com');
    deps.stripe.listOpenInvoices = async () => {
      throw new GatewayError('stripe indisponible', { kind: 'api', retryable: true });
    };
    const state = new URL(await buildConnectUrl(deps, sess)).searchParams.get('state')!;
    deps.stripe.setOAuthCode('code_ro2', { stripeUserId: 'acct_reco_oauth2', livemode: false });
    expect(await handleOAuthCallback(deps, sess, { code: 'code_ro2', state })).toEqual({ status: 'connected', accountId: 'acct_reco_oauth2' });
    await expect(reconcileInBackground(deps, sess.tenantId)).resolves.toBeUndefined();
  });

  it('reconcileInBackground (réactivation d’un tenant suspendu) rattrape les paiements manqués sans jamais lever', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    await deliver(deps, s, 'invoice.payment_failed', invoiceObject(s));
    await processInbox(deps);
    deps.stripe.markPaid(s.account, s.invoiceId, deps.clock.now()); // payé pendant la suspension, webhook perdu
    await reconcileInBackground(deps, s.tenantId);
    await processInbox(deps);
    expect((await getCaseByInvoice(db.pool, s.tenantId, s.invoiceId))!.state).toBe('RECOVERED');
    deps.stripe.failNext(new GatewayError('boom', { kind: 'api', retryable: true }));
    await expect(reconcileInBackground(deps, s.tenantId)).resolves.toBeUndefined();
  });
});
