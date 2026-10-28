import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, seedCase, seedStep, seedTenant, type TestDb } from '@recoverkit/testkit';
import {
  buildConnectUrl,
  disconnectStripe,
  getConnection,
  handleDeauthorized,
  handleOAuthCallback,
} from '../src/stripe/connect';
import { requestLoginLink, consumeLoginLink, getSession } from '../src/auth/auth';
import { makeDeps, type TestDeps } from './helpers';

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.dispose();
});

async function newSession(deps: TestDeps, email: string) {
  await requestLoginLink(deps, email, { ip: `10.1.${Math.floor(Math.random() * 250)}.1` });
  const token = deps.mailer.messagesTo(email).at(-1)!.text.match(/token=([\w-]+)/)![1]!;
  const out = await consumeLoginLink(deps, token);
  if (out.status !== 'ok') throw new Error('login');
  const session = await getSession(deps, out.sessionToken);
  return session!;
}

describe('connexion Stripe (OAuth)', () => {
  it("construit l'URL d'autorisation avec un state lié à la session", async () => {
    const deps = makeDeps(db);
    const s = await newSession(deps, 'oauth1@example.com');
    const url = new URL(await buildConnectUrl(deps, s));
    expect(url.origin + url.pathname).toBe('https://connect.stripe.com/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe('ca_test');
    expect(url.searchParams.get('scope')).toBe('read_write');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('redirect_uri')).toBe('https://app.recoverkit.test/api/stripe/oauth/callback');
    expect(url.searchParams.get('state')).toMatch(/^[\w-]{20,}$/);
  });

  it('un callback valide connecte le compte (PENDING→ACTIVE)', async () => {
    const deps = makeDeps(db);
    const s = await newSession(deps, 'oauth2@example.com');
    const state = new URL(await buildConnectUrl(deps, s)).searchParams.get('state')!;
    deps.stripe.setOAuthCode('code_ok', { stripeUserId: 'acct_oauth2', livemode: false });
    const r = await handleOAuthCallback(deps, s, { code: 'code_ok', state });
    expect(r).toEqual({ status: 'connected', accountId: 'acct_oauth2' });
    expect(await getConnection(deps, s.tenantId)).toMatchObject({ status: 'ACTIVE', stripeAccountId: 'acct_oauth2', livemode: false });
  });

  it('refuse un state inconnu, expiré, déjà utilisé ou d’une autre session', async () => {
    const deps = makeDeps(db);
    const s = await newSession(deps, 'oauth3@example.com');
    const other = await newSession(deps, 'oauth4@example.com');
    deps.stripe.setOAuthCode('c', { stripeUserId: 'acct_x', livemode: false });

    expect(await handleOAuthCallback(deps, s, { code: 'c', state: 'inconnu' })).toEqual({ status: 'invalid_state' });

    const state = new URL(await buildConnectUrl(deps, s)).searchParams.get('state')!;
    expect(await handleOAuthCallback(deps, other, { code: 'c', state })).toEqual({ status: 'invalid_state' });

    const ok = await handleOAuthCallback(deps, s, { code: 'c', state });
    expect(ok.status).toBe('connected');
    expect(await handleOAuthCallback(deps, s, { code: 'c', state })).toEqual({ status: 'invalid_state' });

    const state2 = new URL(await buildConnectUrl(deps, s)).searchParams.get('state')!;
    deps.clock.advance({ minutes: 11 });
    expect(await handleOAuthCallback(deps, s, { code: 'c', state: state2 })).toEqual({ status: 'invalid_state' });
  });

  it("refus de l'autorisation par l'utilisateur", async () => {
    const deps = makeDeps(db);
    const s = await newSession(deps, 'oauth5@example.com');
    const state = new URL(await buildConnectUrl(deps, s)).searchParams.get('state')!;
    expect(await handleOAuthCallback(deps, s, { error: 'access_denied', state })).toEqual({ status: 'denied' });
    expect(await getConnection(deps, s.tenantId)).toBeNull();
  });

  it('code OAuth invalide : erreur explicite, aucune connexion créée', async () => {
    const deps = makeDeps(db);
    const s = await newSession(deps, 'oauth6@example.com');
    const state = new URL(await buildConnectUrl(deps, s)).searchParams.get('state')!;
    expect(await handleOAuthCallback(deps, s, { code: 'mauvais', state })).toEqual({ status: 'exchange_failed' });
    expect(await getConnection(deps, s.tenantId)).toBeNull();
  });

  it('un compte Stripe déjà relié à un autre tenant est refusé', async () => {
    const deps = makeDeps(db);
    const a = await newSession(deps, 'oauth7@example.com');
    const b = await newSession(deps, 'oauth8@example.com');
    deps.stripe.setOAuthCode('shared', { stripeUserId: 'acct_shared', livemode: false });
    const sa = new URL(await buildConnectUrl(deps, a)).searchParams.get('state')!;
    await handleOAuthCallback(deps, a, { code: 'shared', state: sa });
    const sb = new URL(await buildConnectUrl(deps, b)).searchParams.get('state')!;
    expect(await handleOAuthCallback(deps, b, { code: 'shared', state: sb })).toEqual({ status: 'account_taken' });
  });
});

