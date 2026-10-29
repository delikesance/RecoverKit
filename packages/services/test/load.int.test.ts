import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '@recoverkit/testkit';
import { runDueSteps } from '../src/engine/send-steps';
import { makeDeps } from './helpers';

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.dispose();
});

const TENANTS = 50;
const PER_TENANT = 100; // 5 000 étapes échues au total

describe('charge : 5 000 étapes échues, 3 workers en parallèle', () => {
  it('aucun doublon, tout est traité, chaque tenant est servi', async () => {
    const deps = makeDeps(db, new Date('2026-10-02T10:00:00Z'));

    const tenants = await db.pool.query(
      `insert into tenants (name, dry_run) select 'T' || g, false from generate_series(1, $1::int) g returning id`,
      [TENANTS],
    );
    const tenantIds: string[] = tenants.rows.map((r) => r.id);
    for (let i = 0; i < TENANTS; i++) {
      await db.pool.query(`insert into stripe_connections (tenant_id, stripe_account_id, status) values ($1,$2,'ACTIVE')`, [tenantIds[i], `acct_load_${i}`]);
    }
    for (let i = 0; i < TENANTS; i++) {
      const t = tenantIds[i]!;
      const acct = `acct_load_${i}`;
      await db.pool.query(
        `insert into end_customers (tenant_id, stripe_customer_id, email, name, locale)
         select $1, 'cus_' || g, 'c' || g || '@t' || $2::int || '.example', 'Client ' || g, 'fr' from generate_series(1, $3::int) g`,
        [t, i, PER_TENANT],
      );
      await db.pool.query(
        `insert into recovery_cases (tenant_id, stripe_invoice_id, stripe_customer_id, stripe_subscription_id, end_customer_id, state, amount_due, currency, plan_name, failed_at)
         select $1, 'in_' || e.stripe_customer_id, e.stripe_customer_id, 'sub_' || e.stripe_customer_id, e.id, 'RECOVERING', 2900, 'EUR', 'Pro', $2
           from end_customers e where e.tenant_id = $1`,
        [t, new Date('2026-10-02T07:00:00Z')],
      );
      await db.pool.query(
        `insert into scheduled_steps (case_id, tenant_id, step_index, due_at)
         select c.id, c.tenant_id, 0, $2::timestamptz + (random() * interval '30 minutes') from recovery_cases c where c.tenant_id = $1`,
        [t, new Date('2026-10-02T08:00:00Z')],
      );
      for (let g = 1; g <= PER_TENANT; g++) {
        deps.stripe.addInvoice(acct, {
          id: `in_cus_${g}`, customerId: `cus_${g}`, subscriptionId: `sub_cus_${g}`, status: 'open',
          amountDue: 2900, amountPaid: 0, currency: 'EUR', attemptCount: 1, planName: 'Pro',
        });
      }
    }

    const worker = async () => {
      let total = 0;
      for (;;) {
        const s = await runDueSteps(deps, { limit: 100 });
        const n = s.sent + s.skipped + s.failed;
        if (n === 0 && s.released === 0) return total;
        total += n;
      }
    };
    const started = Date.now();
    const counts = await Promise.all([worker(), worker(), worker()]);
    const elapsed = Date.now() - started;

    expect(counts.reduce((a, b) => a + b, 0)).toBe(TENANTS * PER_TENANT);
    const keys = deps.mailer.sent.map((m) => m.idempotencyKey);
    expect(keys).toHaveLength(TENANTS * PER_TENANT);
    expect(new Set(keys).size).toBe(keys.length); // 0 doublon
    // le fake dédoublonne : on exige un seul appel à send par clé
    expect(deps.mailer.calls.size).toBe(TENANTS * PER_TENANT);
    expect([...deps.mailer.calls.values()].filter((n) => n !== 1)).toEqual([]);
    const status = await db.pool.query(`select status, count(*)::int n from scheduled_steps group by status`);
    expect(Object.fromEntries(status.rows.map((r) => [r.status, r.n]))).toEqual({ SENT: TENANTS * PER_TENANT });
    const emails = await db.pool.query(`select count(*)::int n, count(distinct idempotency_key)::int d from email_messages`);
    expect(emails.rows[0]).toEqual({ n: TENANTS * PER_TENANT, d: TENANTS * PER_TENANT });
    // informatif : débit observé
    console.log(`charge: ${TENANTS * PER_TENANT} emails en ${elapsed} ms (${Math.round((TENANTS * PER_TENANT * 1000) / elapsed)}/s)`);
  }, 240_000);
});
