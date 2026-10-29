import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, seedCase, seedStep, seedTenant, type TestDb } from '@recoverkit/testkit';
import { runWeeklyDigests, isoWeekOf } from '../src/notifications/digest';
import { notifyFounderAlerts } from '../src/notifications/alerts';
import { exportTenantData } from '../src/compliance/export';
import { deleteTenant } from '../src/compliance/delete';
import { purgeRetention, INBOX_RETENTION_DAYS } from '../src/compliance/retention';
import { getSession } from '../src/auth/auth';
import { makeDeps } from './helpers';

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.dispose();
});

async function tenantWithUser(email: string, o: Partial<{ name: string; locale: string; tz: string }> = {}) {
  const t = await seedTenant(db.pool, { name: o.name ?? 'Nimbus Notes', timeZone: o.tz ?? 'Europe/Paris' });
  await db.pool.query(`update tenants set locale = $2 where id = $1`, [t.id, o.locale ?? 'fr']);
  await db.pool.query(`insert into users (tenant_id, email) values ($1, $2)`, [t.id, email]);
  return t;
}
async function ledger(tenantId: string, amount: number, at: string, attribution = 'ASSISTED', kind = 'RECOVERY') {
  const c = await seedCase(db.pool, tenantId, { state: 'RECOVERED' });
  await db.pool.query(`insert into recovery_ledger (tenant_id, case_id, invoice_id, kind, attribution, amount, currency, occurred_at) values ($1,$2,$3,$4,$5,$6,'EUR',$7)`, [tenantId, c.id, c.invoiceId, kind, attribution, amount, new Date(at)]);
}

describe('isoWeekOf', () => {
  it('donne la semaine ISO dans le fuseau du tenant', () => {
    expect(isoWeekOf(new Date('2026-10-26T08:00:00Z'), 'Europe/Paris')).toBe('2026-W44');
    expect(isoWeekOf(new Date('2026-10-25T23:30:00Z'), 'Europe/Paris')).toBe('2026-W44'); // lundi 00:30 à Paris (UTC+1)
    expect(isoWeekOf(new Date('2026-10-25T22:30:00Z'), 'Europe/Paris')).toBe('2026-W43'); // dimanche 23:30 à Paris
    expect(isoWeekOf(new Date('2026-01-01T12:00:00Z'), 'Europe/Paris')).toBe('2026-W01');
    expect(isoWeekOf(new Date('2027-01-01T12:00:00Z'), 'Europe/Paris')).toBe('2026-W53');
  });
});

