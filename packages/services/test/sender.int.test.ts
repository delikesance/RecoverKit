import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, seedTenant, type TestDb } from '@recoverkit/testkit';
import { checkSenderDomain, configureSender, removeSender } from '../src/settings/sender';
import { makeDeps } from './helpers';

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.dispose();
});

const tenantRow = async (id: string) => (await db.pool.query(`select * from tenants where id = $1`, [id])).rows[0];

describe('expéditeur personnalisé', () => {
  it('crée le domaine chez le fournisseur et renvoie les enregistrements DNS à ajouter', async () => {
    const deps = makeDeps(db);
    const t = await seedTenant(db.pool);
    const r = await configureSender(deps, t.id, { email: 'billing@nimbusnotes.example', name: 'Équipe Nimbus' });
    expect(r.status).toBe('pending');
    if (r.status !== 'pending') return;
    expect(r.records.map((x) => x.purpose)).toEqual(expect.arrayContaining(['SPF', 'DKIM', 'DMARC']));
    expect(await tenantRow(t.id)).toMatchObject({
      sender_email: 'billing@nimbusnotes.example', sender_name: 'Équipe Nimbus', sender_domain: 'nimbusnotes.example', sender_verified: false,
    });
  });

  it('refuse une adresse invalide ou un fournisseur grand public', async () => {
    const deps = makeDeps(db);
    const t = await seedTenant(db.pool);
    expect(await configureSender(deps, t.id, { email: 'pas-un-email', name: 'X' })).toEqual({ status: 'invalid' });
    for (const d of ['gmail.com', 'outlook.com', 'hotmail.fr', 'yahoo.com', 'icloud.com', 'proton.me']) {
      expect(await configureSender(deps, t.id, { email: `moi@${d}`, name: 'X' })).toEqual({ status: 'freemail' });
    }
    expect((await tenantRow(t.id)).sender_domain).toBeNull();
  });

  it('même domaine : le domaine existant est réutilisé, seule l’adresse change', async () => {
    const deps = makeDeps(db);
    const t = await seedTenant(db.pool);
    await configureSender(deps, t.id, { email: 'billing@nimbusnotes.example', name: 'A' });
    const id1 = (await tenantRow(t.id)).sender_domain_id;
    await configureSender(deps, t.id, { email: 'support@nimbusnotes.example', name: 'B' });
    const row = await tenantRow(t.id);
    expect(row.sender_domain_id).toBe(id1);
    expect(row).toMatchObject({ sender_email: 'support@nimbusnotes.example', sender_name: 'B' });
    expect(deps.domains.deleted).toHaveLength(0);
  });

  it('un autre domaine supprime l’ancien chez le fournisseur et repasse en non vérifié', async () => {
    const deps = makeDeps(db);
    const t = await seedTenant(db.pool);
    await configureSender(deps, t.id, { email: 'a@one.example', name: 'A' });
    const first = (await tenantRow(t.id)).sender_domain_id;
    deps.domains.markVerified(first);
    await checkSenderDomain(deps, t.id);
    expect((await tenantRow(t.id)).sender_verified).toBe(true);

    await configureSender(deps, t.id, { email: 'a@two.example', name: 'A' });
    expect(deps.domains.deleted).toContain(first);
    expect(await tenantRow(t.id)).toMatchObject({ sender_domain: 'two.example', sender_verified: false });
  });

  it('même domaine déjà vérifié : le statut renvoyé est « verified », pas « pending »', async () => {
    const deps = makeDeps(db);
    const t = await seedTenant(db.pool);
    await configureSender(deps, t.id, { email: 'contact@verif.example', name: 'A' });
    deps.domains.markVerified((await tenantRow(t.id)).sender_domain_id);
    await checkSenderDomain(deps, t.id);
    const r = await configureSender(deps, t.id, { email: 'factures@verif.example', name: 'A' });
    expect(r.status).toBe('verified');
    expect(await tenantRow(t.id)).toMatchObject({ sender_email: 'factures@verif.example', sender_verified: true });
  });

  it('changement de domaine : le nouveau est créé AVANT de supprimer l’ancien', async () => {
    const deps = makeDeps(db);
    const t = await seedTenant(db.pool);
    await configureSender(deps, t.id, { email: 'a@one.example', name: 'A' });
    const calls: string[] = [];
    const create = deps.domains.createDomain.bind(deps.domains);
    const del = deps.domains.deleteDomain.bind(deps.domains);
    deps.domains.createDomain = async (n: string) => (calls.push('create'), create(n));
    deps.domains.deleteDomain = async (id: string) => (calls.push('delete'), del(id));
    await configureSender(deps, t.id, { email: 'a@two.example', name: 'A' });
    expect(calls).toEqual(['create', 'delete']);
  });

  it('si la création du nouveau domaine échoue, l’ancien n’est pas supprimé et la base reste cohérente', async () => {
    const deps = makeDeps(db);
    const t = await seedTenant(db.pool);
    await configureSender(deps, t.id, { email: 'a@one.example', name: 'A' });
    const first = (await tenantRow(t.id)).sender_domain_id;
    deps.domains.createDomain = async () => {
      throw new Error('Resend a répondu 503');
    };
    await expect(configureSender(deps, t.id, { email: 'a@two.example', name: 'A' })).rejects.toThrow(/503/);
    expect(deps.domains.deleted).not.toContain(first);
    expect(await tenantRow(t.id)).toMatchObject({ sender_domain: 'one.example', sender_domain_id: first });
    expect((await checkSenderDomain(deps, t.id)).status).toBe('pending');
  });

  it('tant que le domaine n’est pas vérifié, il reste en attente ; une fois vérifié, il est actif', async () => {
    const deps = makeDeps(db);
    const t = await seedTenant(db.pool);
    await configureSender(deps, t.id, { email: 'a@nimbusnotes.example', name: 'A' });
    expect((await checkSenderDomain(deps, t.id)).status).toBe('pending');
    expect((await tenantRow(t.id)).sender_verified).toBe(false);
    deps.domains.markVerified((await tenantRow(t.id)).sender_domain_id);
    expect((await checkSenderDomain(deps, t.id)).status).toBe('verified');
    expect((await tenantRow(t.id)).sender_verified).toBe(true);
    const log = await db.pool.query(`select action from action_log where tenant_id = $1`, [t.id]);
    expect(log.rows.map((r) => r.action)).toContain('sender.verified');
  });

  it('échec de vérification : alerte unique', async () => {
    const deps = makeDeps(db);
    const t = await seedTenant(db.pool);
    await configureSender(deps, t.id, { email: 'a@nimbusnotes.example', name: 'A' });
    deps.domains.markFailed((await tenantRow(t.id)).sender_domain_id);
    expect((await checkSenderDomain(deps, t.id)).status).toBe('failed');
    await checkSenderDomain(deps, t.id);
    const alerts = await db.pool.query(`select kind from system_alerts where tenant_id = $1 and resolved_at is null`, [t.id]);
    expect(alerts.rows).toEqual([{ kind: 'sender_domain_failed' }]);
  });

  it('domaine vérifié ou supprimé : l’alerte sender_domain_failed est résolue', async () => {
    const deps = makeDeps(db);
    const open = async (id: string) => (await db.pool.query(`select count(*)::int n from system_alerts where tenant_id = $1 and kind = 'sender_domain_failed' and resolved_at is null`, [id])).rows[0].n;
    const t = await seedTenant(db.pool);
    await configureSender(deps, t.id, { email: 'a@nimbusnotes.example', name: 'A' });
    deps.domains.markFailed((await tenantRow(t.id)).sender_domain_id);
    await checkSenderDomain(deps, t.id);
    expect(await open(t.id)).toBe(1);
    deps.domains.markVerified((await tenantRow(t.id)).sender_domain_id);
    await checkSenderDomain(deps, t.id);
    expect(await open(t.id)).toBe(0);

    const t2 = await seedTenant(db.pool);
    await configureSender(deps, t2.id, { email: 'a@autre.example', name: 'A' });
    deps.domains.markFailed((await tenantRow(t2.id)).sender_domain_id);
    await checkSenderDomain(deps, t2.id);
    expect(await open(t2.id)).toBe(1);
    await removeSender(deps, t2.id);
    expect(await open(t2.id)).toBe(0);
  });

  it('sans configuration : « none » ; suppression : retour à l’expéditeur par défaut', async () => {
    const deps = makeDeps(db);
    const t = await seedTenant(db.pool);
    expect(await checkSenderDomain(deps, t.id)).toEqual({ status: 'none' });
    await configureSender(deps, t.id, { email: 'a@nimbusnotes.example', name: 'A' });
    await removeSender(deps, t.id);
    expect(await tenantRow(t.id)).toMatchObject({ sender_email: null, sender_domain: null, sender_domain_id: null, sender_verified: false });
    expect(deps.domains.deleted).toHaveLength(1);
  });
});
