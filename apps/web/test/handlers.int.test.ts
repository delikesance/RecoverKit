import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { createTestDb, seedCase, seedStep, seedTenant, signStripePayload, stripeEvent, type TestDb } from '@recoverkit/testkit';
import { consumeLoginLink, requestLoginLink, getSession, buildUnsubscribeUrl, ensurePaymentLink, tokenFromUrl } from '@recoverkit/services';
import { makeDeps, TEST_ENV, type TestDeps } from '@recoverkit/services/testing';
import { handleStripeWebhook, handlePlatformWebhook, handleResendWebhook } from '../src/server/handlers/webhooks';
import { handleLoginRequest, handleAuthConsume, handleLogout } from '../src/server/handlers/auth';
import { handleOauthStart, handleOauthCallback } from '../src/server/handlers/oauth';
import { handlePaySetup } from '../src/server/handlers/pay';
import { handleUnsubscribe } from '../src/server/handlers/unsubscribe';
import { handleExportData, handleExportRecovered } from '../src/server/handlers/exports';
import { handleHealth, handleHealthDetails } from '../src/server/handlers/health';
import { clientIp } from '../src/server/http';

let db: TestDb;
let deps: TestDeps;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.dispose();
});

const APP = 'https://app.recoverkit.test';
const form = (data: Record<string, string>) => new URLSearchParams(data).toString();
const post = (path: string, body: string, headers: Record<string, string> = {}) =>
  new Request(`${APP}${path}`, { method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded', origin: APP, ...headers } });
const get = (path: string, headers: Record<string, string> = {}) => new Request(`${APP}${path}`, { headers });

async function login(email: string): Promise<{ cookie: string; tenantId: string; token: string }> {
  await requestLoginLink(deps, email, { ip: `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` });
  const link = deps.mailer.messagesTo(email).at(-1)!.text.match(/token=([\w-]+)/)![1]!;
  const out = await consumeLoginLink(deps, link);
  if (out.status !== 'ok') throw new Error('login');
  return { cookie: `rk_session=${out.sessionToken}`, tenantId: out.tenantId, token: out.sessionToken };
}

beforeAll(() => {
  deps = makeDeps(db, new Date('2026-10-28T10:00:00Z'));
});

describe('clientIp', () => {
  it('prend la première adresse de x-forwarded-for, sinon « unknown »', () => {
    expect(clientIp(new Request(APP, { headers: { 'x-forwarded-for': '203.0.113.5, 10.0.0.1' } }))).toBe('203.0.113.5');
    expect(clientIp(new Request(APP, { headers: { 'x-real-ip': '198.51.100.2' } }))).toBe('198.51.100.2');
    expect(clientIp(new Request(APP))).toBe('unknown');
  });
});

describe('webhooks', () => {
  it('Stripe Connect : signature valide = 200, invalide = 400', async () => {
    const evt = stripeEvent('invoice.paid', { id: 'in_1' }, { account: 'acct_x', created: deps.clock.now() });
    const raw = JSON.stringify(evt);
    const ok = await handleStripeWebhook(deps, new Request(`${APP}/api/stripe/webhook`, { method: 'POST', body: raw, headers: { 'stripe-signature': signStripePayload(raw, TEST_ENV.STRIPE_CONNECT_WEBHOOK_SECRET, deps.clock.now()) } }));
    expect(ok.status).toBe(200);
    const bad = await handleStripeWebhook(deps, new Request(`${APP}/api/stripe/webhook`, { method: 'POST', body: raw, headers: { 'stripe-signature': 't=1,v1=00' } }));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: expect.any(String) });
    const missing = await handleStripeWebhook(deps, new Request(`${APP}/api/stripe/webhook`, { method: 'POST', body: raw }));
    expect(missing.status).toBe(400);
  });

  it('Stripe plateforme : utilise son propre secret', async () => {
    const evt = stripeEvent('invoice.paid', { customer: 'cus_inconnu' }, { account: null, created: deps.clock.now() });
    const raw = JSON.stringify(evt);
    const withConnectSecret = await handlePlatformWebhook(deps, new Request(`${APP}/api/stripe/platform-webhook`, { method: 'POST', body: raw, headers: { 'stripe-signature': signStripePayload(raw, TEST_ENV.STRIPE_CONNECT_WEBHOOK_SECRET, deps.clock.now()) } }));
    expect(withConnectSecret.status).toBe(400);
    const ok = await handlePlatformWebhook(deps, new Request(`${APP}/api/stripe/platform-webhook`, { method: 'POST', body: raw, headers: { 'stripe-signature': signStripePayload(raw, TEST_ENV.STRIPE_PLATFORM_WEBHOOK_SECRET, deps.clock.now()) } }));
    expect(ok.status).toBe(200);
  });

  it('Resend : en-têtes Svix', async () => {
    const raw = JSON.stringify({ type: 'email.delivered', data: { email_id: 'inconnu' } });
    const ts = String(Math.floor(deps.clock.now().getTime() / 1000));
    const sig = 'v1,' + createHmac('sha256', Buffer.from('resend-webhook-secret-for-tests')).update(`msg_h1.${ts}.${raw}`).digest('base64');
    const ok = await handleResendWebhook(deps, new Request(`${APP}/api/resend/webhook`, { method: 'POST', body: raw, headers: { 'svix-id': 'msg_h1', 'svix-timestamp': ts, 'svix-signature': sig } }));
    expect(ok.status).toBe(200);
    const bad = await handleResendWebhook(deps, new Request(`${APP}/api/resend/webhook`, { method: 'POST', body: raw, headers: { 'svix-id': 'msg_h2', 'svix-timestamp': ts, 'svix-signature': 'v1,faux' } }));
    expect(bad.status).toBe(400);
  });
});

