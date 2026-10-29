import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, seedTenant, type TestDb } from '@recoverkit/testkit';
import { acknowledgeNativeEmails, setDryRun, updateSettings } from '../src/settings/general';
import { sendTestEmail } from '../src/settings/templates';
import { makeDeps } from './helpers';

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.dispose();
});

async function readyTenant(name: string) {
  const deps = makeDeps(db);
  const t = await seedTenant(db.pool, { dryRun: true, name });
  await db.pool.query(`insert into sequences (tenant_id, version, steps) values ($1, 1, '[{"index":0,"delayMinutes":60,"active":true}]'::jsonb)`, [t.id]);
  await db.pool.query(`insert into stripe_connections (tenant_id, stripe_account_id, status) values ($1,$2,'ACTIVE')`, [t.id, `acct_${t.id.slice(0, 8)}`]);
  await acknowledgeNativeEmails(deps, t.id);
  await sendTestEmail(deps, t.id, 'f@example.com', { stepIndex: 0, locale: 'fr' });
  return { deps, t };
}

describe('activation et nom affiché aux clients', () => {
  it('refuse l’activation tant que le nom vaut le nom par défaut', async () => {
    const { deps, t } = await readyTenant('Mon entreprise');
    expect(await setDryRun(deps, t.id, false, 'user:u1')).toEqual({ status: 'blocked', missing: ['company_name'] });
    const dry = (await db.pool.query(`select dry_run from tenants where id = $1`, [t.id])).rows[0].dry_run;
    expect(dry).toBe(true);
  });

  it('refuse aussi le nom par défaut avec des espaces ou une autre casse', async () => {
    const { deps, t } = await readyTenant('  mon ENTREPRISE ');
    expect(await setDryRun(deps, t.id, false, 'user:u1')).toEqual({ status: 'blocked', missing: ['company_name'] });
  });

  it('autorise l’activation une fois le nom renseigné', async () => {
    const { deps, t } = await readyTenant('Mon entreprise');
    expect(await updateSettings(deps, t.id, { name: 'Nimbus Notes' })).toEqual({ status: 'ok' });
    expect(await setDryRun(deps, t.id, false, 'user:u1')).toEqual({ status: 'ok' });
  });
});
