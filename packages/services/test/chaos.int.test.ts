import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIN_GAP_MS } from '@recoverkit/core';
import { FakeMailer, MailerError } from '@recoverkit/mail';
import { createTestDb, type TestDb } from '@recoverkit/testkit';
import { processInbox } from '../src/webhooks/process';
import { receiveEmailProviderWebhook } from '../src/mail/provider-events';
import { closeCaseManually, pauseCase, resumeCase } from '../src/dashboard/actions';
import { closeExhaustedCases, runDueSteps } from '../src/engine/send-steps';
import { makeDeps, type TestDeps } from './helpers';
import { deliver, invoiceObject, setupScenario, type Scenario } from './scenario';

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.dispose();
});

/** Générateur pseudo-aléatoire déterministe (mulberry32) : une graine = un scénario rejouable. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Mailer instrumenté. Il compte les appels par clé (FakeMailer dédoublonne en silence), simule des pannes
 * avant/après l'envoi, et vérifie à chaque appel que le dossier est RECOVERING et le tenant ACTIVE
 * (la transaction d'envoi tient le verrou du tenant : l'état lu ici est celui de l'envoi).
 */
class FlakyMailer extends FakeMailer {
  readonly thrown = new Map<string, number>();
  readonly returned = new Map<string, number>();
  readonly violations: string[] = [];
  constructor(
    private readonly rand: () => number,
    private readonly seed: number,
    private readonly pool: TestDb['pool'],
    private readonly failRate: number,
  ) {
    super();
  }
  private bump(m: Map<string, number>, k: string) {
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  override async send(e: Parameters<FakeMailer['send']>[0]) {
    const caseId = e.idempotencyKey.split(':')[0]!;
    const st = await this.pool.query(
      `select c.state, t.status from recovery_cases c join tenants t on t.id = c.tenant_id where c.id = $1`,
      [caseId],
    );
    const row = st.rows[0];
    if (!row || row.state !== 'RECOVERING') this.violations.push(`email ${e.idempotencyKey} envoyé alors que le dossier est ${row?.state}`);
    if (!row || row.status !== 'ACTIVE') this.violations.push(`email ${e.idempotencyKey} envoyé alors que le tenant est ${row?.status}`);
    const roll = this.rand();
    if (roll < this.failRate) {
      this.bump(this.thrown, e.idempotencyKey);
      throw new MailerError('indisponible avant envoi', { permanent: false });
    }
    const r = await super.send(e);
    if (roll < this.failRate * 2) {
      this.bump(this.thrown, e.idempotencyKey);
      throw new MailerError('timeout après envoi', { permanent: false });
    }
    this.bump(this.returned, e.idempotencyKey);
    // identifiant unique entre graines (la base est partagée par tout le fichier)
    return { messageId: `s${this.seed}_${r.messageId}` };
  }
}

const TERMINAL = new Set(['RECOVERED', 'CANCELED', 'LOST', 'CLOSED_MANUAL']);

const activity = { emails: 0, recovered: 0, canceled: 0, lost: 0, paidAfterClose: 0, complaints: 0, suspensions: 0, refundsBeforePay: 0, manual: 0 };

const resendKey = Buffer.from('resend-webhook-secret-for-tests');
let evtSeq = 0;
function postComplaint(deps: TestDeps, providerMessageId: string) {
  const id = `msg_chaos_${++evtSeq}`;
  const raw = JSON.stringify({ type: 'email.complained', created_at: deps.clock.now().toISOString(), data: { email_id: providerMessageId } });
  const ts = String(Math.floor(deps.clock.now().getTime() / 1000));
  const signature = 'v1,' + createHmac('sha256', resendKey).update(`${id}.${ts}.${raw}`).digest('base64');
  return receiveEmailProviderWebhook(deps, { rawBody: raw, headers: { id, timestamp: ts, signature } });
}

async function runChaos(seed: number, o: { failRate: number } = { failRate: 0.1 }) {
  const rand = rng(seed);
  const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)]!;
  const deps = makeDeps(db, new Date('2026-11-03T09:00:00Z'));
  const mailer = new FlakyMailer(rand, seed, db.pool, o.failRate);
  deps.mailer = mailer;

  const scenarios: Scenario[] = [];
  const amounts = new Map<string, number>(); // invoiceId -> montant dû/payé (varie d'un dossier à l'autre)
  for (let i = 0; i < 6; i++) {
    const amountDue = 1000 + i * 700;
    const sc = await setupScenario(db, deps, { amountDue });
    amounts.set(sc.invoiceId, amountDue);
    scenarios.push(sc);
  }
  const inv = (sc: Scenario, over: Record<string, unknown> = {}) => invoiceObject(sc, { amount_due: amounts.get(sc.invoiceId), ...over });
  const paid = new Map<string, number>(); // invoiceId -> montant payé
  const stateSeen = new Map<string, string>();
  const eventIds = new Map<string, string>(); // pour rejouer exactement le même évènement
  const tenantIds = scenarios.map((x) => x.tenantId);

  const pay = async (sc: Scenario) => {
    deps.stripe.markPaid(sc.account, sc.invoiceId, deps.clock.now());
    const amount = amounts.get(sc.invoiceId)!;
    paid.set(sc.invoiceId, amount);
    await deliver(deps, sc, 'invoice.paid', inv(sc, { status: 'paid', amount_paid: amount }));
  };
  const caseOf = async (sc: Scenario) =>
    (await db.pool.query(`select id, state from recovery_cases where tenant_id = $1 and stripe_invoice_id = $2`, [sc.tenantId, sc.invoiceId])).rows[0] as
      | { id: string; state: string }
      | undefined;

  for (let tick = 0; tick < 70; tick++) {
    const sc = pick(scenarios);
    const roll = rand();
    if (roll < 0.18) {
      // échec de paiement, parfois rejeu du même évènement Stripe, parfois nouvelle livraison (autre id)
      const id = eventIds.get(sc.invoiceId);
      const replay = id && rand() < 0.5;
      const d = await deliver(deps, sc, 'invoice.payment_failed', inv(sc, { attempt_count: 1 + Math.floor(rand() * 3) }), replay ? { id } : {});
      if (!replay) eventIds.set(sc.invoiceId, d.eventId);
    } else if (roll < 0.24) {
      if (!paid.has(sc.invoiceId)) await pay(sc); // possiblement avant même que l'échec ait été traité (désordre)
    } else if (roll < 0.27) {
      await deliver(deps, sc, 'invoice.voided', inv(sc, { status: 'void' }));
    } else if (roll < 0.3) {
      // paiement après passage en LOST / CLOSED_MANUAL / CANCELED
      for (const x of scenarios) {
        const c = await caseOf(x);
        if (c && ['LOST', 'CLOSED_MANUAL', 'CANCELED'].includes(c.state) && !paid.has(x.invoiceId)) {
          await pay(x);
          activity.paidAfterClose++;
          break;
        }
      }
    } else if (roll < 0.34) {
      // remboursement reçu avant le paiement correspondant (désordre d'évènements)
      if (!paid.has(sc.invoiceId)) {
        await deliver(deps, sc, 'charge.refunded', { id: `ch_${sc.invoiceId}`, object: 'charge', invoice: sc.invoiceId, amount: amounts.get(sc.invoiceId), amount_refunded: 500, currency: 'eur' });
        await pay(sc);
        activity.refundsBeforePay++;
      }
    } else if (roll < 0.38) {
      // actions manuelles du marchand : pause, reprise, clôture
      const c = await caseOf(sc);
      if (c) {
        const op = rand();
        const r =
          op < 0.4 ? await pauseCase(deps, sc.tenantId, c.id, 'user:chaos') : op < 0.8 ? await resumeCase(deps, sc.tenantId, c.id, 'user:chaos') : await closeCaseManually(deps, sc.tenantId, c.id, 'user:chaos', 'clôture chaos');
        if (r.status === 'ok') activity.manual++;
      }
    } else if (roll < 0.42) {
      // plainte email, en parallèle des envois
      const m = await db.pool.query(
        `select provider_message_id from email_messages where tenant_id = any($1) and status in ('SENT','DELIVERED') and provider_message_id is not null`,
        [tenantIds],
      );
      if (m.rows.length > 0) {
        const providerId = pick(m.rows).provider_message_id as string;
        const [r] = await Promise.all([postComplaint(deps, providerId), runDueSteps(deps)]);
        if (r.status === 'processed') activity.complaints++;
      }
    } else if (roll < 0.46) {
      // suspension du tenant
      await db.pool.query(`update tenants set status = 'SUSPENDED' where id = $1 and status = 'ACTIVE'`, [sc.tenantId]);
      activity.suspensions++;
    } else if (roll < 0.5) {
      await db.pool.query(`update tenants set status = 'ACTIVE' where id = $1 and status = 'SUSPENDED'`, [sc.tenantId]);
    } else if (roll < 0.6) {
      await Promise.all([processInbox(deps), processInbox(deps)]);
    } else if (roll < 0.82) {
      await Promise.all([runDueSteps(deps), runDueSteps(deps)]);
    } else if (roll < 0.92) {
      deps.clock.advance({ minutes: Math.floor(rand() * 60 * 24 * 2) + 1 }); // saut d'horloge jusqu'à 2 jours
    } else {
      await closeExhaustedCases(deps);
    }

    // invariant : un dossier terminal ne se rouvre jamais
    const rows = (await db.pool.query(`select id, state from recovery_cases where tenant_id = any($1)`, [tenantIds])).rows;
    for (const r of rows) {
      const before = stateSeen.get(r.id);
      if (before && TERMINAL.has(before)) expect(r.state, `dossier ${r.id} rouvert (graine ${seed})`).toBe(before);
      stateSeen.set(r.id, r.state);
    }
  }

  // réactivation de tous les tenants puis on laisse tout se vider : évènements, envois, retards d'horloge
  await db.pool.query(`update tenants set status = 'ACTIVE' where id = any($1)`, [tenantIds]);
  for (let i = 0; i < 8; i++) {
    deps.clock.advance({ hours: 20 });
    await processInbox(deps);
    await runDueSteps(deps);
    await closeExhaustedCases(deps);
  }

  activity.emails += mailer.sent.length;
  const count = async (state: string) => (await db.pool.query(`select 1 from recovery_cases where tenant_id = any($1) and state = $2`, [tenantIds, state])).rowCount ?? 0;
  activity.recovered += await count('RECOVERED');
  activity.canceled += await count('CANCELED');
  activity.lost += await count('LOST');

  // 1. zéro doublon d'appel au fournisseur : le fake dédoublonne, on compte donc les appels à send.
  //    Un même message n'est rappelé qu'après un échec (timeout) ; un appel abouti ne se répète jamais.
  for (const [key, n] of mailer.calls) {
    expect(mailer.returned.get(key) ?? 0, `clé ${key} acceptée plusieurs fois (graine ${seed})`).toBeLessThanOrEqual(1);
    expect(n, `appels à send pour ${key} (graine ${seed})`).toBeLessThanOrEqual(1 + (mailer.thrown.get(key) ?? 0));
    if (o.failRate === 0) expect(n, `appels à send pour ${key} sans panne (graine ${seed})`).toBe(1);
  }
  const keys = mailer.sent.map((m) => m.idempotencyKey);
  expect(new Set(keys).size, `emails dupliqués (graine ${seed})`).toBe(keys.length);

  // 2. aucun email envoyé hors d'un dossier RECOVERING / d'un tenant ACTIVE (constaté au moment de l'envoi, sous verrou)
  expect(mailer.violations, `envois interdits (graine ${seed})`).toEqual([]);

  // 3. écart minimal entre deux emails d'un même dossier
  const gaps = await db.pool.query(
    `select case_id, sent_at - lag(sent_at) over (partition by case_id order by sent_at) as gap
       from email_messages where tenant_id = any($1) and dry_run = false`,
    [tenantIds],
  );
  for (const g of gaps.rows.filter((r) => r.gap !== null)) {
    const ms = (g.gap.days ?? 0) * 86400_000 + (g.gap.hours ?? 0) * 3600_000 + (g.gap.minutes ?? 0) * 60_000 + (g.gap.seconds ?? 0) * 1000;
    expect(ms, `deux emails trop proches pour ${g.case_id} (graine ${seed})`).toBeGreaterThanOrEqual(MIN_GAP_MS);
  }

  // 4. au plus un envoi enregistré par (dossier, étape), et un email_messages par envoi
  const dup = await db.pool.query(
    `select case_id, step_index, count(*) from scheduled_steps where tenant_id = any($1) and status = 'SENT' group by 1, 2 having count(*) > 1`,
    [tenantIds],
  );
  expect(dup.rows).toEqual([]);
  const recorded = await db.pool.query(`select count(*)::int n from email_messages where tenant_id = any($1) and dry_run = false`, [tenantIds]);
  // (un message parti puis « perdu » par un timeout dont le dossier a été clos entre-temps n'est pas enregistré : cas assumé)
  expect(recorded.rows[0].n, `email_messages != envois acceptés (graine ${seed})`).toBe(mailer.returned.size);

  // 5. ledger cohérent : une ligne RECOVERY par facture payée suivie, montant = montant réellement payé
  const ledger = await db.pool.query(
    `select invoice_id, count(*)::int as n, sum(amount)::int as total from recovery_ledger where tenant_id = any($1) and kind = 'RECOVERY' group by invoice_id`,
    [tenantIds],
  );
  for (const row of ledger.rows) {
    expect(row.n).toBe(1);
    expect(row.total).toBe(paid.get(row.invoice_id));
  }
  const ledgerIds = ledger.rows.map((r) => r.invoice_id);
  // ledger = factures payées : tout dossier dont la facture a été payée (même après LOST/CLOSED_MANUAL) a sa ligne
  const cases = await db.pool.query(`select stripe_invoice_id, state from recovery_cases where tenant_id = any($1)`, [tenantIds]);
  for (const r of cases.rows) {
    if (paid.has(r.stripe_invoice_id)) expect(ledgerIds, `facture payée sans ledger ${r.stripe_invoice_id} (état ${r.state}, graine ${seed})`).toContain(r.stripe_invoice_id);
    else expect(ledgerIds, `ledger pour une facture non payée ${r.stripe_invoice_id} (graine ${seed})`).not.toContain(r.stripe_invoice_id);
    if (r.state === 'RECOVERED') expect(ledgerIds, `RECOVERED sans ledger (graine ${seed})`).toContain(r.stripe_invoice_id);
  }
  const recoveredIds = new Set(cases.rows.filter((r) => r.state === 'RECOVERED').map((r) => r.stripe_invoice_id));
  // une ligne sans RECOVERED vient d'un paiement après clôture : journalisé une seule fois
  for (const id of ledgerIds.filter((i) => !recoveredIds.has(i))) {
    const logged = await db.pool.query(
      `select 1 from action_log a join recovery_cases c on c.id = a.case_id where c.tenant_id = any($1) and c.stripe_invoice_id = $2 and a.action = 'case.paid_after_close'`,
      [tenantIds, id],
    );
    expect(logged.rowCount, `paiement après clôture non journalisé ${id} (graine ${seed})`).toBe(1);
  }
  // le net (RECOVERY + ajustements) ne devient jamais négatif ni supérieur au payé
  const net = await db.pool.query(`select invoice_id, sum(amount)::int total from recovery_ledger where tenant_id = any($1) group by 1`, [tenantIds]);
  for (const row of net.rows) {
    expect(row.total).toBeGreaterThanOrEqual(0);
    expect(row.total).toBeLessThanOrEqual(paid.get(row.invoice_id) ?? 0);
  }

  // 6. rien ne reste bloqué : étapes SENDING, évènements en attente ou morts, évènements de clôture ignorés
  const stuck = await db.pool.query(`select 1 from scheduled_steps where tenant_id = any($1) and status = 'SENDING'`, [tenantIds]);
  expect(stuck.rowCount).toBe(0);
  const pending = await db.pool.query(`select 1 from inbox_events where tenant_id = any($1) and status in ('pending', 'processing', 'dead')`, [tenantIds]);
  expect(pending.rowCount, `évènements non traités (graine ${seed})`).toBe(0);
  const ignored = await db.pool.query(
    `select type from inbox_events where tenant_id = any($1) and status = 'ignored' and type in ('invoice.paid', 'invoice.voided', 'charge.refunded')`,
    [tenantIds],
  );
  expect(ignored.rows, `évènements de clôture ignorés (graine ${seed})`).toEqual([]);
}

