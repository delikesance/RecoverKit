import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listCaseActions } from '@recoverkit/db';
import { createTestDb, seedCase, seedStep, seedTenant, type TestDb } from '@recoverkit/testkit';
import { closeCaseManually, exportRecoveredCsv, pauseCase, resumeCase, sendNextNow } from '../src/dashboard/actions';
import { makeDeps } from './helpers';

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.dispose();
});

const NOW = new Date('2026-10-28T10:00:00Z'); // 11:00 à Paris
const actor = 'user:u1';
const state = async (id: string) => (await db.pool.query(`select state, close_reason from recovery_cases where id = $1`, [id])).rows[0];
const steps = async (caseId: string) => (await db.pool.query(`select step_index, status, due_at, skip_reason from scheduled_steps where case_id = $1 order by step_index`, [caseId])).rows;

async function openCase(stateName = 'RECOVERING') {
  const t = await seedTenant(db.pool);
  const c = await seedCase(db.pool, t.id, { state: stateName });
  return { t, c };
}

describe('pause et reprise', () => {
  it('met en pause un dossier actif et journalise l’action', async () => {
    const deps = makeDeps(db, NOW);
    const { t, c } = await openCase();
    expect(await pauseCase(deps, t.id, c.id, actor)).toEqual({ status: 'ok' });
    expect((await state(c.id)).state).toBe('PAUSED');
    const log = await listCaseActions(db.pool, t.id, c.id);
    expect(log.at(-1)).toMatchObject({ action: 'case.paused', actor });
  });

  it('refuse les dossiers inconnus, d’un autre tenant ou terminaux', async () => {
    const deps = makeDeps(db, NOW);
    const { t, c } = await openCase();
    const other = await seedTenant(db.pool);
    expect(await pauseCase(deps, other.id, c.id, actor)).toEqual({ status: 'not_found' });
    expect(await pauseCase(deps, t.id, '00000000-0000-0000-0000-000000000000', actor)).toEqual({ status: 'not_found' });
    const done = await openCase('RECOVERED');
    expect(await pauseCase(deps, done.t.id, done.c.id, actor)).toEqual({ status: 'invalid_state' });
    expect(await resumeCase(deps, t.id, c.id, actor)).toEqual({ status: 'invalid_state' });
  });

  it('la reprise replanifie les étapes échues dans la fenêtre d’envoi, sans rafale', async () => {
    const deps = makeDeps(db, NOW);
    const { t, c } = await openCase('PAUSED');
    await seedStep(db.pool, c.id, t.id, { stepIndex: 0, dueAt: new Date('2026-10-20T09:00:00Z') });
    await seedStep(db.pool, c.id, t.id, { stepIndex: 1, dueAt: new Date('2026-10-21T09:00:00Z') });
    await seedStep(db.pool, c.id, t.id, { stepIndex: 2, dueAt: new Date('2026-11-05T09:00:00Z') });
    await seedStep(db.pool, c.id, t.id, { stepIndex: 3, status: 'SENT' });
    expect(await resumeCase(deps, t.id, c.id, actor)).toEqual({ status: 'ok' });
    expect((await state(c.id)).state).toBe('RECOVERING');
    const s = await steps(c.id);
    const due = s.slice(0, 3).map((x) => new Date(x.due_at).getTime());
    expect(due[0]).toBe(NOW.getTime()); // 11:00 Paris, dans la fenêtre : immédiat
    expect(due[1]! - due[0]!).toBeGreaterThanOrEqual(12 * 3600_000); // écart minimal
    expect(new Date(due[1]!).toISOString()).toBe('2026-10-29T08:00:00.000Z'); // 09:00 Paris le lendemain
    expect(due[2]).toBe(new Date('2026-11-05T09:00:00Z').getTime()); // étape future inchangée
    expect(s[3].status).toBe('SENT');
  });
});

describe('reprise : écart minimal aussi pour les étapes futures', () => {
  it('une étape future trop proche de l’étape replanifiée est repoussée (≥ 12 h, dans la fenêtre)', async () => {
    const now = new Date('2026-10-28T18:30:00Z'); // 19h30 Paris, hors fenêtre
    const deps = makeDeps(db, now);
    const { t, c } = await openCase('PAUSED');
    await seedStep(db.pool, c.id, t.id, { stepIndex: 0, dueAt: new Date('2026-10-27T09:00:00Z') });
    await seedStep(db.pool, c.id, t.id, { stepIndex: 1, dueAt: new Date('2026-10-29T09:00:00Z') });
    await seedStep(db.pool, c.id, t.id, { stepIndex: 2, dueAt: new Date('2026-11-20T09:00:00Z') });
    expect(await resumeCase(deps, t.id, c.id, actor)).toEqual({ status: 'ok' });
    const due = (await steps(c.id)).map((x) => new Date(x.due_at).getTime());
    expect(new Date(due[0]!).toISOString()).toBe('2026-10-29T08:00:00.000Z');
    expect(due[1]! - due[0]!).toBeGreaterThanOrEqual(12 * 3600_000);
    expect(new Date(due[1]!).toISOString()).toBe('2026-10-30T08:00:00.000Z');
    expect(due[2]).toBe(new Date('2026-11-20T09:00:00Z').getTime()); // assez loin : inchangée
  });
});