describe('digest hebdomadaire', () => {
  // lundi 26 oct. 2026 : la semaine passée est du 19 au 25 oct.
  const MONDAY_8H = new Date('2026-10-26T07:00:00Z'); // 08:00 à Paris (heure d'hiver déjà passée : UTC+1)

  it('n’envoie rien avant lundi 8 h locale', async () => {
    const deps = makeDeps(db, new Date('2026-10-26T06:59:00Z')); // 07:59 Paris
    const t = await tenantWithUser('fondateur1@example.com');
    await ledger(t.id, 2900, '2026-10-21T10:00:00Z');
    await runWeeklyDigests(deps);
    expect(deps.mailer.messagesTo('fondateur1@example.com')).toHaveLength(0);
  });

  it('envoie le récapitulatif de la semaine passée, une seule fois par semaine', async () => {
    const deps = makeDeps(db, MONDAY_8H);
    const t = await tenantWithUser('fondateur2@example.com');
    await ledger(t.id, 7900, '2026-10-21T10:00:00Z');
    await ledger(t.id, 2900, '2026-10-22T10:00:00Z');
    await ledger(t.id, 3100, '2026-10-22T11:00:00Z', 'NATURAL');
    await ledger(t.id, 9999, '2026-10-12T10:00:00Z'); // semaine d'avant : exclue
    await seedCase(db.pool, t.id, { state: 'RECOVERING', amountDue: 15600 });

    expect(await runWeeklyDigests(deps)).toMatchObject({ sent: expect.any(Number) });
    const mails = deps.mailer.messagesTo('fondateur2@example.com');
    expect(mails).toHaveLength(1);
    const text = mails[0]!.text.replace(/\s/g, ' ');
    expect(mails[0]!.subject).toContain('Nimbus Notes');
    expect(text).toContain('108,00 €'); // 7900 + 2900
    expect(text).toContain('2 clients');
    expect(text).toContain('156,00 €'); // à risque
    expect(text).toContain('https://app.recoverkit.test/app');
    expect(text).not.toContain('99,99');

    await runWeeklyDigests(deps);
    await runWeeklyDigests(deps);
    expect(deps.mailer.messagesTo('fondateur2@example.com')).toHaveLength(1);
    const rows = await db.pool.query(`select iso_week from digests where tenant_id = $1`, [t.id]);
    expect(rows.rows).toEqual([{ iso_week: '2026-W44' }]);
  });

  it('rattrape un lundi manqué dans la semaine, puis ne repart pas la semaine suivante sans nouveau lundi', async () => {
    const deps = makeDeps(db, new Date('2026-10-28T10:00:00Z')); // mercredi
    const t = await tenantWithUser('fondateur3@example.com');
    await ledger(t.id, 2900, '2026-10-21T10:00:00Z');
    await ledger(t.id, 1900, '2026-10-29T10:00:00Z'); // activité de la semaine suivante
    await runWeeklyDigests(deps);
    expect(deps.mailer.messagesTo('fondateur3@example.com')).toHaveLength(1);
    deps.clock.set(new Date('2026-11-02T08:00:00Z')); // lundi suivant
    await runWeeklyDigests(deps);
    expect(deps.mailer.messagesTo('fondateur3@example.com')).toHaveLength(2);
  });

  it('respecte l’option de désactivation, les tenants suspendus et l’absence totale d’activité', async () => {
    const deps = makeDeps(db, MONDAY_8H);
    const off = await tenantWithUser('off@example.com');
    await ledger(off.id, 2900, '2026-10-21T10:00:00Z');
    await db.pool.query(`update tenants set digest_enabled = false where id = $1`, [off.id]);
    const suspended = await tenantWithUser('susp@example.com');
    await ledger(suspended.id, 2900, '2026-10-21T10:00:00Z');
    await db.pool.query(`update tenants set status = 'SUSPENDED' where id = $1`, [suspended.id]);
    await tenantWithUser('calme@example.com');
    await runWeeklyDigests(deps);
    for (const e of ['off@example.com', 'susp@example.com', 'calme@example.com']) expect(deps.mailer.messagesTo(e)).toHaveLength(0);
  });

  it('aucun email vide quand la semaine n’a que du NATURAL et aucun dossier à risque', async () => {
    const deps = makeDeps(db, MONDAY_8H);
    await tenantWithUser('naturel@example.com');
    const t = (await db.pool.query(`select id from tenants order by created_at desc limit 1`)).rows[0];
    await ledger(t.id, 3100, '2026-10-22T11:00:00Z', 'NATURAL');
    await runWeeklyDigests(deps);
    expect(deps.mailer.messagesTo('naturel@example.com')).toHaveLength(0);
  });

  it('le titre prend la devise qui a le plus récupéré, pas la première par ordre alphabétique', async () => {
    const deps = makeDeps(db, MONDAY_8H);
    const t = await tenantWithUser('multi@example.com');
    const c = await seedCase(db.pool, t.id, { state: 'RECOVERED' });
    await db.pool.query(`insert into recovery_ledger (tenant_id, case_id, invoice_id, kind, attribution, amount, currency, occurred_at) values ($1,$2,$3,'RECOVERY','ASSISTED',5000,'USD',$4)`, [t.id, c.id, c.invoiceId, new Date('2026-10-22T10:00:00Z')]);
    await seedCase(db.pool, t.id, { state: 'RECOVERING', amountDue: 2900 });
    await runWeeklyDigests(deps);
    const mail = deps.mailer.messagesTo('multi@example.com')[0]!;
    expect(mail.subject.replace(/\s/g, ' ')).toContain('50,00');
    expect(mail.subject).not.toContain('0,00 €');
  });

  it('en anglais pour un tenant en anglais, et une erreur d’envoi n’empêche pas un nouvel essai', async () => {
    const deps = makeDeps(db, MONDAY_8H);
    const t = await tenantWithUser('en@example.com', { locale: 'en' });
    await ledger(t.id, 2900, '2026-10-21T10:00:00Z');
    deps.mailer.failNext(new Error('boom'));
    await runWeeklyDigests(deps);
    expect(deps.mailer.messagesTo('en@example.com')).toHaveLength(0);
    expect((await db.pool.query(`select 1 from digests where tenant_id = $1`, [t.id])).rowCount).toBe(0);
    await runWeeklyDigests(deps);
    const mail = deps.mailer.messagesTo('en@example.com')[0]!;
    expect(mail.subject).toContain('weekly');
  });
});

