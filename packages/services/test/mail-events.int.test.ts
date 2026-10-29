import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, seedCase, seedTenant, type TestDb } from '@recoverkit/testkit';
import { lockTenant } from '../src/recovery/ops';
import { receiveEmailProviderWebhook } from '../src/mail/provider-events';
import { TEST_ENV, makeDeps, type TestDeps } from './helpers';

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.dispose();
});

const key = Buffer.from('resend-webhook-secret-for-tests');
let seq = 0;
function post(deps: TestDeps, type: string, data: Record<string, unknown>, o: { id?: string; sig?: string } = {}) {
  const id = o.id ?? `msg_evt_${++seq}`;
  const raw = JSON.stringify({ type, created_at: deps.clock.now().toISOString(), data });
  const ts = String(Math.floor(deps.clock.now().getTime() / 1000));
  const signature = o.sig ?? 'v1,' + createHmac('sha256', key).update(`${id}.${ts}.${raw}`).digest('base64');
  return receiveEmailProviderWebhook(deps, { rawBody: raw, headers: { id, timestamp: ts, signature } });
}

async function sentEmail(providerId: string, state = 'RECOVERING') {
  const t = await seedTenant(db.pool);
  const cust = await db.pool.query(`insert into end_customers (tenant_id, stripe_customer_id, email) values ($1,$2,'c@example.com') returning id`, [t.id, `cus_${providerId}`]);
  const c = await seedCase(db.pool, t.id, { state, customerId: `cus_${providerId}` });
  await db.pool.query(`update recovery_cases set end_customer_id = $2 where id = $1`, [c.id, cust.rows[0].id]);
  await db.pool.query(
    `insert into email_messages (tenant_id, case_id, step_index, idempotency_key, provider_message_id, to_email, subject) values ($1,$2,0,$3,$4,'c@example.com','s')`,
    [t.id, c.id, `${c.id}:0`, providerId],
  );
  return { t, c };
}
const msg = async (providerId: string) => (await db.pool.query(`select * from email_messages where provider_message_id = $1`, [providerId])).rows[0];