describe('envoyer le prochain email maintenant', () => {
  it('avance la prochaine étape à maintenant, une seule fois', async () => {
    const deps = makeDeps(db, NOW);
    const { t, c } = await openCase();
    await seedStep(db.pool, c.id, t.id, { stepIndex: 0, dueAt: new Date('2026-10-30T08:00:00Z') });
    await seedStep(db.pool, c.id, t.id, { stepIndex: 1, dueAt: new Date('2026-11-03T08:00:00Z') });
    expect(await sendNextNow(deps, t.id, c.id, actor)).toEqual({ status: 'queued', stepIndex: 0 });
    expect(new Date((await steps(c.id))[0].due_at).toISOString()).toBe(NOW.toISOString());
    // déjà échue : on ne fait rien de plus (idempotence)
    expect(await sendNextNow(deps, t.id, c.id, actor)).toEqual({ status: 'already_due', stepIndex: 0 });
    expect(new Date((await steps(c.id))[1].due_at).toISOString()).toBe('2026-11-03T08:00:00.000Z');
  });

  it('refuse si le dossier n’est pas actif, si un envoi est en cours, ou s’il n’y a plus d’étape', async () => {
    const deps = makeDeps(db, NOW);
    const paused = await openCase('PAUSED');
    await seedStep(db.pool, paused.c.id, paused.t.id, { dueAt: new Date('2026-10-30T08:00:00Z') });
    expect(await sendNextNow(deps, paused.t.id, paused.c.id, actor)).toEqual({ status: 'not_active' });

    const busy = await openCase();
    await seedStep(db.pool, busy.c.id, busy.t.id, { stepIndex: 0, status: 'SENDING' });
    await seedStep(db.pool, busy.c.id, busy.t.id, { stepIndex: 1, dueAt: new Date('2026-10-30T08:00:00Z') });
    expect(await sendNextNow(deps, busy.t.id, busy.c.id, actor)).toEqual({ status: 'in_progress' });

    const none = await openCase();
    await seedStep(db.pool, none.c.id, none.t.id, { status: 'SENT' });
    expect(await sendNextNow(deps, none.t.id, none.c.id, actor)).toEqual({ status: 'no_step' });
  });

  it('refuse un second envoi forcé moins d’une heure après le dernier email', async () => {
    const deps = makeDeps(db, NOW);
    const { t, c } = await openCase();
    await seedStep(db.pool, c.id, t.id, { stepIndex: 0, status: 'SENT' });
    await seedStep(db.pool, c.id, t.id, { stepIndex: 1, dueAt: new Date('2026-10-30T08:00:00Z') });
    await db.pool.query(`insert into email_messages (tenant_id, case_id, step_index, idempotency_key, to_email, subject, sent_at) values ($1,$2,0,$3,'x@y.z','s',$4)`, [t.id, c.id, `${c.id}:0`, new Date(NOW.getTime() - 30 * 60_000)]);
    expect(await sendNextNow(deps, t.id, c.id, actor)).toEqual({ status: 'too_soon' });
  });
});

describe('clôture manuelle', () => {
  it('exige un motif, annule les étapes, révoque le lien, journalise le motif', async () => {
    const deps = makeDeps(db, NOW);
    const { t, c } = await openCase();
    await seedStep(db.pool, c.id, t.id, { stepIndex: 0, dueAt: new Date('2026-10-30T08:00:00Z') });
    await db.pool.query(`insert into payment_tokens (case_id, tenant_id, token_hash, expires_at) values ($1,$2,$3,$4)`, [c.id, t.id, 'a'.repeat(64), new Date('2026-11-20T00:00:00Z')]);

    expect(await closeCaseManually(deps, t.id, c.id, actor, '  ')).toEqual({ status: 'reason_required' });
    expect((await state(c.id)).state).toBe('RECOVERING');

    expect(await closeCaseManually(deps, t.id, c.id, actor, 'Client contacté par téléphone')).toEqual({ status: 'ok' });
    expect(await state(c.id)).toMatchObject({ state: 'CLOSED_MANUAL', close_reason: 'Client contacté par téléphone' });
    expect((await steps(c.id))[0].status).toBe('CANCELED');
    const tok = await db.pool.query(`select revoked_at from payment_tokens where case_id = $1`, [c.id]);
    expect(tok.rows[0].revoked_at).not.toBeNull();
    const log = await listCaseActions(db.pool, t.id, c.id);
    expect(log.at(-1)).toMatchObject({ action: 'case.closed_manual', actor });
    expect(await closeCaseManually(deps, t.id, c.id, actor, 'encore')).toEqual({ status: 'invalid_state' });
  });

  it('un dossier en pause peut être clôturé', async () => {
    const deps = makeDeps(db, NOW);
    const { t, c } = await openCase('PAUSED');
    expect(await closeCaseManually(deps, t.id, c.id, actor, 'Abonnement annulé par mail')).toEqual({ status: 'ok' });
  });
});

