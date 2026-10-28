import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, seedCase, seedStep, seedTenant, type TestDb } from '@recoverkit/testkit';
import { insertInboxEvent } from '../src/inbox';
import { getCase, upsertCase } from '../src/cases';
import { insertScheduledSteps, recoverStaleReservations, reserveDueSteps } from '../src/steps';
import { logAction, listCaseActions } from '../src/audit';
import { insertLedgerEntry, listLedger } from '../src/ledger';
import { storePaymentToken, findPaymentTokenByHash } from '../src/payment-tokens';
import { hitRateLimit, purgeRateLimits } from '../src/rate-limit';
import { withTransaction } from '../src/queryable';

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.dispose();
});

describe('inbox_events', () => {
  it('refuse un stripe_event_id en double (duplicate)', async () => {
    const evt = { stripeEventId: 'evt_dup', accountId: 'acct_1', tenantId: null, type: 'invoice.paid', payload: { a: 1 } };
    expect(await insertInboxEvent(db.pool, evt)).toBe('inserted');
    expect(await insertInboxEvent(db.pool, evt)).toBe('duplicate');
  });

  it('cinq envois concurrents du même événement donnent une seule ligne', async () => {
    const evt = { stripeEventId: 'evt_conc', accountId: 'acct_1', tenantId: null, type: 'invoice.paid', payload: {} };
    const results = await Promise.all(Array.from({ length: 5 }, () => insertInboxEvent(db.pool, evt)));
    expect(results.filter((r) => r === 'inserted')).toHaveLength(1);
    expect(results.filter((r) => r === 'duplicate')).toHaveLength(4);
    const n = await db.pool.query(`select count(*)::int n from inbox_events where stripe_event_id = 'evt_conc'`);
    expect(n.rows[0].n).toBe(1);
  });
});

describe('recovery_cases', () => {
  const base = (tenantId: string, invoiceId: string) => ({
    tenantId,
    stripeInvoiceId: invoiceId,
    stripeCustomerId: 'cus_1',
    stripeSubscriptionId: 'sub_1',
    amountDue: 2900,
    currency: 'EUR',
    planName: 'Pro',
    failedAt: new Date('2026-10-01T08:00:00Z'),
    failureCode: 'card_declined',
    attemptCount: 1,
  });

  it('upsert concurrent de la même facture = un seul dossier', async () => {
    const t = await seedTenant(db.pool);
    const results = await Promise.all(
      Array.from({ length: 4 }, () => withTransaction(db.pool, (tx) => upsertCase(tx, base(t.id, 'in_race')))),
    );
    expect(results.filter((r) => r.created)).toHaveLength(1);
    const n = await db.pool.query(`select count(*)::int n from recovery_cases where tenant_id = $1`, [t.id]);
    expect(n.rows[0].n).toBe(1);
  });

  it("le même identifiant de facture dans deux tenants donne deux dossiers", async () => {
    const a = await seedTenant(db.pool);
    const b = await seedTenant(db.pool);
    await upsertCase(db.pool, base(a.id, 'in_same'));
    const second = await upsertCase(db.pool, base(b.id, 'in_same'));
    expect(second.created).toBe(true);
  });

  it('un second échec reprend attempt_count de Stripe (rejeu idempotent) et met à jour le motif', async () => {
    const t = await seedTenant(db.pool);
    await upsertCase(db.pool, base(t.id, 'in_attempts'));
    const again = await upsertCase(db.pool, { ...base(t.id, 'in_attempts'), failureCode: 'insufficient_funds', attemptCount: 2 });
    expect(again.created).toBe(false);
    expect(again.row.attemptCount).toBe(2);
    expect(again.row.lastFailureCode).toBe('insufficient_funds');
  });

  it('ne modifie pas un dossier terminal', async () => {
    const t = await seedTenant(db.pool);
    const c = await seedCase(db.pool, t.id, { invoiceId: 'in_done', state: 'RECOVERED' });
    const again = await upsertCase(db.pool, { ...base(t.id, 'in_done'), failureCode: 'x' });
    expect(again.created).toBe(false);
    expect(again.row.state).toBe('RECOVERED');
    expect(again.row.attemptCount).toBe(1);
    expect(again.row.id).toBe(c.id);
  });
});