describe('révocation', () => {
  async function connected(email: string, account: string) {
    const deps = makeDeps(db);
    const s = await newSession(deps, email);
    deps.stripe.setOAuthCode(`code_${account}`, { stripeUserId: account, livemode: false });
    const state = new URL(await buildConnectUrl(deps, s)).searchParams.get('state')!;
    await handleOAuthCallback(deps, s, { code: `code_${account}`, state });
    return { deps, s };
  }

  it('account.application.deauthorized : REVOKED et étapes annulées', async () => {
    const { deps, s } = await connected('rev1@example.com', 'acct_rev1');
    const c = await seedCase(db.pool, s.tenantId);
    const step = await seedStep(db.pool, c.id, s.tenantId, { status: 'SCHEDULED' });
    const sent = await seedStep(db.pool, c.id, s.tenantId, { stepIndex: 1, status: 'SENT' });

    expect(await handleDeauthorized(deps, 'acct_rev1')).toEqual({ status: 'revoked', tenantId: s.tenantId });
    expect(await getConnection(deps, s.tenantId)).toMatchObject({ status: 'REVOKED' });
    const rows = await db.pool.query(`select id, status, skip_reason from scheduled_steps where id = any($1)`, [[step.id, sent.id]]);
    const by = Object.fromEntries(rows.rows.map((r) => [r.id, r]));
    expect(by[step.id]).toMatchObject({ status: 'CANCELED', skip_reason: 'stripe_revoked' });
    expect(by[sent.id].status).toBe('SENT');
    const alerts = await db.pool.query(`select kind from system_alerts where tenant_id = $1`, [s.tenantId]);
    expect(alerts.rows.map((r) => r.kind)).toContain('stripe_revoked');
  });

  it('compte inconnu : ignoré sans erreur', async () => {
    const deps = makeDeps(db);
    expect(await handleDeauthorized(deps, 'acct_inconnu')).toEqual({ status: 'unknown_account' });
  });

  it('déconnexion volontaire : appelle Stripe et révoque', async () => {
    const { deps, s } = await connected('rev2@example.com', 'acct_rev2');
    await disconnectStripe(deps, s.tenantId);
    expect(deps.stripe.deauthorized).toContain('acct_rev2');
    expect(await getConnection(deps, s.tenantId)).toMatchObject({ status: 'REVOKED' });
  });

  it('reconnexion d’un tenant révoqué : réactive sans doubler la ligne', async () => {
    const { deps, s } = await connected('rev3@example.com', 'acct_rev3');
    await handleDeauthorized(deps, 'acct_rev3');
    deps.stripe.setOAuthCode('again', { stripeUserId: 'acct_rev3', livemode: false });
    const state = new URL(await buildConnectUrl(deps, s)).searchParams.get('state')!;
    expect((await handleOAuthCallback(deps, s, { code: 'again', state })).status).toBe('connected');
    expect(await getConnection(deps, s.tenantId)).toMatchObject({ status: 'ACTIVE', revokedAt: null });
    const n = await db.pool.query(`select count(*)::int n from stripe_connections where tenant_id = $1`, [s.tenantId]);
    expect(n.rows[0].n).toBe(1);
  });

  it('un autre compte Stripe pour le même tenant remplace la connexion', async () => {
    const { deps, s } = await connected('rev4@example.com', 'acct_rev4a');
    deps.stripe.setOAuthCode('other', { stripeUserId: 'acct_rev4b', livemode: false });
    const state = new URL(await buildConnectUrl(deps, s)).searchParams.get('state')!;
    expect((await handleOAuthCallback(deps, s, { code: 'other', state })).status).toBe('connected');
    expect(await getConnection(deps, s.tenantId)).toMatchObject({ stripeAccountId: 'acct_rev4b' });
  });
});

void seedTenant;
