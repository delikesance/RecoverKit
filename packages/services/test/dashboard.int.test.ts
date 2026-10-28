import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, seedCase, seedStep, seedTenant, type TestDb } from '@recoverkit/testkit';
import { getBannerAlerts, getCaseDetail, getDashboard, listCases, listRecovered } from '../src/dashboard/queries';
import { makeDeps } from './helpers';

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.dispose();
});

const NOW = new Date('2026-10-28T10:00:00Z');

async function customer(tenantId: string, id: string, name: string, email: string) {
  const r = await db.pool.query(`insert into end_customers (tenant_id, stripe_customer_id, email, name, locale) values ($1,$2,$3,$4,'fr') returning id`, [tenantId, id, email, name]);
  return r.rows[0].id as string;
}
async function ledger(tenantId: string, caseId: string, invoice: string, o: { kind?: string; attribution: string; amount: number; at: string; currency?: string }) {
  await db.pool.query(
    `insert into recovery_ledger (tenant_id, case_id, invoice_id, kind, attribution, amount, currency, occurred_at) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [tenantId, caseId, invoice, o.kind ?? 'RECOVERY', o.attribution, o.amount, o.currency ?? 'EUR', new Date(o.at)],
  );
}
async function closedCase(tenantId: string, state: string, closedAt: string, o: { amount?: number; custId?: string } = {}) {
  const c = await seedCase(db.pool, tenantId, { state, amountDue: o.amount ?? 2900, customerId: o.custId });
  await db.pool.query(`update recovery_cases set closed_at = $2 where id = $1`, [c.id, new Date(closedAt)]);
  return c;
}

describe('getDashboard', () => {
  it('calcule le revenu récupéré (ASSISTED), le naturel à part, les clients sauvés et la variation', async () => {
    const deps = makeDeps(db, NOW);
    const t = await seedTenant(db.pool);
    const a = await closedCase(t.id, 'RECOVERED', '2026-10-05T10:00:00Z');
    const b = await closedCase(t.id, 'RECOVERED', '2026-10-06T10:00:00Z');
    const n = await closedCase(t.id, 'RECOVERED', '2026-10-07T10:00:00Z');
    const prev = await closedCase(t.id, 'RECOVERED', '2026-09-10T10:00:00Z');
    await ledger(t.id, a.id, a.invoiceId, { attribution: 'ASSISTED', amount: 7900, at: '2026-10-05T10:00:00Z' });
    await ledger(t.id, b.id, b.invoiceId, { attribution: 'ASSISTED', amount: 2900, at: '2026-10-06T10:00:00Z' });
    await ledger(t.id, n.id, n.invoiceId, { attribution: 'NATURAL', amount: 3100, at: '2026-10-07T10:00:00Z' });
    await ledger(t.id, prev.id, prev.invoiceId, { attribution: 'ASSISTED', amount: 9000, at: '2026-09-10T10:00:00Z' });
    await ledger(t.id, a.id, a.invoiceId, { kind: 'ADJUSTMENT', attribution: 'ASSISTED', amount: -1000, at: '2026-10-12T10:00:00Z' });

    const d = await getDashboard(deps, t.id, { year: 2026, month: 10 });
    expect(d.currency).toBe('EUR');
    expect(d.recovered).toBe(9800); // 7900 + 2900 - 1000
    expect(d.natural).toBe(3100);
    expect(d.savedCustomers).toBe(2);
    expect(d.previousRecovered).toBe(9000);
    expect(d.variation).toBeCloseTo((9800 - 9000) / 9000);
  });

  it('variation nulle quand le mois précédent est vide ; tout à zéro sans données', async () => {
    const deps = makeDeps(db, NOW);
    const t = await seedTenant(db.pool);
    const empty = await getDashboard(deps, t.id, { year: 2026, month: 10 });
    expect(empty).toMatchObject({ currency: null, recovered: 0, natural: 0, savedCustomers: 0, variation: null, atRisk: { amount: 0, count: 0 } });
    expect(empty.recent).toEqual([]);

    const c = await closedCase(t.id, 'RECOVERED', '2026-10-05T10:00:00Z');
    await ledger(t.id, c.id, c.invoiceId, { attribution: 'ASSISTED', amount: 100, at: '2026-10-05T10:00:00Z' });
    expect((await getDashboard(deps, t.id, { year: 2026, month: 10 })).variation).toBeNull();
  });

  it('montant à risque : dossiers en cours (relance, pause, ouverts), pas les clos', async () => {
    const deps = makeDeps(db, NOW);
    const t = await seedTenant(db.pool);
    await seedCase(db.pool, t.id, { state: 'RECOVERING', amountDue: 7900 });
    await seedCase(db.pool, t.id, { state: 'PAUSED', amountDue: 15600 });
    await seedCase(db.pool, t.id, { state: 'RECOVERED', amountDue: 99999 });
    await seedCase(db.pool, t.id, { state: 'LOST', amountDue: 5555 });
    const d = await getDashboard(deps, t.id, { year: 2026, month: 10 });
    expect(d.atRisk).toEqual({ amount: 23500, count: 2 });
  });

  it('taux de récupération = sauvés / (sauvés + perdus) du mois', async () => {
    const deps = makeDeps(db, NOW);
    const t = await seedTenant(db.pool);
    for (let i = 0; i < 3; i++) {
      const c = await closedCase(t.id, 'RECOVERED', '2026-10-05T10:00:00Z');
      await ledger(t.id, c.id, c.invoiceId, { attribution: 'ASSISTED', amount: 1000, at: '2026-10-05T10:00:00Z' });
    }
    await closedCase(t.id, 'LOST', '2026-10-09T10:00:00Z', { amount: 1000 });
    await closedCase(t.id, 'CANCELED', '2026-10-10T10:00:00Z');
    await closedCase(t.id, 'LOST', '2026-09-09T10:00:00Z');
    const d = await getDashboard(deps, t.id, { year: 2026, month: 10 });
    expect(d.rate.recovered).toBe(3);
    expect(d.rate.lost).toBe(1);
    expect(d.rate.byCount).toBeCloseTo(0.75);
    expect(d.rate.byAmount).toBeCloseTo(3000 / 4000);
  });

  it('série cumulée par jour : plateau entre les paiements, jusqu’à aujourd’hui', async () => {
    const deps = makeDeps(db, NOW);
    const t = await seedTenant(db.pool);
    const a = await closedCase(t.id, 'RECOVERED', '2026-10-03T10:00:00Z');
    const b = await closedCase(t.id, 'RECOVERED', '2026-10-05T10:00:00Z');
    await ledger(t.id, a.id, a.invoiceId, { attribution: 'ASSISTED', amount: 1000, at: '2026-10-03T10:00:00Z' });
    await ledger(t.id, b.id, b.invoiceId, { attribution: 'ASSISTED', amount: 500, at: '2026-10-05T10:00:00Z' });
    const d = await getDashboard(deps, t.id, { year: 2026, month: 10 });
    expect(d.series).toHaveLength(28); // du 1er au 28 oct. (aujourd'hui)
    expect(d.series[0]).toEqual({ date: '2026-10-01', cumulative: 0 });
    expect(d.series[2]).toEqual({ date: '2026-10-03', cumulative: 1000 });
    expect(d.series[3]).toEqual({ date: '2026-10-04', cumulative: 1000 });
    expect(d.series[4]).toEqual({ date: '2026-10-05', cumulative: 1500 });
    expect(d.series.at(-1)).toEqual({ date: '2026-10-28', cumulative: 1500 });
  });

  it('un mois passé est complet', async () => {
    const deps = makeDeps(db, NOW);
    const t = await seedTenant(db.pool);
    expect((await getDashboard(deps, t.id, { year: 2026, month: 9 })).series).toHaveLength(30);
  });

  it('plusieurs devises : jamais additionnées, la principale est celle qui récupère le plus', async () => {
    const deps = makeDeps(db, NOW);
    const t = await seedTenant(db.pool);
    const a = await closedCase(t.id, 'RECOVERED', '2026-10-05T10:00:00Z');
    const b = await closedCase(t.id, 'RECOVERED', '2026-10-05T10:00:00Z');
    await ledger(t.id, a.id, a.invoiceId, { attribution: 'ASSISTED', amount: 5000, at: '2026-10-05T10:00:00Z', currency: 'USD' });
    await ledger(t.id, b.id, b.invoiceId, { attribution: 'ASSISTED', amount: 1000, at: '2026-10-05T10:00:00Z', currency: 'EUR' });
    const d = await getDashboard(deps, t.id, { year: 2026, month: 10 });
    expect(d.currency).toBe('USD');
    expect(d.recovered).toBe(5000);
    expect(d.otherCurrencies).toEqual(['EUR']);
    expect((await getDashboard(deps, t.id, { year: 2026, month: 10, currency: 'EUR' })).recovered).toBe(1000);
  });

  it('dernières récupérations : client, montant, attribution, et après quel email', async () => {
    const deps = makeDeps(db, NOW);
    const t = await seedTenant(db.pool);
    const cust = await customer(t.id, 'cus_r', 'Léa Martin', 'lea@example.com');
    const c = await closedCase(t.id, 'RECOVERED', '2026-10-05T10:00:00Z', { custId: 'cus_r' });
    await db.pool.query(`update recovery_cases set end_customer_id = $2 where id = $1`, [c.id, cust]);
    for (const [i, at] of [[0, '2026-10-01T09:00:00Z'], [1, '2026-10-04T08:00:00Z'], [2, '2026-10-09T08:00:00Z']] as const) {
      await db.pool.query(`insert into email_messages (tenant_id, case_id, step_index, idempotency_key, to_email, subject, sent_at) values ($1,$2,$3,$4,'lea@example.com','s',$5)`, [t.id, c.id, i, `${c.id}:${i}`, new Date(at)]);
    }
    await ledger(t.id, c.id, c.invoiceId, { attribution: 'ASSISTED', amount: 2900, at: '2026-10-05T10:00:00Z' });
    const d = await getDashboard(deps, t.id, { year: 2026, month: 10 });
    expect(d.recent).toHaveLength(1);
    expect(d.recent[0]).toMatchObject({ customerName: 'Léa Martin', amount: 2900, currency: 'EUR', attribution: 'ASSISTED', afterEmail: 2 });
  });

  it('isolation : un tenant ne voit jamais les données d’un autre', async () => {
    const deps = makeDeps(db, NOW);
    const a = await seedTenant(db.pool);
    const b = await seedTenant(db.pool);
    const c = await closedCase(a.id, 'RECOVERED', '2026-10-05T10:00:00Z');
    await ledger(a.id, c.id, c.invoiceId, { attribution: 'ASSISTED', amount: 9999, at: '2026-10-05T10:00:00Z' });
    await seedCase(db.pool, a.id, { state: 'RECOVERING' });
    const d = await getDashboard(deps, b.id, { year: 2026, month: 10 });
    expect(d).toMatchObject({ recovered: 0, atRisk: { count: 0 } });
    expect((await listCases(deps, b.id, {})).total).toBe(0);
    expect((await listRecovered(deps, b.id, { year: 2026, month: 10 })).total).toBe(0);
  });
});

describe('listCases', () => {
  async function seed() {
    const t = await seedTenant(db.pool);
    const make = async (name: string, state: string, amount: number, failedAt: string, sent: number, total = 4) => {
      const cust = await customer(t.id, `cus_${name}`, name, `${name.toLowerCase()}@example.com`);
      const c = await seedCase(db.pool, t.id, { state, amountDue: amount, failedAt: new Date(failedAt), customerId: `cus_${name}` });
      await db.pool.query(`update recovery_cases set end_customer_id = $2, last_failure_code = 'card_declined' where id = $1`, [c.id, cust]);
      for (let i = 0; i < total; i++) {
        await seedStep(db.pool, c.id, t.id, { stepIndex: i, status: i < sent ? 'SENT' : 'SCHEDULED', dueAt: new Date(`2026-10-${10 + i}T08:00:00Z`) });
      }
      return c;
    };
    await make('Camille', 'RECOVERING', 7900, '2026-10-17T08:00:00Z', 3);
    await make('Brume', 'RECOVERING', 14900, '2026-10-22T08:00:00Z', 2);
    await make('Hugo', 'RECOVERING', 2900, '2026-10-25T08:00:00Z', 2);
    await make('Ines', 'PAUSED', 15600, '2026-10-23T08:00:00Z', 1);
    await make('Clos', 'RECOVERED', 1000, '2026-10-01T08:00:00Z', 4);
    return t;
  }

  it('liste les dossiers en cours par défaut, du plus ancien au plus récent, avec la progression', async () => {
    const deps = makeDeps(db, NOW);
    const t = await seed();
    const r = await listCases(deps, t.id, {});
    expect(r.total).toBe(4);
    expect(r.rows.map((x) => x.customerName)).toEqual(['Camille', 'Brume', 'Ines', 'Hugo']);
    expect(r.rows[0]).toMatchObject({ amount: 7900, currency: 'EUR', state: 'RECOVERING', stepsSent: 3, stepsTotal: 4, failureCode: 'card_declined', daysSinceFailure: 11 });
    expect(r.rows[0]!.nextDueAt).toEqual(new Date('2026-10-13T08:00:00Z'));
  });

  it('filtre par état et par montant, trie, pagine', async () => {
    const deps = makeDeps(db, NOW);
    const t = await seed();
    expect((await listCases(deps, t.id, { states: ['PAUSED'] })).rows.map((x) => x.customerName)).toEqual(['Ines']);
    expect((await listCases(deps, t.id, { minAmount: 10000 })).rows.map((x) => x.customerName)).toEqual(['Brume', 'Ines']);
    expect((await listCases(deps, t.id, { maxAmount: 8000 })).total).toBe(2);
    expect((await listCases(deps, t.id, { sort: 'amount_desc' })).rows.map((x) => x.customerName)).toEqual(['Ines', 'Brume', 'Camille', 'Hugo']);
    const p2 = await listCases(deps, t.id, { sort: 'amount_desc', page: 2, pageSize: 3 });
    expect(p2.rows.map((x) => x.customerName)).toEqual(['Hugo']);
    expect(p2.total).toBe(4);
    expect((await listCases(deps, t.id, { states: ['RECOVERED'] })).rows).toHaveLength(1);
  });

  it('refuse un tri ou un état inconnu (pas d’injection SQL)', async () => {
    const deps = makeDeps(db, NOW);
    const t = await seed();
    await expect(listCases(deps, t.id, { sort: 'amount; drop table tenants' as any })).rejects.toThrow(/tri/);
    await expect(listCases(deps, t.id, { states: ['X\'; --'] as any })).rejects.toThrow(/état/);
  });
});

describe('listRecovered', () => {
  it('liste les paiements récupérés du mois avec la règle d’attribution', async () => {
    const deps = makeDeps(db, NOW);
    const t = await seedTenant(db.pool);
    const a = await closedCase(t.id, 'RECOVERED', '2026-10-05T10:00:00Z');
    const n = await closedCase(t.id, 'RECOVERED', '2026-10-07T10:00:00Z');
    await ledger(t.id, a.id, a.invoiceId, { attribution: 'ASSISTED', amount: 2900, at: '2026-10-05T10:00:00Z' });
    await ledger(t.id, n.id, n.invoiceId, { attribution: 'NATURAL', amount: 3100, at: '2026-10-07T10:00:00Z' });
    await ledger(t.id, a.id, a.invoiceId, { kind: 'ADJUSTMENT', attribution: 'ASSISTED', amount: -500, at: '2026-10-08T10:00:00Z' });
    const r = await listRecovered(deps, t.id, { year: 2026, month: 10 });
    expect(r.total).toBe(3);
    expect(r.rows.map((x) => [x.kind, x.attribution, x.amount])).toEqual([['ADJUSTMENT', 'ASSISTED', -500], ['RECOVERY', 'NATURAL', 3100], ['RECOVERY', 'ASSISTED', 2900]]);
    expect(r.rows[2]!.stripeInvoiceUrl).toBe(`https://dashboard.stripe.com/invoices/${a.invoiceId}`);
  });
});

