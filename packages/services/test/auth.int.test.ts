import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '@recoverkit/testkit';
import { consumeLoginLink, getSession, requestLoginLink, revokeSession } from '../src/auth/auth';
import { DEFAULT_TENANT_NAME } from '../src/settings/general';
import { makeDeps, type TestDeps } from './helpers';

let db: TestDb;
let deps: TestDeps;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.dispose();
});

function tokenFromLastMail(email: string): string {
  const mail = deps.mailer.messagesTo(email).at(-1)!;
  const m = mail.text.match(/token=([A-Za-z0-9_-]+)/);
  expect(m).not.toBeNull();
  return m![1]!;
}

describe('connexion par lien magique', () => {
  it('envoie un lien contenant un token, stocke seulement son hash', async () => {
    deps = makeDeps(db);
    const r = await requestLoginLink(deps, 'Lea@Example.com ', { ip: '1.1.1.1' });
    expect(r).toEqual({ status: 'sent' });
    expect(deps.mailer.sent).toHaveLength(1);
    const mail = deps.mailer.sent[0]!;
    expect(mail.to).toBe('lea@example.com');
    expect(mail.text).toContain('https://app.recoverkit.test/auth/verify?token=');
    const token = tokenFromLastMail('lea@example.com');
    const dump = await db.pool.query(`select row_to_json(l)::text j from login_tokens l`);
    expect(dump.rows.map((x) => x.j).join('')).not.toContain(token);
  });

  it('répond pareil que le compte existe ou non (pas d’énumération)', async () => {
    deps = makeDeps(db);
    const known = await requestLoginLink(deps, 'lea@example.com', { ip: '2.2.2.2' });
    const unknown = await requestLoginLink(deps, 'inconnu@example.com', { ip: '2.2.2.3' });
    expect(known).toEqual(unknown);
    expect(deps.mailer.messagesTo('inconnu@example.com')).toHaveLength(1);
  });

  it('refuse une adresse invalide sans envoyer d’email', async () => {
    deps = makeDeps(db);
    expect(await requestLoginLink(deps, 'pas-un-email', { ip: '3.3.3.3' })).toEqual({ status: 'invalid' });
    expect(deps.mailer.sent).toHaveLength(0);
  });

  it('limite le débit par email (5 par heure) puis par IP (20 par heure)', async () => {
    deps = makeDeps(db);
    const res = [];
    for (let i = 0; i < 7; i++) res.push(await requestLoginLink(deps, 'spam@example.com', { ip: `9.9.9.${i}` }));
    expect(res.map((r) => r.status)).toEqual(['sent', 'sent', 'sent', 'sent', 'sent', 'rate_limited', 'rate_limited']);
    expect(deps.mailer.messagesTo('spam@example.com')).toHaveLength(5);

    deps = makeDeps(db);
    const byIp = [];
    for (let i = 0; i < 22; i++) byIp.push(await requestLoginLink(deps, `u${i}@example.com`, { ip: '8.8.8.8' }));
    expect(byIp.filter((r) => r.status === 'rate_limited')).toHaveLength(2);
  });

  it('un premier login crée le tenant, l’utilisateur et la séquence par défaut', async () => {
    deps = makeDeps(db);
    await requestLoginLink(deps, 'new@example.com', { ip: '4.4.4.4' });
    const out = await consumeLoginLink(deps, tokenFromLastMail('new@example.com'));
    expect(out.status).toBe('ok');
    if (out.status !== 'ok') return;
    expect(out.isNew).toBe(true);
    const seq = await db.pool.query(`select version, steps from sequences where tenant_id = $1`, [out.tenantId]);
    expect(seq.rows).toHaveLength(1);
    expect(seq.rows[0].version).toBe(1);
    expect(seq.rows[0].steps).toHaveLength(4);
    const tenant = await db.pool.query(`select name, dry_run, emails_enabled from tenants where id = $1`, [out.tenantId]);
    expect(tenant.rows[0]).toEqual({ name: DEFAULT_TENANT_NAME, dry_run: true, emails_enabled: true });
  });

  it('un second login retrouve le même tenant', async () => {
    deps = makeDeps(db);
    await requestLoginLink(deps, 'twice@example.com', { ip: '5.5.5.5' });
    const first = await consumeLoginLink(deps, tokenFromLastMail('twice@example.com'));
    await requestLoginLink(deps, 'twice@example.com', { ip: '5.5.5.5' });
    const second = await consumeLoginLink(deps, tokenFromLastMail('twice@example.com'));
    if (first.status !== 'ok' || second.status !== 'ok') throw new Error('attendu ok');
    expect(second.tenantId).toBe(first.tenantId);
    expect(second.isNew).toBe(false);
  });

  it('le lien est à usage unique', async () => {
    deps = makeDeps(db);
    await requestLoginLink(deps, 'once@example.com', { ip: '6.6.6.6' });
    const token = tokenFromLastMail('once@example.com');
    expect((await consumeLoginLink(deps, token)).status).toBe('ok');
    expect((await consumeLoginLink(deps, token)).status).toBe('invalid');
  });

  it('un usage concurrent ne crée qu’une session', async () => {
    deps = makeDeps(db);
    await requestLoginLink(deps, 'race@example.com', { ip: '6.6.6.7' });
    const token = tokenFromLastMail('race@example.com');
    const results = await Promise.all([consumeLoginLink(deps, token), consumeLoginLink(deps, token), consumeLoginLink(deps, token)]);
    expect(results.filter((r) => r.status === 'ok')).toHaveLength(1);
    const n = await db.pool.query(`select count(*)::int n from users where lower(email) = 'race@example.com'`);
    expect(n.rows[0].n).toBe(1);
  });

  it('refuse un lien expiré (15 minutes) ou inconnu', async () => {
    deps = makeDeps(db);
    await requestLoginLink(deps, 'late@example.com', { ip: '7.7.7.7' });
    const token = tokenFromLastMail('late@example.com');
    deps.clock.advance({ minutes: 16 });
    expect((await consumeLoginLink(deps, token)).status).toBe('invalid');
    expect((await consumeLoginLink(deps, 'inconnu')).status).toBe('invalid');
  });
});