describe('scheduled_steps : réservation', () => {
  const now = new Date('2026-10-02T12:00:00Z');
  const due = new Date('2026-10-02T09:00:00Z');

  it('insertion idempotente : unique (case, step_index)', async () => {
    const t = await seedTenant(db.pool);
    const c = await seedCase(db.pool, t.id);
    await insertScheduledSteps(db.pool, c.id, t.id, [{ stepIndex: 0, dueAt: due }]);
    await insertScheduledSteps(db.pool, c.id, t.id, [{ stepIndex: 0, dueAt: due }, { stepIndex: 1, dueAt: due }]);
    const n = await db.pool.query(`select count(*)::int n from scheduled_steps where case_id = $1`, [c.id]);
    expect(n.rows[0].n).toBe(2);
  });

  it('deux workers concurrents ne réservent jamais la même ligne', async () => {
    const t = await seedTenant(db.pool);
    for (let i = 0; i < 20; i++) {
      const c = await seedCase(db.pool, t.id);
      await seedStep(db.pool, c.id, t.id, { dueAt: due });
    }
    const [a, b] = await Promise.all([reserveDueSteps(db.pool, now, 10, { tenantId: t.id }), reserveDueSteps(db.pool, now, 10, { tenantId: t.id })]);
    const ids = [...a, ...b].map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThan(0);
    const rest = await reserveDueSteps(db.pool, now, 100, { tenantId: t.id });
    const all = new Set([...ids, ...rest.map((s) => s.id)]);
    expect(all.size).toBe(20);
  });

  it('passe les étapes réservées en SENDING avec horodatage et tentative', async () => {
    const t = await seedTenant(db.pool);
    const c = await seedCase(db.pool, t.id);
    await seedStep(db.pool, c.id, t.id, { dueAt: due });
    const [s] = await reserveDueSteps(db.pool, now, 5, { tenantId: t.id });
    expect(s).toMatchObject({ status: 'SENDING', attempts: 1, tenantId: t.id, caseId: c.id });
    expect(s!.reservedAt?.toISOString()).toBe(now.toISOString());
  });

  it("ignore les étapes futures", async () => {
    const t = await seedTenant(db.pool);
    const c = await seedCase(db.pool, t.id);
    await seedStep(db.pool, c.id, t.id, { dueAt: new Date('2026-10-03T09:00:00Z') });
    expect(await reserveDueSteps(db.pool, now, 5, { tenantId: t.id })).toHaveLength(0);
  });

  it('ignore les dossiers en pause et terminaux', async () => {
    const t = await seedTenant(db.pool);
    for (const state of ['PAUSED', 'RECOVERED', 'CANCELED', 'LOST', 'CLOSED_MANUAL']) {
      const c = await seedCase(db.pool, t.id, { state });
      await seedStep(db.pool, c.id, t.id, { dueAt: due });
    }
    expect(await reserveDueSteps(db.pool, now, 50, { tenantId: t.id })).toHaveLength(0);
  });

  it('marque SKIPPED(disabled) les étapes des tenants dont les emails sont désactivés', async () => {
    const t = await seedTenant(db.pool, { emailsEnabled: false });
    const c = await seedCase(db.pool, t.id);
    const s = await seedStep(db.pool, c.id, t.id, { dueAt: due });
    expect(await reserveDueSteps(db.pool, now, 50, { tenantId: t.id })).toHaveLength(0);
    const row = await db.pool.query(`select status, skip_reason from scheduled_steps where id = $1`, [s.id]);
    expect(row.rows[0]).toEqual({ status: 'SKIPPED', skip_reason: 'disabled' });
  });

  it('équité entre tenants : un tenant qui inonde la file ne prive pas les autres', async () => {
    const big = await seedTenant(db.pool, { name: 'Gros' });
    const small = await seedTenant(db.pool, { name: 'Petit' });
    const early = new Date('2026-10-02T08:00:00Z');
    const late = new Date('2026-10-02T11:00:00Z');
    for (let i = 0; i < 30; i++) {
      const c = await seedCase(db.pool, big.id);
      await seedStep(db.pool, c.id, big.id, { dueAt: early });
    }
    for (let i = 0; i < 5; i++) {
      const c = await seedCase(db.pool, small.id);
      await seedStep(db.pool, c.id, small.id, { dueAt: late });
    }
    // le test partage la base : on neutralise les autres tenants en attente
    await db.pool.query(`update scheduled_steps set status = 'CANCELED' where status = 'SCHEDULED' and tenant_id not in ($1, $2)`, [big.id, small.id]);
    const picked = await reserveDueSteps(db.pool, now, 10);
    const bySmall = picked.filter((p) => p.tenantId === small.id).length;
    expect(picked).toHaveLength(10);
    expect(bySmall).toBe(5); // tout le petit tenant passe, malgré ses échéances plus tardives
  });

  it('récupère les réservations bloquées depuis plus de 10 minutes', async () => {
    const t = await seedTenant(db.pool);
    const c1 = await seedCase(db.pool, t.id);
    const c2 = await seedCase(db.pool, t.id);
    const stale = await seedStep(db.pool, c1.id, t.id, { status: 'SENDING', reservedAt: new Date('2026-10-02T11:40:00Z') });
    const fresh = await seedStep(db.pool, c2.id, t.id, { status: 'SENDING', reservedAt: new Date('2026-10-02T11:55:00Z') });
    const recovered = await recoverStaleReservations(db.pool, now, 10 * 60_000);
    expect(recovered.map((r) => r.id)).toEqual([stale.id]);
    const statuses = await db.pool.query(`select id, status from scheduled_steps where id = any($1)`, [[stale.id, fresh.id]]);
    const byId = Object.fromEntries(statuses.rows.map((r) => [r.id, r.status]));
    expect(byId[stale.id]).toBe('SCHEDULED');
    expect(byId[fresh.id]).toBe('SENDING');
  });
});