describe('connexion', () => {
  it('demande de lien : redirection neutre, email envoyé, refus d’une autre origine', async () => {
    const r = await handleLoginRequest(deps, post('/api/auth/login', form({ email: 'nouveau@example.com' }), { 'x-forwarded-for': '203.0.113.50' }));
    expect(r.status).toBe(303);
    expect(r.headers.get('location')).toBe(`${APP}/login?sent=1`);
    expect(deps.mailer.messagesTo('nouveau@example.com')).toHaveLength(1);

    const csrf = await handleLoginRequest(deps, post('/api/auth/login', form({ email: 'x@example.com' }), { origin: 'https://evil.example' }));
    expect(csrf.status).toBe(403);
    expect(deps.mailer.messagesTo('x@example.com')).toHaveLength(0);

    const invalid = await handleLoginRequest(deps, post('/api/auth/login', form({ email: 'pas-un-email' }), { 'x-forwarded-for': '203.0.113.51' }));
    expect(invalid.headers.get('location')).toBe(`${APP}/login?error=invalid`);
  });

  it('demande de lien : trop de demandes = message dédié', async () => {
    let last: Response | undefined;
    for (let i = 0; i < 7; i++) last = await handleLoginRequest(deps, post('/api/auth/login', form({ email: 'rafale@example.com' }), { 'x-forwarded-for': `198.51.100.${i}` }));
    expect(last!.headers.get('location')).toBe(`${APP}/login?error=rate_limited`);
  });

  it('consommation du lien (POST seulement) : cookie de session sécurisé et redirection vers l’onboarding', async () => {
    await requestLoginLink(deps, 'consume@example.com', { ip: '203.0.113.60' });
    const token = deps.mailer.messagesTo('consume@example.com').at(-1)!.text.match(/token=([\w-]+)/)![1]!;
    const r = await handleAuthConsume(deps, post('/auth/verify', form({ token })));
    expect(r.status).toBe(303);
    expect(r.headers.get('location')).toBe(`${APP}/app/onboarding`);
    const cookie = r.headers.get('set-cookie')!;
    expect(cookie).toContain('rk_session=');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Lax');
    const again = await handleAuthConsume(deps, post('/auth/verify', form({ token })));
    expect(again.headers.get('location')).toBe(`${APP}/login?error=link`);
    expect(again.headers.get('set-cookie')).toBeNull();
  });

  it('consommation : refuse une autre origine (CSRF)', async () => {
    const r = await handleAuthConsume(deps, post('/auth/verify', form({ token: 'x' }), { origin: 'https://evil.example' }));
    expect(r.status).toBe(403);
  });

  it('un tenant déjà configuré arrive sur le tableau de bord', async () => {
    const s = await login('deja@example.com');
    await db.pool.query(`update tenants set onboarding = '{"senderConfirmed":true,"nativeEmailsAcknowledged":true}'::jsonb, dry_run = false where id = $1`, [s.tenantId]);
    await db.pool.query(`insert into stripe_connections (tenant_id, stripe_account_id, status) values ($1,'acct_deja','ACTIVE')`, [s.tenantId]);
    await requestLoginLink(deps, 'deja@example.com', { ip: '203.0.113.61' });
    const token = deps.mailer.messagesTo('deja@example.com').at(-1)!.text.match(/token=([\w-]+)/)![1]!;
    const r = await handleAuthConsume(deps, post('/auth/verify', form({ token })));
    expect(r.headers.get('location')).toBe(`${APP}/app`);
  });

  it('déconnexion : révoque la session et efface le cookie', async () => {
    const s = await login('bye@example.com');
    const r = await handleLogout(deps, post('/api/auth/logout', '', { cookie: s.cookie }));
    expect(r.status).toBe(303);
    expect(r.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(await getSession(deps, s.token)).toBeNull();
    expect((await handleLogout(deps, post('/api/auth/logout', '', { cookie: s.cookie, origin: 'https://evil.example' }))).status).toBe(403);
  });
});

describe('connexion Stripe (OAuth)', () => {
  it('sans session : redirection vers la connexion', async () => {
    expect((await handleOauthStart(deps, get('/api/stripe/oauth/start'))).headers.get('location')).toBe(`${APP}/login`);
    expect((await handleOauthCallback(deps, get('/api/stripe/oauth/callback?code=x&state=y'))).headers.get('location')).toBe(`${APP}/login`);
  });

  it('parcours complet : démarrage puis callback', async () => {
    const s = await login('oauthweb@example.com');
    const start = await handleOauthStart(deps, get('/api/stripe/oauth/start', { cookie: s.cookie }));
    expect(start.status).toBe(302);
    const url = new URL(start.headers.get('location')!);
    expect(url.origin).toBe('https://connect.stripe.com');
    const state = url.searchParams.get('state')!;
    deps.stripe.setOAuthCode('code_web', { stripeUserId: 'acct_web1', livemode: false });
    const cb = await handleOauthCallback(deps, get(`/api/stripe/oauth/callback?code=code_web&state=${state}`, { cookie: s.cookie }));
    expect(cb.headers.get('location')).toBe(`${APP}/app/onboarding?stripe=connected`);
  });

  it.each([
    ['error=access_denied', 'denied'],
    ['code=c&state=inconnu', 'invalid'],
  ])('callback %s → ?stripe=%s', async (query, expected) => {
    const s = await login(`oauthweb-${expected}@example.com`);
    const start = await handleOauthStart(deps, get('/api/stripe/oauth/start', { cookie: s.cookie }));
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
    const q = query.includes('state') ? query : `${query}&state=${state}`;
    const cb = await handleOauthCallback(deps, get(`/api/stripe/oauth/callback?${q}`, { cookie: s.cookie }));
    expect(cb.headers.get('location')).toBe(`${APP}/app/onboarding?stripe=${expected}`);
  });
});

describe('page de paiement : création du SetupIntent', () => {
  async function withLink() {
    const t = await seedTenant(db.pool);
    await db.pool.query(`insert into stripe_connections (tenant_id, stripe_account_id, status) values ($1,$2,'ACTIVE')`, [t.id, `acct_p_${t.id.slice(0, 6)}`]);
    deps.stripe.addCustomer(`acct_p_${t.id.slice(0, 6)}`, { id: 'cus_pay', email: 'c@example.com', name: 'C', locale: 'fr', defaultPaymentMethodId: null });
    const c = await seedCase(db.pool, t.id, { customerId: 'cus_pay' });
    const token = tokenFromUrl(await ensurePaymentLink(deps, t.id, c.id));
    return { token, c, t };
  }
  const json = (path: string, headers: Record<string, string> = {}) =>
    new Request(`${APP}${path}`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json', origin: APP, 'x-forwarded-for': `192.0.2.${Math.floor(Math.random() * 250)}`, ...headers } });

  it('renvoie le secret du SetupIntent, jamais mis en cache', async () => {
    const { token } = await withLink();
    const r = await handlePaySetup(deps, json(`/api/pay/${token}/setup`), token);
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toContain('no-store');
    const body = await r.json();
    expect(body).toMatchObject({ clientSecret: expect.stringContaining('_secret_'), setupIntentId: expect.any(String), account: expect.stringMatching(/^acct_/) });
  });

  it('lien invalide : 404 neutre ; autre origine : 403 ; trop de requêtes : 429', async () => {
    const { token } = await withLink();
    expect((await handlePaySetup(deps, json('/api/pay/faux/setup'), 'faux')).status).toBe(404);
    expect((await handlePaySetup(deps, json(`/api/pay/${token}/setup`, { origin: 'https://evil.example' }), token)).status).toBe(403);
    let last = 200;
    for (let i = 0; i < 40; i++) last = (await handlePaySetup(deps, json(`/api/pay/${token}/setup`, { 'x-forwarded-for': '192.0.2.250' }), token)).status;
    expect(last).toBe(429);
  });
});

describe('désinscription', () => {
  async function target() {
    const t = await seedTenant(db.pool);
    const cust = await db.pool.query(`insert into end_customers (tenant_id, stripe_customer_id, email) values ($1,'cus_u','camille@example.com') returning id`, [t.id]);
    const c = await seedCase(db.pool, t.id, { customerId: 'cus_u' });
    await db.pool.query(`update recovery_cases set end_customer_id = $2 where id = $1`, [c.id, cust.rows[0].id]);
    await seedStep(db.pool, c.id, t.id);
    return { t, url: buildUnsubscribeUrl(deps, t.id, 'camille@example.com') };
  }

  it('POST depuis la page : désinscrit puis redirige', async () => {
    const { t, url } = await target();
    const u = new URL(url);
    const r = await handleUnsubscribe(deps, post(`/unsubscribe${u.search}`, ''));
    expect(r.status).toBe(303);
    expect(r.headers.get('location')).toBe(`${APP}/unsubscribe?done=1`);
    expect((await db.pool.query(`select 1 from suppressions where tenant_id = $1`, [t.id])).rowCount).toBe(1);
  });

  it('un clic en un geste du client de messagerie (List-Unsubscribe-Post) fonctionne sans origine', async () => {
    const { t, url } = await target();
    const u = new URL(url);
    const r = await handleUnsubscribe(deps, new Request(`${APP}/unsubscribe${u.search}`, { method: 'POST', body: 'List-Unsubscribe=One-Click', headers: { 'content-type': 'application/x-www-form-urlencoded' } }));
    expect(r.status).toBe(200);
    expect((await db.pool.query(`select 1 from suppressions where tenant_id = $1`, [t.id])).rowCount).toBe(1);
  });

  it('signature invalide : refus sans effet', async () => {
    const { t, url } = await target();
    const u = new URL(url);
    u.searchParams.set('s', 'faux');
    const r = await handleUnsubscribe(deps, post(`/unsubscribe${u.search}`, ''));
    expect(r.status).toBe(303);
    expect(r.headers.get('location')).toBe(`${APP}/unsubscribe?error=1`);
    expect((await db.pool.query(`select 1 from suppressions where tenant_id = $1`, [t.id])).rowCount).toBe(0);
  });
});

describe('exports', () => {
  it('CSV : session obligatoire, en-têtes de téléchargement, jamais de cache', async () => {
    expect((await handleExportRecovered(deps, get('/api/app/export/recovered?year=2026&month=10'))).status).toBe(401);
    const s = await login('export@example.com');
    const r = await handleExportRecovered(deps, get('/api/app/export/recovered?year=2026&month=10', { cookie: s.cookie }));
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(r.headers.get('content-disposition')).toBe('attachment; filename="recoverkit-recuperes-2026-10.csv"');
    expect(r.headers.get('cache-control')).toContain('no-store');
    const bytes = new Uint8Array(await r.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // BOM UTF-8 pour Excel
    expect(new TextDecoder('utf-8').decode(bytes.slice(3)).startsWith('Date;Client')).toBe(true);
  });

  it('CSV : paramètres invalides refusés', async () => {
    const s = await login('export2@example.com');
    expect((await handleExportRecovered(deps, get('/api/app/export/recovered?year=abc&month=13', { cookie: s.cookie }))).status).toBe(400);
  });

  it('export des données : JSON en pièce jointe, limité au tenant connecté', async () => {
    expect((await handleExportData(deps, get('/api/app/export/data'))).status).toBe(401);
    const s = await login('export3@example.com');
    await seedCase(db.pool, s.tenantId, { amountDue: 4242 });
    const other = await seedTenant(db.pool, { name: 'Autre tenant secret' });
    await seedCase(db.pool, other.id, { amountDue: 9999 });
    const r = await handleExportData(deps, get('/api/app/export/data', { cookie: s.cookie }));
    expect(r.status).toBe(200);
    expect(r.headers.get('content-disposition')).toContain('attachment; filename="recoverkit-donnees-');
    const text = await r.text();
    expect(text).toContain('4242');
    expect(text).not.toContain('Autre tenant secret');
    expect(text).not.toContain('9999');
  });
});

describe('santé', () => {
  it('/api/health : 200 si la base répond', async () => {
    const r = await handleHealth(deps);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ status: 'ok' });
  });

  it('/api/health : 503 si la base est indisponible', async () => {
    const broken = { ...deps, pool: { query: async () => { throw new Error('down'); } } } as unknown as TestDeps;
    expect((await handleHealth(broken)).status).toBe(503);
  });

  it('/api/health/details : réservé au jeton d’administration', async () => {
    const noToken = await handleHealthDetails(deps, get('/api/health/details'));
    expect(noToken.status).toBe(404); // non configuré : la route n'existe pas
    deps.config = { ...deps.config, adminToken: 'admin-secret-token' };
    expect((await handleHealthDetails(deps, get('/api/health/details'))).status).toBe(401);
    expect((await handleHealthDetails(deps, get('/api/health/details', { authorization: 'Bearer mauvais' }))).status).toBe(401);
    const ok = await handleHealthDetails(deps, get('/api/health/details', { authorization: 'Bearer admin-secret-token' }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ db: 'ok', inbox: expect.any(Object) });
    deps.config = { ...deps.config, adminToken: null };
  });
});