describe('getCaseDetail', () => {
  it('assemble facture, étapes, emails et chronologie triée', async () => {
    const deps = makeDeps(db, NOW);
    const t = await seedTenant(db.pool);
    const cust = await customer(t.id, 'cus_d', 'Camille Roux', 'camille@example.com');
    const c = await seedCase(db.pool, t.id, { state: 'RECOVERING', amountDue: 7900, customerId: 'cus_d', failedAt: new Date('2026-10-17T08:00:00Z') });
    await db.pool.query(`update recovery_cases set end_customer_id = $2, plan_name = 'Pro', attempt_count = 2 where id = $1`, [c.id, cust]);
    await seedStep(db.pool, c.id, t.id, { stepIndex: 0, status: 'SENT' });
    await seedStep(db.pool, c.id, t.id, { stepIndex: 1, status: 'SCHEDULED', dueAt: new Date('2026-10-29T08:00:00Z') });
    await db.pool.query(`insert into email_messages (tenant_id, case_id, step_index, idempotency_key, to_email, subject, sent_at, opened_at) values ($1,$2,0,$3,'camille@example.com','Votre paiement a échoué',$4,$5)`, [t.id, c.id, `${c.id}:0`, new Date('2026-10-17T09:00:00Z'), new Date('2026-10-17T10:00:00Z')]);
    await db.pool.query(`insert into action_log (tenant_id, case_id, actor, action, details, created_at) values ($1,$2,'stripe','case.opened','{}',$3), ($1,$2,'system','email.sent','{"stepIndex":0}',$4)`, [t.id, c.id, new Date('2026-10-17T08:00:01Z'), new Date('2026-10-17T09:00:00Z')]);

    const d = await getCaseDetail(deps, t.id, c.id);
    expect(d).not.toBeNull();
    expect(d!.customer).toMatchObject({ name: 'Camille Roux', email: 'camille@example.com' });
    expect(d!.case).toMatchObject({ amountDue: 7900, planName: 'Pro', attemptCount: 2, state: 'RECOVERING' });
    expect(d!.steps.map((s) => [s.stepIndex, s.status])).toEqual([[0, 'SENT'], [1, 'SCHEDULED']]);
    expect(d!.emails[0]).toMatchObject({ subject: 'Votre paiement a échoué', opened: true, clicked: false });
    expect(d!.timeline.map((e) => e.action)).toEqual(['case.opened', 'email.sent']);
    expect(d!.stripeInvoiceUrl).toContain(c.invoiceId);
  });

  it('renvoie null pour un dossier d’un autre tenant', async () => {
    const deps = makeDeps(db, NOW);
    const a = await seedTenant(db.pool);
    const b = await seedTenant(db.pool);
    const c = await seedCase(db.pool, a.id);
    expect(await getCaseDetail(deps, b.id, c.id)).toBeNull();
  });
});