describe('tables en ajout seul', () => {
  it('action_log refuse UPDATE et DELETE', async () => {
    const t = await seedTenant(db.pool);
    await logAction(db.pool, { tenantId: t.id, caseId: null, actor: 'system', action: 'test', details: {} });
    await expect(db.pool.query(`update action_log set action = 'x' where tenant_id = $1`, [t.id])).rejects.toThrow(/ajout seul/);
    await expect(db.pool.query(`delete from action_log where tenant_id = $1`, [t.id])).rejects.toThrow(/ajout seul/);
  });

  it('recovery_ledger refuse UPDATE et DELETE', async () => {
    const t = await seedTenant(db.pool);
    const c = await seedCase(db.pool, t.id);
    await insertLedgerEntry(db.pool, {
      tenantId: t.id, caseId: c.id, invoiceId: c.invoiceId, kind: 'RECOVERY', attribution: 'ASSISTED',
      amount: 2900, currency: 'EUR', occurredAt: new Date(), stripeEventId: 'evt_1',
    });
    await expect(db.pool.query(`update recovery_ledger set amount = 1 where tenant_id = $1`, [t.id])).rejects.toThrow(/ajout seul/);
    await expect(db.pool.query(`delete from recovery_ledger where tenant_id = $1`, [t.id])).rejects.toThrow(/ajout seul/);
  });

  it("la purge RGPD explicite est la seule exception", async () => {
    const t = await seedTenant(db.pool);
    await logAction(db.pool, { tenantId: t.id, caseId: null, actor: 'system', action: 'purge', details: {} });
    await withTransaction(db.pool, async (tx) => {
      await tx.query(`set local recoverkit.allow_purge = 'on'`);
      await tx.query(`delete from action_log where tenant_id = $1`, [t.id]);
    });
    const n = await db.pool.query(`select count(*)::int n from action_log where tenant_id = $1`, [t.id]);
    expect(n.rows[0].n).toBe(0);
  });

  it('le ledger refuse une seconde ligne RECOVERY pour la même facture (idempotence)', async () => {
    const t = await seedTenant(db.pool);
    const c = await seedCase(db.pool, t.id);
    const entry = {
      tenantId: t.id, caseId: c.id, invoiceId: c.invoiceId, kind: 'RECOVERY' as const, attribution: 'ASSISTED' as const,
      amount: 2900, currency: 'EUR', occurredAt: new Date(), stripeEventId: 'evt_a',
    };
    expect(await insertLedgerEntry(db.pool, entry)).toBe('inserted');
    expect(await insertLedgerEntry(db.pool, { ...entry, stripeEventId: 'evt_b' })).toBe('duplicate');
    // un ajustement reste possible
    expect(await insertLedgerEntry(db.pool, { ...entry, kind: 'ADJUSTMENT', amount: -500 })).toBe('inserted');
    expect(await listLedger(db.pool, t.id)).toHaveLength(2);
  });
});