describe('chaos : évènements dupliqués, désordonnés, envois qui plantent, horloge qui saute', () => {
  for (const seed of [1, 2, 3, 7, 11, 42, 99, 2024]) {
    it(`graine ${seed} : invariants respectés`, async () => {
      await runChaos(seed);
    }, 60000);
  }
  // sans panne du fournisseur : exactement un appel à send par message
  for (const seed of [5, 13, 77]) {
    it(`graine ${seed} sans panne : un seul appel à send par clé`, async () => {
      await runChaos(seed, { failRate: 0 });
    }, 60000);
  }

  // autonome : rejoue des graines dans le test lui-même (ne dépend pas de l'ordre ni d'un `-t`)
  it('le scénario exerce vraiment le système (emails, récupérations, annulations, plaintes, suspensions, paiements tardifs)', async () => {
    const before = { ...activity };
    for (const seed of [1, 2, 3, 7, 11, 42]) await runChaos(seed + 1000);
    const seen = (k: keyof typeof activity) => activity[k] - before[k];
    expect(seen('emails')).toBeGreaterThan(5);
    expect(seen('recovered')).toBeGreaterThan(0);
    expect(seen('canceled')).toBeGreaterThan(0);
    expect(seen('suspensions')).toBeGreaterThan(0);
    expect(seen('refundsBeforePay')).toBeGreaterThan(0);
    expect(seen('manual')).toBeGreaterThan(0);
    expect(seen('complaints')).toBeGreaterThan(0);
    expect(seen('paidAfterClose')).toBeGreaterThan(0);
  }, 240000);
});