describe('sessions', () => {
  async function login(email: string) {
    await requestLoginLink(deps, email, { ip: `10.0.0.${Math.floor(Math.random() * 200)}` });
    const out = await consumeLoginLink(deps, tokenFromLastMail(email));
    if (out.status !== 'ok') throw new Error('login impossible');
    return out;
  }

  it('retrouve l’identité depuis le token de session', async () => {
    deps = makeDeps(db);
    const out = await login('sess@example.com');
    expect(await getSession(deps, out.sessionToken)).toMatchObject({ tenantId: out.tenantId, email: 'sess@example.com' });
    expect(await getSession(deps, 'inconnu')).toBeNull();
  });

  it('stocke le hash de session, pas le token', async () => {
    deps = makeDeps(db);
    const out = await login('hash@example.com');
    const dump = await db.pool.query(`select row_to_json(s)::text j from sessions s where tenant_id = $1`, [out.tenantId]);
    expect(dump.rows[0].j).not.toContain(out.sessionToken);
  });

  it('expire après 30 jours', async () => {
    deps = makeDeps(db);
    const out = await login('exp@example.com');
    deps.clock.advance({ days: 31 });
    expect(await getSession(deps, out.sessionToken)).toBeNull();
  });

  it('la durée est glissante : un usage prolonge la session', async () => {
    deps = makeDeps(db);
    const out = await login('slide@example.com');
    deps.clock.advance({ days: 20 });
    expect(await getSession(deps, out.sessionToken)).not.toBeNull();
    deps.clock.advance({ days: 20 }); // 40 j après la création, 20 j après le dernier usage
    expect(await getSession(deps, out.sessionToken)).not.toBeNull();
  });

  it('la déconnexion révoque la session', async () => {
    deps = makeDeps(db);
    const out = await login('bye@example.com');
    await revokeSession(deps, out.sessionToken);
    expect(await getSession(deps, out.sessionToken)).toBeNull();
  });
});