describe('payment_tokens', () => {
  it('stocke uniquement le hash, jamais le token en clair', async () => {
    const t = await seedTenant(db.pool);
    const c = await seedCase(db.pool, t.id);
    const token = 'tok_PLAINTEXT_SECRET';
    const hash = 'a'.repeat(64);
    await storePaymentToken(db.pool, { tenantId: t.id, caseId: c.id, tokenHash: hash, expiresAt: new Date('2026-11-01T00:00:00Z') });
    const dump = await db.pool.query(`select row_to_json(p)::text as j from payment_tokens p where case_id = $1`, [c.id]);
    expect(dump.rows[0].j).not.toContain(token);
    const found = await findPaymentTokenByHash(db.pool, hash);
    expect(found).toMatchObject({ caseId: c.id, tenantId: t.id, usedAt: null, revokedAt: null });
    expect(await findPaymentTokenByHash(db.pool, 'b'.repeat(64))).toBeNull();
  });

  it('refuse deux tokens actifs pour le même dossier', async () => {
    const t = await seedTenant(db.pool);
    const c = await seedCase(db.pool, t.id);
    const exp = new Date('2026-11-01T00:00:00Z');
    await storePaymentToken(db.pool, { tenantId: t.id, caseId: c.id, tokenHash: '1'.repeat(64), expiresAt: exp });
    await expect(
      storePaymentToken(db.pool, { tenantId: t.id, caseId: c.id, tokenHash: '2'.repeat(64), expiresAt: exp }),
    ).rejects.toThrow();
  });
});

describe('rate_limits', () => {
  const t0 = new Date('2026-10-02T12:00:10Z');

  it('autorise jusqu’à la limite puis refuse, par fenêtre fixe', async () => {
    const results = [];
    for (let i = 0; i < 5; i++) results.push(await hitRateLimit(db.pool, 'ip:1.1.1.1', { limit: 3, windowSeconds: 60 }, t0));
    expect(results.map((r) => r.allowed)).toEqual([true, true, true, false, false]);
    expect(results[4]!.count).toBe(5);
  });

  it('la fenêtre suivante repart de zéro', async () => {
    const next = new Date(t0.getTime() + 61_000);
    const r = await hitRateLimit(db.pool, 'ip:1.1.1.1', { limit: 3, windowSeconds: 60 }, next);
    expect(r).toMatchObject({ allowed: true, count: 1 });
  });

  it('incrément atomique sous concurrence', async () => {
    const rs = await Promise.all(
      Array.from({ length: 20 }, () => hitRateLimit(db.pool, 'ip:2.2.2.2', { limit: 10, windowSeconds: 60 }, t0)),
    );
    expect(rs.filter((r) => r.allowed)).toHaveLength(10);
  });

  it('purge les fenêtres expirées', async () => {
    const removed = await purgeRateLimits(db.pool, new Date(t0.getTime() + 3600_000));
    expect(removed).toBeGreaterThan(0);
  });
});

describe('isolation entre tenants', () => {
  it('un tenant ne lit jamais les dossiers, journaux ni écritures d’un autre', async () => {
    const a = await seedTenant(db.pool);
    const b = await seedTenant(db.pool);
    const caseA = await seedCase(db.pool, a.id);
    await logAction(db.pool, { tenantId: a.id, caseId: caseA.id, actor: 'system', action: 'x', details: {} });
    await insertLedgerEntry(db.pool, {
      tenantId: a.id, caseId: caseA.id, invoiceId: caseA.invoiceId, kind: 'RECOVERY', attribution: 'ASSISTED',
      amount: 100, currency: 'EUR', occurredAt: new Date(), stripeEventId: 'evt_iso',
    });
    expect(await getCase(db.pool, b.id, caseA.id)).toBeNull();
    expect(await listCaseActions(db.pool, b.id, caseA.id)).toEqual([]);
    expect(await listLedger(db.pool, b.id)).toEqual([]);
    expect(await getCase(db.pool, a.id, caseA.id)).not.toBeNull();
    expect(await listCaseActions(db.pool, a.id, caseA.id)).toHaveLength(1);
  });
});
