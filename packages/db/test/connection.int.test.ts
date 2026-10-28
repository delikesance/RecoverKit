import { afterAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '@recoverkit/testkit';

describe('base de test', () => {
  const dbs: TestDb[] = [];
  afterAll(async () => {
    await Promise.all(dbs.map((d) => d.dispose()));
  });

  it('se connecte et répond à SELECT 1', async () => {
    const db = await createTestDb();
    dbs.push(db);
    const res = await db.pool.query('select 1 as one');
    expect(res.rows[0].one).toBe(1);
  });

  it('applique les migrations (tables métier présentes)', async () => {
    const db = await createTestDb();
    dbs.push(db);
    const res = await db.pool.query(
      `select table_name from information_schema.tables where table_schema = 'public' order by 1`,
    );
    const names = res.rows.map((r) => r.table_name);
    for (const t of ['tenants', 'users', 'sessions', 'inbox_events', 'recovery_cases', 'scheduled_steps', 'action_log', 'recovery_ledger']) {
      expect(names).toContain(t);
    }
  });

  it('isole deux bases créées en parallèle', async () => {
    const [a, b] = await Promise.all([createTestDb(), createTestDb()]);
    dbs.push(a, b);
    expect(a.name).not.toBe(b.name);
    await a.pool.query(`insert into tenants (name) values ('A')`);
    const inB = await b.pool.query('select count(*)::int as n from tenants');
    expect(inB.rows[0].n).toBe(0);
  });
});
