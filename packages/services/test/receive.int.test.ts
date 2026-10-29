import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, seedTenant, signStripePayload, stripeEvent, type TestDb } from '@recoverkit/testkit';
import { receiveStripeWebhook } from '../src/webhooks/receive';
import { makeDeps, TEST_ENV, type TestDeps } from './helpers';

let db: TestDb;
let deps: TestDeps;
let tenantId: string;
beforeAll(async () => {
  db = await createTestDb();
  deps = makeDeps(db);
  tenantId = (await seedTenant(db.pool)).id;
  await db.pool.query(
    `insert into stripe_connections (tenant_id, stripe_account_id, status) values ($1, 'acct_known', 'ACTIVE')`,
    [tenantId],
  );
});
afterAll(async () => {
  await db.dispose();
});

const secret = TEST_ENV.STRIPE_CONNECT_WEBHOOK_SECRET;
function req(evt: object, opts: { sig?: string } = {}) {
  const raw = JSON.stringify(evt);
  return { rawBody: raw, signature: opts.sig ?? signStripePayload(raw, secret, deps.clock.now()) };
}

describe('réception des webhooks Stripe', () => {
  it('signature invalide : refus sans écriture', async () => {
    const evt = stripeEvent('invoice.payment_failed', { id: 'in_1' }, { account: 'acct_known', id: 'evt_bad' });
    const r = await receiveStripeWebhook(deps, req(evt, { sig: 't=1,v1=' + '0'.repeat(64) }));
    expect(r).toEqual({ status: 'rejected', httpStatus: 400, reason: 'timestamp' });
    const n = await db.pool.query(`select count(*)::int n from inbox_events where stripe_event_id = 'evt_bad'`);
    expect(n.rows[0].n).toBe(0);
  });

  it('corps non JSON : 400', async () => {
    const raw = 'pas du json';
    const r = await receiveStripeWebhook(deps, { rawBody: raw, signature: signStripePayload(raw, secret, deps.clock.now()) });
    expect(r).toMatchObject({ status: 'rejected', httpStatus: 400 });
  });

  it('événement valide : stocké pending avec son tenant, réponse 200', async () => {
    const evt = stripeEvent('invoice.payment_failed', { id: 'in_ok' }, { account: 'acct_known', id: 'evt_ok' });
    const r = await receiveStripeWebhook(deps, req(evt));
    expect(r).toEqual({ status: 'received', httpStatus: 200 });
    const row = await db.pool.query(`select status, tenant_id, type, payload from inbox_events where stripe_event_id = 'evt_ok'`);
    expect(row.rows[0]).toMatchObject({ status: 'pending', tenant_id: tenantId, type: 'invoice.payment_failed' });
    expect(row.rows[0].payload.data.object.id).toBe('in_ok');
  });

  it('le même événement envoyé 5 fois en parallèle : une seule ligne, toujours 200', async () => {
    const evt = stripeEvent('invoice.paid', { id: 'in_dup' }, { account: 'acct_known', id: 'evt_dup' });
    const rs = await Promise.all(Array.from({ length: 5 }, () => receiveStripeWebhook(deps, req(evt))));
    expect(rs.every((r) => r.httpStatus === 200)).toBe(true);
    expect(rs.filter((r) => r.status === 'received')).toHaveLength(1);
    expect(rs.filter((r) => r.status === 'duplicate')).toHaveLength(4);
    const n = await db.pool.query(`select count(*)::int n from inbox_events where stripe_event_id = 'evt_dup'`);
    expect(n.rows[0].n).toBe(1);
  });

  it('compte inconnu : stocké comme ignoré, 200 (pas de boucle de retry)', async () => {
    const evt = stripeEvent('invoice.paid', { id: 'in_x' }, { account: 'acct_inconnu', id: 'evt_unknown' });
    const r = await receiveStripeWebhook(deps, req(evt));
    expect(r).toEqual({ status: 'received', httpStatus: 200 });
    const row = await db.pool.query(`select status, tenant_id from inbox_events where stripe_event_id = 'evt_unknown'`);
    expect(row.rows[0]).toEqual({ status: 'ignored', tenant_id: null });
  });

  it('événement sans compte connecté sur le point de terminaison Connect : ignoré', async () => {
    const evt = stripeEvent('invoice.paid', { id: 'in_y' }, { account: null, id: 'evt_noacct' });
    await receiveStripeWebhook(deps, req(evt));
    const row = await db.pool.query(`select status from inbox_events where stripe_event_id = 'evt_noacct'`);
    expect(row.rows[0].status).toBe('ignored');
  });

  it('le traitement n’a pas lieu dans la requête : aucun dossier créé à la réception', async () => {
    const evt = stripeEvent('invoice.payment_failed', { id: 'in_fast' }, { account: 'acct_known', id: 'evt_fast' });
    await receiveStripeWebhook(deps, req(evt));
    const stored = await db.pool.query(`select status from inbox_events where stripe_event_id = 'evt_fast'`);
    expect(stored.rows[0].status).toBe('pending');
    const cases = await db.pool.query(`select count(*)::int n from recovery_cases where tenant_id = $1`, [tenantId]);
    expect(cases.rows[0].n).toBe(0);
  });
});