describe('webhooks du fournisseur d’email', () => {
  it('signature invalide : 400, rien n’est modifié', async () => {
    const deps = makeDeps(db);
    await sentEmail('em_sig');
    const r = await post(deps, 'email.delivered', { email_id: 'em_sig' }, { sig: 'v1,faux' });
    expect(r).toEqual({ httpStatus: 400, status: 'rejected' });
    expect((await msg('em_sig')).status).toBe('SENT');
  });

  it('secret non configuré : refus', async () => {
    const deps = makeDeps(db);
    deps.config = { ...deps.config, resendWebhookSecret: null };
    expect((await post(deps, 'email.delivered', { email_id: 'x' })).httpStatus).toBe(400);
  });

  it('delivered : statut DELIVERED et date', async () => {
    const deps = makeDeps(db);
    await sentEmail('em_del');
    expect(await post(deps, 'email.delivered', { email_id: 'em_del' })).toEqual({ httpStatus: 200, status: 'processed' });
    const m = await msg('em_del');
    expect(m.status).toBe('DELIVERED');
    expect(m.delivered_at).not.toBeNull();
  });

  it('opened et clicked : première date conservée', async () => {
    const deps = makeDeps(db);
    await sentEmail('em_open');
    await post(deps, 'email.opened', { email_id: 'em_open' });
    const first = (await msg('em_open')).opened_at;
    deps.clock.advance({ hours: 1 });
    await post(deps, 'email.opened', { email_id: 'em_open' });
    expect((await msg('em_open')).opened_at).toEqual(first);
    await post(deps, 'email.clicked', { email_id: 'em_open' });
    expect((await msg('em_open')).clicked_at).not.toBeNull();
  });

  it('bounced : BOUNCED, suppression et alerte', async () => {
    const deps = makeDeps(db);
    const { t } = await sentEmail('em_bounce');
    await post(deps, 'email.bounced', { email_id: 'em_bounce' });
    expect((await msg('em_bounce')).status).toBe('BOUNCED');
    const sup = await db.pool.query(`select reason from suppressions where tenant_id = $1 and email = 'c@example.com'`, [t.id]);
    expect(sup.rows[0].reason).toBe('BOUNCED');
    const alerts = await db.pool.query(`select kind from system_alerts where tenant_id = $1`, [t.id]);
    expect(alerts.rows.map((a) => a.kind)).toContain('email_bounced');
  });

  it('complained : COMPLAINED, suppression et dossier mis en pause', async () => {
    const deps = makeDeps(db);
    const { t, c } = await sentEmail('em_spam');
    await post(deps, 'email.complained', { email_id: 'em_spam' });
    expect((await msg('em_spam')).status).toBe('COMPLAINED');
    const sup = await db.pool.query(`select reason from suppressions where tenant_id = $1`, [t.id]);
    expect(sup.rows[0].reason).toBe('COMPLAINED');
    const state = await db.pool.query(`select state from recovery_cases where id = $1`, [c.id]);
    expect(state.rows[0].state).toBe('PAUSED');
  });

  it('un delivered tardif ne repasse pas un rebond en DELIVERED', async () => {
    const deps = makeDeps(db);
    await sentEmail('em_order');
    await post(deps, 'email.bounced', { email_id: 'em_order' });
    await post(deps, 'email.delivered', { email_id: 'em_order' });
    expect((await msg('em_order')).status).toBe('BOUNCED');
  });

  it('même identifiant d’événement rejoué : traité une seule fois', async () => {
    const deps = makeDeps(db);
    const { t } = await sentEmail('em_dup');
    const rs = await Promise.all([1, 2, 3].map(() => post(deps, 'email.bounced', { email_id: 'em_dup' }, { id: 'msg_same' })));
    expect(rs.filter((r) => r.status === 'processed')).toHaveLength(1);
    expect(rs.filter((r) => r.status === 'duplicate')).toHaveLength(2);
    const alerts = await db.pool.query(`select count(*)::int n from system_alerts where tenant_id = $1 and kind = 'email_bounced'`, [t.id]);
    expect(alerts.rows[0].n).toBe(1);
  });

  it('type non géré : 200 sans effet', async () => {
    const deps = makeDeps(db);
    expect(await post(deps, 'email.sent', { email_id: 'inconnu' })).toEqual({ httpStatus: 200, status: 'ignored' });
  });

  it('évènement reçu avant l’insertion d’email_messages : 503 à réessayer, svix-id non consommé, rejeu traité', async () => {
    const deps = makeDeps(db);
    const first = await post(deps, 'email.bounced', { email_id: 'em_early' }, { id: 'msg_early' });
    expect(first).toEqual({ httpStatus: 503, status: 'retry' });
    const stored = await db.pool.query(`select 1 from provider_events where id = 'msg_early'`);
    expect(stored.rowCount).toBe(0);

    const { t } = await sentEmail('em_early');
    const retry = await post(deps, 'email.bounced', { email_id: 'em_early' }, { id: 'msg_early' });
    expect(retry).toEqual({ httpStatus: 200, status: 'processed' });
    expect((await msg('em_early')).status).toBe('BOUNCED');
    const sup = await db.pool.query(`select reason from suppressions where tenant_id = $1`, [t.id]);
    expect(sup.rows[0].reason).toBe('BOUNCED');
  });

  it('message inconnu et évènement ancien : ignoré (pas de réessai infini)', async () => {
    const deps = makeDeps(db);
    const id = 'msg_old';
    const raw = JSON.stringify({ type: 'email.delivered', created_at: new Date(deps.clock.now().getTime() - 3 * 86400_000).toISOString(), data: { email_id: 'em_never' } });
    const ts = String(Math.floor(deps.clock.now().getTime() / 1000));
    const signature = 'v1,' + createHmac('sha256', key).update(`${id}.${ts}.${raw}`).digest('base64');
    expect(await receiveEmailProviderWebhook(deps, { rawBody: raw, headers: { id, timestamp: ts, signature } })).toEqual({ httpStatus: 200, status: 'ignored' });
  });

  it('plainte sur un dossier devenu terminal entre-temps : ne le rouvre pas (UPDATE gardé)', async () => {
    const deps = makeDeps(db);
    const { t, c } = await sentEmail('em_race');
    // un autre écrivain (sous lockTenant) clôture le dossier, transaction encore ouverte quand le webhook arrive
    const other = await db.pool.connect();
    await other.query('begin');
    await lockTenant(other, t.id);
    await other.query(`update recovery_cases set state = 'RECOVERED', closed_at = now(), close_reason = 'paid' where id = $1`, [c.id]);
    const webhook = post(deps, 'email.complained', { email_id: 'em_race' });
    await new Promise((r) => setTimeout(r, 300));
    await other.query('commit');
    other.release();
    await webhook;
    const st = await db.pool.query(`select state from recovery_cases where id = $1`, [c.id]);
    expect(st.rows[0].state).toBe('RECOVERED');
  });
});

void TEST_ENV;