describe('alertes envoyées au fondateur', () => {
  it('envoie un seul email groupé par tenant, une seule fois par alerte', async () => {
    const deps = makeDeps(db);
    const t = await tenantWithUser('alerte@example.com');
    await db.pool.query(`insert into system_alerts (tenant_id, kind, dedupe_key, message) values ($1,'stripe_revoked','a1','La connexion Stripe a été révoquée.'), ($1,'email_failed','a2','Un email n''a pas pu être envoyé.'), ($1,'email_bounced','a3','Rebond.')`, [t.id]);
    expect(await notifyFounderAlerts(deps)).toEqual({ emails: 1, alerts: 2 });
    const mails = deps.mailer.messagesTo('alerte@example.com');
    expect(mails).toHaveLength(1);
    expect(mails[0]!.text).toContain('La connexion Stripe a été révoquée.');
    expect(mails[0]!.text).toContain('Un email n\'a pas pu être envoyé.');
    expect(mails[0]!.text).not.toContain('Rebond.'); // info : pas d'email
    expect(await notifyFounderAlerts(deps)).toEqual({ emails: 0, alerts: 0 });
  });

  it('ignore les alertes résolues et celles sans tenant', async () => {
    const deps = makeDeps(db);
    const t = await tenantWithUser('resolu@example.com');
    await db.pool.query(`insert into system_alerts (tenant_id, kind, dedupe_key, message, resolved_at) values ($1,'email_failed','r1','x', now())`, [t.id]);
    await db.pool.query(`insert into system_alerts (tenant_id, kind, dedupe_key, message) values (null,'webhook_dead','r2','sans tenant')`);
    expect(await notifyFounderAlerts(deps)).toEqual({ emails: 0, alerts: 0 });
  });
});

describe('export des données du tenant', () => {
  it('contient les données du tenant, sans secrets, et jamais celles d’un autre', async () => {
    const deps = makeDeps(db);
    const a = await tenantWithUser('a@example.com', { name: 'Tenant A' });
    const b = await tenantWithUser('b@example.com', { name: 'Tenant B' });
    const caseA = await seedCase(db.pool, a.id, { amountDue: 4242 });
    await seedCase(db.pool, b.id, { amountDue: 9999 });
    await seedStep(db.pool, caseA.id, a.id);
    await db.pool.query(`insert into payment_tokens (case_id, tenant_id, token_hash, expires_at) values ($1,$2,$3,now())`, [caseA.id, a.id, 'secret-hash'.padEnd(64, '0')]);
    await db.pool.query(`insert into end_customers (tenant_id, stripe_customer_id, email, name) values ($1,'cus_x','client@example.com','Client A')`, [a.id]);
    await ledger(a.id, 4242, '2026-10-05T10:00:00Z');

    const data = await exportTenantData(deps, a.id);
    expect(data.tenant.name).toBe('Tenant A');
    expect(data.cases).toHaveLength(2); // seedCase + ledger()
    expect(data.cases.map((c: any) => c.amount_due)).toContain(4242);
    expect(data.customers[0]).toMatchObject({ email: 'client@example.com' });
    expect(data.ledger.length).toBe(1);
    const json = JSON.stringify(data);
    expect(json).not.toContain('Tenant B');
    expect(json).not.toContain('9999');
    expect(json).not.toContain('secret-hash');
    expect(json).not.toContain('token_hash');
    expect(data.exportedAt).toBe(deps.clock.now().toISOString());
    void b;
  });
});