describe('getBannerAlerts', () => {
  it('signale les dossiers au dernier avis dans les 48 h, la connexion coupée et les alertes ouvertes', async () => {
    const deps = makeDeps(db, NOW);
    const t = await seedTenant(db.pool);
    const cust = await customer(t.id, 'cus_b', 'Camille Roux', 'c@example.com');
    const c = await seedCase(db.pool, t.id, { state: 'RECOVERING', amountDue: 7900, customerId: 'cus_b' });
    await db.pool.query(`update recovery_cases set end_customer_id = $2 where id = $1`, [c.id, cust]);
    await seedStep(db.pool, c.id, t.id, { stepIndex: 0, status: 'SENT' });
    await seedStep(db.pool, c.id, t.id, { stepIndex: 3, status: 'SCHEDULED', dueAt: new Date('2026-10-29T07:00:00Z') });
    await db.pool.query(`insert into stripe_connections (tenant_id, stripe_account_id, status) values ($1,'acct_b','REVOKED')`, [t.id]);
    await db.pool.query(`insert into system_alerts (tenant_id, kind, dedupe_key, message) values ($1,'email_failed','k1','Un email n''a pas pu être envoyé.')`, [t.id]);

    const alerts = await getBannerAlerts(deps, t.id);
    expect(alerts.map((a) => a.kind)).toEqual(expect.arrayContaining(['last_notice', 'stripe_revoked', 'email_failed']));
    const last = alerts.find((a) => a.kind === 'last_notice')!;
    expect(last.message).toContain('Camille Roux');
    expect(last.href).toBe(`/app/cases/${c.id}`);
    expect(alerts[0]!.severity).toBe('critical'); // les plus graves d'abord
  });

  it('aucune alerte quand tout va bien', async () => {
    const deps = makeDeps(db, NOW);
    const t = await seedTenant(db.pool);
    await db.pool.query(`insert into stripe_connections (tenant_id, stripe_account_id, status) values ($1,'acct_ok','ACTIVE')`, [t.id]);
    expect(await getBannerAlerts(deps, t.id)).toEqual([]);
  });

  it('une absence de connexion Stripe est signalée', async () => {
    const deps = makeDeps(db, NOW);
    const t = await seedTenant(db.pool);
    expect((await getBannerAlerts(deps, t.id)).map((a) => a.kind)).toContain('stripe_missing');
  });
});