describe('export CSV des paiements récupérés', () => {
  async function seedLedger(t: string, rows: { name: string; amount: number; at: string; attribution?: string; kind?: string }[]) {
    for (const [i, r] of rows.entries()) {
      const cust = await db.pool.query(`insert into end_customers (tenant_id, stripe_customer_id, name, email) values ($1,$2,$3,'x@y.z') returning id`, [t, `cus_csv_${t}_${i}`, r.name]);
      const c = await seedCase(db.pool, t, { state: 'RECOVERED', customerId: `cus_csv_${t}_${i}` });
      await db.pool.query(`update recovery_cases set end_customer_id = $2 where id = $1`, [c.id, cust.rows[0].id]);
      await db.pool.query(
        `insert into recovery_ledger (tenant_id, case_id, invoice_id, kind, attribution, amount, currency, occurred_at) values ($1,$2,$3,$4,$5,$6,'EUR',$7)`,
        [t, c.id, c.invoiceId, r.kind ?? 'RECOVERY', r.attribution ?? 'ASSISTED', r.amount, new Date(r.at)],
      );
    }
  }
  const collect = async (gen: AsyncGenerator<string>) => {
    const chunks: string[] = [];
    for await (const c of gen) chunks.push(c);
    return chunks;
  };

  it('produit un CSV français (BOM, point-virgule, montants décimaux, fuseau du tenant)', async () => {
    const deps = makeDeps(db, NOW);
    const t = await seedTenant(db.pool);
    await seedLedger(t.id, [
      { name: 'Léa Martin', amount: 2900, at: '2026-10-05T10:30:00Z' },
      { name: 'Orbit Labs', amount: -500, at: '2026-10-06T08:00:00Z', kind: 'ADJUSTMENT' },
    ]);
    const text = (await collect(exportRecoveredCsv(deps, t.id, { year: 2026, month: 10 }))).join('');
    expect(text.charCodeAt(0)).toBe(0xfeff);
    const lines = text.slice(1).trim().split('\r\n');
    expect(lines[0]).toBe('Date;Client;Type;Attribution;Montant;Devise;Facture Stripe;Lien Stripe');
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain('2026-10-06 10:00;Orbit Labs;Ajustement;Récupéré;-5,00;EUR;');
    expect(lines[2]).toContain('2026-10-05 12:30;Léa Martin;Récupération;Récupéré;29,00;EUR;');
  });

  it('distingue le paiement naturel du revenu récupéré', async () => {
    const deps = makeDeps(db, NOW);
    const t = await seedTenant(db.pool);
    await seedLedger(t.id, [{ name: 'Nat', amount: 1000, at: '2026-10-05T10:00:00Z', attribution: 'NATURAL' }]);
    const text = (await collect(exportRecoveredCsv(deps, t.id, { year: 2026, month: 10 }))).join('');
    expect(text).toContain('Payé avant relance (non compté)');
  });

  it('échappe les guillemets, points-virgules et neutralise les formules (injection CSV)', async () => {
    const deps = makeDeps(db, NOW);
    const t = await seedTenant(db.pool);
    await seedLedger(t.id, [
      { name: 'Dupont; "Fils"', amount: 100, at: '2026-10-05T10:00:00Z' },
      { name: '=HYPERLINK("http://evil","x")', amount: 100, at: '2026-10-06T10:00:00Z' },
      { name: '+cmd|calc', amount: 100, at: '2026-10-07T10:00:00Z' },
    ]);
    const text = (await collect(exportRecoveredCsv(deps, t.id, { year: 2026, month: 10 }))).join('');
    expect(text).toContain('"Dupont; ""Fils"""');
    expect(text).toContain(`'=HYPERLINK`);
    expect(text).not.toMatch(/;=HYPERLINK/);
    expect(text).toContain("'+cmd|calc");
  });

  it('diffuse en plusieurs blocs pour de gros volumes', async () => {
    const deps = makeDeps(db, NOW);
    const t = await seedTenant(db.pool);
    const rows = Array.from({ length: 1200 }, (_, i) => ({ name: `Client ${i}`, amount: 100 + i, at: '2026-10-05T10:00:00Z' }));
    await seedLedger(t.id, rows);
    const chunks = await collect(exportRecoveredCsv(deps, t.id, { year: 2026, month: 10 }));
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.join('').trim().split('\r\n')).toHaveLength(1201);
  });

  it('n’exporte jamais les données d’un autre tenant', async () => {
    const deps = makeDeps(db, NOW);
    const a = await seedTenant(db.pool);
    const b = await seedTenant(db.pool);
    await seedLedger(a.id, [{ name: 'Secret', amount: 100, at: '2026-10-05T10:00:00Z' }]);
    const text = (await collect(exportRecoveredCsv(deps, b.id, { year: 2026, month: 10 }))).join('');
    expect(text).not.toContain('Secret');
    expect(text.slice(1).trim().split('\r\n')).toHaveLength(1);
  });
});
