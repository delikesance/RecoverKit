import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashToken } from '@recoverkit/core';
import { createTestDb, seedCase, seedStep, seedTenant, type TestDb } from '@recoverkit/testkit';
import { ensurePaymentLink, tokenFromUrl } from '../src/payments/link';
import { buildUnsubscribeUrl, unsubscribe } from '../src/mail/unsubscribe';
import { makeDeps } from './helpers';

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.dispose();
});

describe('ensurePaymentLink', () => {
  it('renvoie /pay/{token} et ne stocke que le hash, avec expiration à 14 jours', async () => {
    const deps = makeDeps(db);
    const t = await seedTenant(db.pool);
    const c = await seedCase(db.pool, t.id);
    const url = await ensurePaymentLink(deps, t.id, c.id);
    expect(url).toMatch(/^https:\/\/app\.recoverkit\.test\/pay\/[\w-]{43}$/);
    const token = tokenFromUrl(url);
    const rows = await db.pool.query(`select token_hash, expires_at, generation from payment_tokens where case_id = $1`, [c.id]);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].token_hash).toBe(hashToken(token));
    expect(new Date(rows.rows[0].expires_at).toISOString()).toBe('2026-10-15T08:00:00.000Z');
    expect(JSON.stringify(rows.rows)).not.toContain(token);
  });

  it('réutilise le même lien dans tous les emails du dossier', async () => {
    const deps = makeDeps(db);
    const t = await seedTenant(db.pool);
    const c = await seedCase(db.pool, t.id);
    const a = await ensurePaymentLink(deps, t.id, c.id);
    deps.clock.advance({ days: 3 });
    expect(await ensurePaymentLink(deps, t.id, c.id)).toBe(a);
  });

  it('émet un nouveau lien (génération suivante) après révocation, usage ou expiration', async () => {
    const deps = makeDeps(db);
    const t = await seedTenant(db.pool);
    const c = await seedCase(db.pool, t.id);
    const first = await ensurePaymentLink(deps, t.id, c.id);

    await db.pool.query(`update payment_tokens set revoked_at = now() where case_id = $1`, [c.id]);
    const second = await ensurePaymentLink(deps, t.id, c.id);
    expect(second).not.toBe(first);

    deps.clock.advance({ days: 15 });
    const third = await ensurePaymentLink(deps, t.id, c.id);
    expect(third).not.toBe(second);
    const gens = await db.pool.query(`select generation from payment_tokens where case_id = $1 order by generation`, [c.id]);
    expect(gens.rows.map((r) => r.generation)).toEqual([1, 2, 3]);
  });

  it('jamais deux liens actifs, même en parallèle', async () => {
    const deps = makeDeps(db);
    const t = await seedTenant(db.pool);
    const c = await seedCase(db.pool, t.id);
    const urls = await Promise.all(Array.from({ length: 6 }, () => ensurePaymentLink(deps, t.id, c.id)));
    expect(new Set(urls).size).toBe(1);
    const active = await db.pool.query(
      `select count(*)::int n from payment_tokens where case_id = $1 and used_at is null and revoked_at is null`,
      [c.id],
    );
    expect(active.rows[0].n).toBe(1);
  });

  it('refuse un dossier d’un autre tenant', async () => {
    const deps = makeDeps(db);
    const a = await seedTenant(db.pool);
    const b = await seedTenant(db.pool);
    const c = await seedCase(db.pool, a.id);
    await expect(ensurePaymentLink(deps, b.id, c.id)).rejects.toThrow(/introuvable/);
  });
});

describe('désinscription', () => {
  async function setup() {
    const deps = makeDeps(db);
    const t = await seedTenant(db.pool);
    const cust = await db.pool.query(
      `insert into end_customers (tenant_id, stripe_customer_id, email) values ($1, 'cus_u', 'camille@example.com') returning id`,
      [t.id],
    );
    const c = await seedCase(db.pool, t.id, { customerId: 'cus_u' });
    await db.pool.query(`update recovery_cases set end_customer_id = $2 where id = $1`, [c.id, cust.rows[0].id]);
    const step = await seedStep(db.pool, c.id, t.id);
    return { deps, t, c, step };
  }

  it('l’URL signée désinscrit : suppression ajoutée et étapes à venir annulées', async () => {
    const { deps, t, step } = await setup();
    const url = new URL(buildUnsubscribeUrl(deps, t.id, 'camille@example.com'));
    expect(url.pathname).toBe('/api/unsubscribe');
    const r = await unsubscribe(deps, { tenantId: url.searchParams.get('t')!, email: Buffer.from(url.searchParams.get('e')!, 'base64url').toString(), signature: url.searchParams.get('s')! });
    expect(r).toEqual({ status: 'unsubscribed' });
    const sup = await db.pool.query(`select reason from suppressions where tenant_id = $1 and email = 'camille@example.com'`, [t.id]);
    expect(sup.rows[0].reason).toBe('UNSUBSCRIBED');
    const s = await db.pool.query(`select status, skip_reason from scheduled_steps where id = $1`, [step.id]);
    expect(s.rows[0]).toEqual({ status: 'CANCELED', skip_reason: 'unsubscribed' });
  });

  it('refuse une signature invalide sans rien modifier', async () => {
    const { deps, t } = await setup();
    const r = await unsubscribe(deps, { tenantId: t.id, email: 'camille@example.com', signature: 'faux' });
    expect(r).toEqual({ status: 'invalid' });
    const n = await db.pool.query(`select count(*)::int n from suppressions where tenant_id = $1`, [t.id]);
    expect(n.rows[0].n).toBe(0);
  });

  it('est idempotente', async () => {
    const { deps, t } = await setup();
    const url = new URL(buildUnsubscribeUrl(deps, t.id, 'camille@example.com'));
    const params = { tenantId: t.id, email: 'camille@example.com', signature: url.searchParams.get('s')! };
    expect((await unsubscribe(deps, params)).status).toBe('unsubscribed');
    expect((await unsubscribe(deps, params)).status).toBe('unsubscribed');
    const n = await db.pool.query(`select count(*)::int n from suppressions where tenant_id = $1`, [t.id]);
    expect(n.rows[0].n).toBe(1);
  });
});