describe('suppression du compte', () => {
  async function fullTenant(email: string) {
    const t = await tenantWithUser(email, { name: 'À supprimer' });
    const c = await seedCase(db.pool, t.id);
    await seedStep(db.pool, c.id, t.id);
    await db.pool.query(`insert into stripe_connections (tenant_id, stripe_account_id, status) values ($1,$2,'ACTIVE')`, [t.id, `acct_del_${email}`]);
    await db.pool.query(`insert into end_customers (tenant_id, stripe_customer_id, email) values ($1,'cus_d','c@example.com')`, [t.id]);
    await db.pool.query(`insert into action_log (tenant_id, case_id, actor, action) values ($1,$2,'system','case.opened')`, [t.id, c.id]);
    await ledger(t.id, 2900, '2026-10-05T10:00:00Z');
    return t;
  }

  it('exige la saisie exacte du nom du tenant', async () => {
    const deps = makeDeps(db);
    const t = await fullTenant('del1@example.com');
    expect(await deleteTenant(deps, t.id, { confirmName: 'a supprimer', actor: 'user:u' })).toEqual({ status: 'confirmation_mismatch' });
    expect((await db.pool.query(`select 1 from tenants where id = $1`, [t.id])).rowCount).toBe(1);
  });

  it('révoque Stripe, supprime toutes les données du tenant, garde une trace hors tenant, épargne les autres', async () => {
    const deps = makeDeps(db);
    const t = await fullTenant('del2@example.com');
    const other = await fullTenant('keep@example.com');
    expect(await deleteTenant(deps, t.id, { confirmName: 'À supprimer', actor: 'user:u' })).toEqual({ status: 'deleted' });

    expect(deps.stripe.deauthorized).toContain('acct_del_del2@example.com');
    for (const table of ['tenants', 'users', 'recovery_cases', 'scheduled_steps', 'end_customers', 'stripe_connections']) {
      const col = table === 'tenants' ? 'id' : 'tenant_id';
      const n = await db.pool.query(`select count(*)::int n from ${table} where ${col} = $1`, [t.id]);
      expect(n.rows[0].n, table).toBe(0);
    }
    expect((await db.pool.query(`select count(*)::int n from action_log where tenant_id = $1`, [t.id])).rows[0].n).toBe(0);
    const trace = await db.pool.query(`select action, details from action_log where tenant_id is null and action = 'tenant.deleted' order by id desc limit 1`);
    expect(trace.rows[0].details.tenantId).toBe(t.id);
    expect(JSON.stringify(trace.rows[0].details)).not.toContain('À supprimer');
    // le ledger comptable est conservé (aucune donnée personnelle)
    expect((await db.pool.query(`select count(*)::int n from recovery_ledger where tenant_id = $1`, [t.id])).rows[0].n).toBe(1);
    // l'autre tenant est intact
    expect((await db.pool.query(`select count(*)::int n from recovery_cases where tenant_id = $1`, [other.id])).rows[0].n).toBeGreaterThan(0);
  });

  it('les sessions du tenant supprimé ne sont plus valides', async () => {
    const deps = makeDeps(db);
    const t = await fullTenant('del3@example.com');
    const user = (await db.pool.query(`select id from users where tenant_id = $1`, [t.id])).rows[0];
    const { hashToken } = await import('@recoverkit/core');
    await db.pool.query(`insert into sessions (user_id, tenant_id, token_hash, expires_at) values ($1,$2,$3,$4)`, [user.id, t.id, hashToken('tok'), new Date('2030-01-01')]);
    expect(await getSession(deps, 'tok')).not.toBeNull();
    await deleteTenant(deps, t.id, { confirmName: 'À supprimer', actor: 'user:u' });
    expect(await getSession(deps, 'tok')).toBeNull();
  });

  it('une panne Stripe ne bloque pas la suppression', async () => {
    const deps = makeDeps(db);
    const t = await fullTenant('del4@example.com');
    deps.stripe.deauthorize = async () => {
      throw new Error('Stripe indisponible');
    };
    expect(await deleteTenant(deps, t.id, { confirmName: 'À supprimer', actor: 'user:u' })).toEqual({ status: 'deleted' });
  });
});

