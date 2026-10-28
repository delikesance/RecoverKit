import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeMailer, MailerError } from '@recoverkit/mail';
import { createTestDb, type TestDb } from '@recoverkit/testkit';
import { processInbox } from '../src/webhooks/process';
import { closeExhaustedCases, runDueSteps } from '../src/engine/send-steps';
import { makeDeps } from './helpers';
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

/** Envoie l'email puis « plante » : le fournisseur a bien reçu le message mais la réponse se perd. */
class FlakyMailer extends FakeMailer {
  constructor(private readonly rand: () => number) {
    super();
  }
  override async send(e: Parameters<FakeMailer['send']>[0]) {
    const roll = this.rand();
    if (roll < 0.1) throw new MailerError('indisponible avant envoi', { permanent: false });
    const r = await super.send(e);
    if (roll < 0.2) throw new MailerError('timeout après envoi', { permanent: false });
    return r;
  }
}

const TERMINAL = new Set(['RECOVERED', 'CANCELED', 'LOST', 'CLOSED_MANUAL']);

const activity = { emails: 0, recovered: 0, canceled: 0 };

async function runChaos(seed: number) {
  const rand = rng(seed);
  const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)]!;
  const deps = makeDeps(db, new Date('2026-11-03T09:00:00Z'));
  deps.mailer = new FlakyMailer(rand);
  const mailer = deps.mailer as FlakyMailer;

  const scenarios: Scenario[] = [];
  for (let i = 0; i < 6; i++) scenarios.push(await setupScenario(db, deps));
  const paid = new Map<string, number>(); // invoiceId -> montant payé
  const stateSeen = new Map<string, string>();
  const eventIds = new Map<string, string>(); // pour rejouer exactement le même évènement

  const pay = async (s: Scenario) => {
    deps.stripe.markPaid(s.account, s.invoiceId, deps.clock.now());
    paid.set(s.invoiceId, 2900);
    await deliver(deps, s, 'invoice.paid', invoiceObject(s, { status: 'paid', amount_paid: 2900 }));
  };

  for (let tick = 0; tick < 60; tick++) {
    const s = pick(scenarios);
    const roll = rand();
    if (roll < 0.25) {
      // échec de paiement, parfois rejeu du même évènement Stripe, parfois nouvelle livraison (autre id)
      const id = eventIds.get(s.invoiceId);
      const replay = id && rand() < 0.5;
      const d = await deliver(deps, s, 'invoice.payment_failed', invoiceObject(s, { attempt_count: 1 + Math.floor(rand() * 3) }), replay ? { id } : {});
      if (!replay) eventIds.set(s.invoiceId, d.eventId);
    } else if (roll < 0.33 && !paid.has(s.invoiceId)) {
      await pay(s); // possiblement avant même que l'échec ait été traité (désordre)
    } else if (roll < 0.4) {
      await deliver(deps, s, 'invoice.voided', invoiceObject(s, { status: 'void' }));
    } else if (roll < 0.6) {
      await Promise.all([processInbox(deps), processInbox(deps)]);
    } else if (roll < 0.85) {
      await Promise.all([runDueSteps(deps), runDueSteps(deps)]);
    } else if (roll < 0.95) {
      deps.clock.advance({ minutes: Math.floor(rand() * 60 * 24 * 2) + 1 }); // saut d'horloge jusqu'à 2 jours
    } else {
      await closeExhaustedCases(deps);
    }

    // invariant : un dossier terminal ne se rouvre jamais
    const rows = (await db.pool.query(`select id, state from recovery_cases where tenant_id = any($1)`, [scenarios.map((x) => x.tenantId)])).rows;
    for (const r of rows) {
      const before = stateSeen.get(r.id);
      if (before && TERMINAL.has(before)) expect(r.state, `dossier ${r.id} rouvert (graine ${seed})`).toBe(before);
      stateSeen.set(r.id, r.state);
    }
  }

  // on laisse tout se vider : évènements, envois, retards d'horloge
  for (let i = 0; i < 6; i++) {
    deps.clock.advance({ hours: 20 });
    await processInbox(deps);
    await runDueSteps(deps);
    await closeExhaustedCases(deps);
  }

  const tenantIds = scenarios.map((x) => x.tenantId);

  activity.emails += mailer.sent.length;
  activity.recovered += (await db.pool.query(`select 1 from recovery_cases where tenant_id = any($1) and state = 'RECOVERED'`, [tenantIds])).rowCount ?? 0;
  activity.canceled += (await db.pool.query(`select 1 from recovery_cases where tenant_id = any($1) and state = 'CANCELED'`, [tenantIds])).rowCount ?? 0;

  // 1. zéro doublon d'email : une clé d'idempotence = un seul message chez le fournisseur
  const keys = mailer.sent.map((m) => m.idempotencyKey);
  expect(new Set(keys).size, `emails dupliqués (graine ${seed})`).toBe(keys.length);

  // 2. au plus un envoi enregistré par (dossier, étape)
  const dup = await db.pool.query(
    `select case_id, step_index, count(*) from scheduled_steps where tenant_id = any($1) and status = 'SENT' group by 1, 2 having count(*) > 1`,
    [tenantIds],
  );
  expect(dup.rows).toEqual([]);

  // 3. aucun email envoyé après la clôture du dossier
  const late = await db.pool.query(
    `select s.id from scheduled_steps s join recovery_cases c on c.id = s.case_id
      where s.tenant_id = any($1) and s.status = 'SENT' and c.closed_at is not null and s.sent_at > c.closed_at`,
    [tenantIds],
  );
  expect(late.rows, `email après clôture (graine ${seed})`).toEqual([]);

  // 4. ledger cohérent : une ligne RECOVERY par facture payée suivie, montant = montant réellement payé
  const ledger = await db.pool.query(
    `select invoice_id, count(*)::int as n, sum(amount)::int as total from recovery_ledger where tenant_id = any($1) and kind = 'RECOVERY' group by invoice_id`,
    [tenantIds],
  );
  for (const row of ledger.rows) {
    expect(row.n).toBe(1);
    expect(row.total).toBe(paid.get(row.invoice_id));
  }
  const recovered = await db.pool.query(`select stripe_invoice_id from recovery_cases where tenant_id = any($1) and state = 'RECOVERED'`, [tenantIds]);
  expect(recovered.rows.map((r) => r.stripe_invoice_id).sort()).toEqual(ledger.rows.map((r) => r.invoice_id).sort());

  // 5. rien ne reste bloqué en cours d'envoi
  const stuck = await db.pool.query(`select 1 from scheduled_steps where tenant_id = any($1) and status = 'SENDING'`, [tenantIds]);
  expect(stuck.rowCount).toBe(0);
  const pending = await db.pool.query(`select 1 from inbox_events where tenant_id = any($1) and status in ('pending')`, [tenantIds]);
  expect(pending.rowCount).toBe(0);
}

describe('chaos : évènements dupliqués, désordonnés, envois qui plantent, horloge qui saute', () => {
  for (const seed of [1, 2, 3, 7, 11, 42, 99, 2024]) {
    it(`graine ${seed} : invariants respectés`, async () => {
      await runChaos(seed);
    }, 60000);
  }

  it('le scénario exerce vraiment le système (emails envoyés, dossiers récupérés et annulés)', () => {
    expect(activity.emails).toBeGreaterThan(5);
    expect(activity.recovered).toBeGreaterThan(0);
    expect(activity.canceled).toBeGreaterThan(0);
  });
});