describe('purge de rétention', () => {
  it('efface les données personnelles des dossiers clos depuis plus de 18 mois, garde le reste', async () => {
    const deps = makeDeps(db, new Date('2026-10-28T10:00:00Z'));
    const t = await seedTenant(db.pool);
    const oldCust = (await db.pool.query(`insert into end_customers (tenant_id, stripe_customer_id, email, name) values ($1,'cus_old','vieux@example.com','Vieux') returning id`, [t.id])).rows[0].id;
    const newCust = (await db.pool.query(`insert into end_customers (tenant_id, stripe_customer_id, email, name) values ($1,'cus_new','recent@example.com','Récent') returning id`, [t.id])).rows[0].id;
    const oldCase = await seedCase(db.pool, t.id, { state: 'RECOVERED', customerId: 'cus_old' });
    const newCase = await seedCase(db.pool, t.id, { state: 'RECOVERED', customerId: 'cus_new' });
    await db.pool.query(`update recovery_cases set end_customer_id = $2, closed_at = $3 where id = $1`, [oldCase.id, oldCust, new Date('2025-03-01T00:00:00Z')]);
    await db.pool.query(`update recovery_cases set end_customer_id = $2, closed_at = $3 where id = $1`, [newCase.id, newCust, new Date('2026-09-01T00:00:00Z')]);
    for (const c of [oldCase, newCase]) {
      await db.pool.query(`insert into email_messages (tenant_id, case_id, step_index, idempotency_key, to_email, subject) values ($1,$2,0,$3,'x@y.z','s')`, [t.id, c.id, `${c.id}:0`]);
    }
    await ledger(t.id, 100, '2025-03-01T00:00:00Z');

    const r = await purgeRetention(deps);
    expect(r).toMatchObject({ customers: 1, emails: 1 });
    const old = await db.pool.query(`select email, name, anonymized_at from end_customers where id = $1`, [oldCust]);
    expect(old.rows[0]).toMatchObject({ email: null, name: null });
    expect(old.rows[0].anonymized_at).not.toBeNull();
    expect((await db.pool.query(`select email from end_customers where id = $1`, [newCust])).rows[0].email).toBe('recent@example.com');
    expect((await db.pool.query(`select count(*)::int n from email_messages where case_id = $1`, [oldCase.id])).rows[0].n).toBe(0);
    expect((await db.pool.query(`select count(*)::int n from email_messages where case_id = $1`, [newCase.id])).rows[0].n).toBe(1);
    expect((await db.pool.query(`select count(*)::int n from recovery_cases where id = $1`, [oldCase.id])).rows[0].n).toBe(1); // le dossier reste
    expect((await db.pool.query(`select count(*)::int n from recovery_ledger where tenant_id = $1`, [t.id])).rows[0].n).toBe(1);
  });

  it('conserve un client qui a encore un dossier actif ou récent, et est idempotente', async () => {
    const deps = makeDeps(db, new Date('2026-10-28T10:00:00Z'));
    const t = await seedTenant(db.pool);
    const cust = (await db.pool.query(`insert into end_customers (tenant_id, stripe_customer_id, email) values ($1,'cus_mix','mix@example.com') returning id`, [t.id])).rows[0].id;
    const old = await seedCase(db.pool, t.id, { state: 'LOST', customerId: 'cus_mix' });
    const active = await seedCase(db.pool, t.id, { state: 'RECOVERING', customerId: 'cus_mix' });
    await db.pool.query(`update recovery_cases set end_customer_id = $2 where id = any($1)`, [[old.id, active.id], cust]);
    await db.pool.query(`update recovery_cases set closed_at = '2025-01-01' where id = $1`, [old.id]);
    expect(await purgeRetention(deps)).toMatchObject({ customers: 0 });
    expect((await db.pool.query(`select email from end_customers where id = $1`, [cust])).rows[0].email).toBe('mix@example.com');
    expect(await purgeRetention(deps)).toMatchObject({ customers: 0, emails: 0 });
  });

  it('retourne tous les compteurs et journalise un résumé de purge par tenant concerné', async () => {
    const deps = makeDeps(db, new Date('2026-10-28T10:00:00Z'));
    const t = await seedTenant(db.pool);
    const cust = (await db.pool.query(`insert into end_customers (tenant_id, stripe_customer_id, email) values ($1,'cus_sum','sum@example.com') returning id`, [t.id])).rows[0].id;
    const old = await seedCase(db.pool, t.id, { state: 'LOST', customerId: 'cus_sum' });
    await db.pool.query(`update recovery_cases set end_customer_id = $2, closed_at = '2025-01-01' where id = $1`, [old.id, cust]);
    await db.pool.query(`insert into email_messages (tenant_id, case_id, step_index, idempotency_key, to_email, subject) values ($1,$2,0,$3,'x@y.z','s')`, [t.id, old.id, `${old.id}:0`]);
    await db.pool.query(`insert into login_tokens (email, token_hash, expires_at) values ('a@b.c', $1, '2026-01-01')`, [`h${old.id}`]);

    const r = await purgeRetention(deps);
    expect(r).toMatchObject({ customers: expect.any(Number), emails: expect.any(Number), inboxEvents: expect.any(Number), loginTokens: expect.any(Number), threshold: expect.any(String) });
    expect(r.customers).toBeGreaterThanOrEqual(1);
    expect(r.loginTokens).toBeGreaterThanOrEqual(1);
    const log = await db.pool.query(`select details from action_log where tenant_id = $1 and action = 'retention.purged'`, [t.id]);
    expect(log.rows).toHaveLength(1);
    expect(log.rows[0].details).toMatchObject({ emails: 1, customers: 1 });
  });
});

describe('conformité : inbox_events, login_tokens, export, domaine', () => {
  async function inbox(tenantId: string | null, account: string | null, status: string, receivedAt: Date) {
    const id = `evt_${Math.random().toString(36).slice(2)}`;
    await db.pool.query(
      `insert into inbox_events (stripe_event_id, stripe_account_id, tenant_id, type, payload, status, received_at) values ($1,$2,$3,'invoice.payment_failed',$4::jsonb,$5,$6)`,
      [id, account, tenantId, JSON.stringify({ customer_email: 'final@example.com', customer_name: 'Final' }), status, receivedAt],
    );
    return id;
  }

  it('la suppression du compte supprime inbox_events (par tenant_id et par stripe_account_id) et login_tokens du fondateur', async () => {
    const deps = makeDeps(db);
    const t = await tenantWithUser('purge-del@example.com', { name: 'Compte purge' });
    await db.pool.query(`insert into stripe_connections (tenant_id, stripe_account_id, status) values ($1,'acct_purge1','ACTIVE')`, [t.id]);
    const byTenant = await inbox(t.id, null, 'processed', deps.clock.now());
    const byAccount = await inbox(null, 'acct_purge1', 'pending', deps.clock.now());
    const other = await inbox(null, 'acct_autre', 'processed', deps.clock.now());
    await db.pool.query(`insert into login_tokens (token_hash, email, expires_at) values ('lt_del_1', 'PURGE-DEL@example.com', $1), ('lt_keep_1', 'autre@example.com', $1)`, [new Date('2030-01-01')]);

    await deleteTenant(deps, t.id, { confirmName: 'Compte purge', actor: 'user:u' });
    const left = await db.pool.query(`select stripe_event_id from inbox_events where stripe_event_id = any($1)`, [[byTenant, byAccount, other]]);
    expect(left.rows.map((r) => r.stripe_event_id)).toEqual([other]);
    const lt = await db.pool.query(`select token_hash from login_tokens where token_hash in ('lt_del_1','lt_keep_1')`);
    expect(lt.rows).toEqual([{ token_hash: 'lt_keep_1' }]);
  });

  it('la rétention purge les inbox_events terminés anciens et les login_tokens expirés', async () => {
    const deps = makeDeps(db, new Date('2026-10-28T10:00:00Z'));
    const old = new Date(deps.clock.now().getTime() - (INBOX_RETENTION_DAYS + 1) * 86_400_000);
    const recent = new Date(deps.clock.now().getTime() - 86_400_000);
    const oldProcessed = await inbox(null, 'acct_r', 'processed', old);
    const oldDead = await inbox(null, 'acct_r', 'dead', old);
    const oldPending = await inbox(null, 'acct_r', 'pending', old);
    const recentProcessed = await inbox(null, 'acct_r', 'processed', recent);
    await db.pool.query(`insert into login_tokens (token_hash, email, expires_at) values ('lt_exp', 'e@example.com', $1), ('lt_valid', 'v@example.com', $2)`, [new Date('2026-10-01'), new Date('2026-12-01')]);

    await purgeRetention(deps);
    const left = await db.pool.query(`select stripe_event_id from inbox_events where stripe_account_id = 'acct_r'`);
    expect(left.rows.map((r) => r.stripe_event_id).sort()).toEqual([oldPending, recentProcessed].sort());
    expect(left.rows.map((r) => r.stripe_event_id)).not.toContain(oldProcessed);
    expect(left.rows.map((r) => r.stripe_event_id)).not.toContain(oldDead);
    const lt = await db.pool.query(`select token_hash from login_tokens where token_hash in ('lt_exp','lt_valid')`);
    expect(lt.rows).toEqual([{ token_hash: 'lt_valid' }]);
  });

  it('la rétention anonymise un client dont seul le nom ou l’email subsiste, même avec anonymized_at déjà posé', async () => {
    const deps = makeDeps(db, new Date('2026-10-28T10:00:00Z'));
    const t = await seedTenant(db.pool);
    const cust = (await db.pool.query(`insert into end_customers (tenant_id, stripe_customer_id, email, name, anonymized_at) values ($1,'cus_re','revenu@example.com','Revenu', '2026-01-01') returning id`, [t.id])).rows[0].id;
    const c = await seedCase(db.pool, t.id, { state: 'LOST', customerId: 'cus_re' });
    await db.pool.query(`update recovery_cases set end_customer_id = $2, closed_at = '2025-01-01' where id = $1`, [c.id, cust]);
    await purgeRetention(deps);
    expect((await db.pool.query(`select email, name from end_customers where id = $1`, [cust])).rows[0]).toEqual({ email: null, name: null });
  });

  it('l’export journalise tenant.exported et inclut les données du fondateur', async () => {
    const deps = makeDeps(db);
    const t = await tenantWithUser('fondateur-export@example.com');
    await db.pool.query(`insert into stripe_connections (tenant_id, stripe_account_id, status) values ($1,'acct_exp','ACTIVE')`, [t.id]);
    const data: any = await exportTenantData(deps, t.id, { actor: 'user:abc' });
    expect(data.users[0]).toMatchObject({ email: 'fondateur-export@example.com' });
    expect(data.stripeConnections[0]).toMatchObject({ stripe_account_id: 'acct_exp' });
    expect(JSON.stringify(data)).not.toMatch(/access_token|refresh_token/);
    const log = await db.pool.query(`select actor from action_log where tenant_id = $1 and action = 'tenant.exported'`, [t.id]);
    expect(log.rows).toEqual([{ actor: 'user:abc' }]);
  });

  it('la suppression du compte supprime le domaine d’envoi, et tolère un échec du fournisseur', async () => {
    const deps = makeDeps(db);
    const t = await tenantWithUser('dom-del@example.com', { name: 'Avec domaine' });
    await db.pool.query(`update tenants set sender_domain = 'mail.exemple.fr', sender_domain_id = 'dom_x1' where id = $1`, [t.id]);
    await deleteTenant(deps, t.id, { confirmName: 'Avec domaine', actor: 'user:u' });
    expect(deps.domains.deleted).toContain('dom_x1');

    const t2 = await tenantWithUser('dom-del2@example.com', { name: 'Domaine KO' });
    await db.pool.query(`update tenants set sender_domain_id = 'dom_x2' where id = $1`, [t2.id]);
    deps.domains.deleteDomain = async () => {
      throw new Error('Resend KO');
    };
    expect(await deleteTenant(deps, t2.id, { confirmName: 'Domaine KO', actor: 'user:u' })).toEqual({ status: 'deleted' });
  });
});
