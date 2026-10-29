import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestDb, seedTenant, signStripePayload, stripeEvent, type TestDb } from '@recoverkit/testkit';
import type { Plan } from '../src/config';
import { computeTenantMrr, enforceBilling, getBillingStatus, openPortal, receivePlatformWebhook, startCheckout } from '../src/billing/billing';
import { deleteTenant } from '../src/compliance/delete';
import { TEST_ENV, makeDeps, type TestDeps } from './helpers';
import { setupScenario } from './scenario';

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.dispose();
});

const PLANS: Plan[] = [
  { key: 'start', name: 'Départ', priceId: 'price_start', maxMrr: 500_000, monthlyPrice: 2900 },
  { key: 'growth', name: 'Croissance', priceId: 'price_growth', maxMrr: 2_000_000, monthlyPrice: 5900 },
  { key: 'scale', name: 'Échelle', priceId: 'price_scale', maxMrr: null, monthlyPrice: 12900 },
];
const NOW = new Date('2026-10-28T10:00:00Z');
const withPlans = (deps: TestDeps, plans = PLANS) => {
  deps.config = { ...deps.config, plans };
  return deps;
};
const tenantRow = async (id: string) => (await db.pool.query(`select status, created_at from tenants where id = $1`, [id])).rows[0];
const billingRow = async (id: string) => (await db.pool.query(`select * from billing_subscriptions where tenant_id = $1`, [id])).rows[0];

async function founder(name = 'Nimbus Notes') {
  const t = await seedTenant(db.pool, { name });
  await db.pool.query(`insert into users (tenant_id, email) values ($1, $2)`, [t.id, `f-${t.id.slice(0, 6)}@example.com`]);
  return t;
}
function platformEvent(deps: TestDeps, type: string, object: Record<string, unknown>, id?: string, secret = TEST_ENV.STRIPE_PLATFORM_WEBHOOK_SECRET, created?: Date) {
  const evt = stripeEvent(type, object, { account: null, id, created: created ?? deps.clock.now() });
  const raw = JSON.stringify(evt);
  return receivePlatformWebhook(deps, { rawBody: raw, signature: signStripePayload(raw, secret, deps.clock.now()) });
}

describe('souscription : checkout et portail', () => {
  it('crée le client une seule fois et renvoie la session Checkout du palier choisi', async () => {
    const deps = withPlans(makeDeps(db, NOW));
    const t = await founder();
    const a = await startCheckout(deps, t.id, 'growth');
    expect(a).toMatchObject({ status: 'ok' });
    if (a.status !== 'ok') return;
    expect(a.url).toContain('price_growth');
    const customer = (await billingRow(t.id)).stripe_customer_id;
    expect(customer).toMatch(/^cus_fake_/);
    await startCheckout(deps, t.id, 'start');
    expect((await billingRow(t.id)).stripe_customer_id).toBe(customer);
  });

  it('refuse un palier inconnu ; facturation désactivée sans paliers configurés', async () => {
    const deps = withPlans(makeDeps(db, NOW));
    const t = await founder();
    expect(await startCheckout(deps, t.id, 'inconnu')).toEqual({ status: 'invalid_plan' });
    expect(await startCheckout(withPlans(makeDeps(db, NOW), []), t.id, 'growth')).toEqual({ status: 'billing_disabled' });
  });

  it('portail client : uniquement si un client Stripe existe', async () => {
    const deps = withPlans(makeDeps(db, NOW));
    const t = await founder();
    expect(await openPortal(deps, t.id)).toEqual({ status: 'no_customer' });
    await startCheckout(deps, t.id, 'start');
    const r = await openPortal(deps, t.id);
    expect(r.status).toBe('ok');
  });
});

describe('webhooks de la plateforme', () => {
  async function subscribed(deps: TestDeps, o: { price?: string; status?: string } = {}) {
    const t = await founder();
    await startCheckout(deps, t.id, 'growth');
    const customer = (await billingRow(t.id)).stripe_customer_id as string;
    return { t, customer, sub: `sub_${t.id.slice(0, 8)}`, price: o.price ?? 'price_growth' };
  }

  it('signature invalide : refus', async () => {
    const deps = withPlans(makeDeps(db, NOW));
    expect(await platformEvent(deps, 'invoice.paid', {}, 'evt_pl_bad', 'whsec_autre')).toEqual({ status: 'rejected', httpStatus: 400 });
  });

  it('checkout.session.completed relie l’abonnement au tenant et lit son état chez Stripe', async () => {
    const deps = withPlans(makeDeps(db, NOW));
    const { t, customer, sub } = await subscribed(deps);
    deps.billing.addSubscription({ id: sub, customerId: customer, status: 'trialing', priceId: 'price_growth', currentPeriodEnd: new Date('2026-11-10T00:00:00Z'), cancelAtPeriodEnd: false });
    const r = await platformEvent(deps, 'checkout.session.completed', { id: 'cs_1', customer, subscription: sub, client_reference_id: t.id });
    expect(r).toEqual({ status: 'processed', httpStatus: 200 });
    expect(await billingRow(t.id)).toMatchObject({ stripe_subscription_id: sub, status: 'TRIALING', plan: 'growth' });
  });

  it('le même événement rejoué est ignoré', async () => {
    const deps = withPlans(makeDeps(db, NOW));
    const { t, customer, sub } = await subscribed(deps);
    deps.billing.addSubscription({ id: sub, customerId: customer, status: 'active', priceId: 'price_growth', currentPeriodEnd: null, cancelAtPeriodEnd: false });
    const obj = { id: 'cs_2', customer, subscription: sub, client_reference_id: t.id };
    expect((await platformEvent(deps, 'checkout.session.completed', obj, 'evt_pl_same')).status).toBe('processed');
    expect((await platformEvent(deps, 'checkout.session.completed', obj, 'evt_pl_same')).status).toBe('duplicate');
  });

  it.each([
    ['trialing', 'TRIALING'],
    ['active', 'ACTIVE'],
    ['past_due', 'PAST_DUE'],
    ['unpaid', 'PAST_DUE'],
    ['canceled', 'CANCELED'],
  ])('customer.subscription.updated : %s → %s', async (stripeStatus, expected) => {
    const deps = withPlans(makeDeps(db, NOW));
    const { t, customer, sub } = await subscribed(deps);
    await platformEvent(deps, 'customer.subscription.updated', {
      id: sub, customer, status: stripeStatus, cancel_at_period_end: true,
      items: { data: [{ price: { id: 'price_scale' }, current_period_end: 1795000000 }] },
    });
    const row = await billingRow(t.id);
    expect(row).toMatchObject({ status: expected, plan: 'scale', cancel_at_period_end: true, stripe_subscription_id: sub });
    expect(new Date(row.current_period_end).getTime()).toBe(1795000000 * 1000);
  });

  it('customer.subscription.deleted : CANCELED', async () => {
    const deps = withPlans(makeDeps(db, NOW));
    const { t, customer, sub } = await subscribed(deps);
    await platformEvent(deps, 'customer.subscription.deleted', { id: sub, customer, status: 'canceled', items: { data: [] } });
    expect((await billingRow(t.id)).status).toBe('CANCELED');
  });

  it('échec de paiement du fondateur : PAST_DUE, date de début, alerte critique ; paiement : tout est résolu', async () => {
    const deps = withPlans(makeDeps(db, NOW));
    const { t, customer, sub } = await subscribed(deps);
    await platformEvent(deps, 'customer.subscription.updated', { id: sub, customer, status: 'active', items: { data: [{ price: { id: 'price_growth' }, current_period_end: 1795000000 }] } });
    await platformEvent(deps, 'invoice.payment_failed', { id: 'in_pl_1', customer, subscription: sub });
    let row = await billingRow(t.id);
    expect(row.status).toBe('PAST_DUE');
    expect(new Date(row.past_due_since).toISOString()).toBe(NOW.toISOString());
    expect((await db.pool.query(`select kind from system_alerts where tenant_id = $1 and resolved_at is null`, [t.id])).rows.map((r) => r.kind)).toContain('billing_past_due');

    deps.clock.advance({ days: 2 });
    await platformEvent(deps, 'invoice.payment_failed', { id: 'in_pl_1', customer, subscription: sub }); // 2e échec : la date de début ne bouge pas
    expect(new Date((await billingRow(t.id)).past_due_since).toISOString()).toBe(NOW.toISOString());

    await platformEvent(deps, 'invoice.paid', { id: 'in_pl_1', customer, subscription: sub });
    row = await billingRow(t.id);
    expect(row.status).toBe('ACTIVE');
    expect(row.past_due_since).toBeNull();
    expect((await db.pool.query(`select count(*)::int n from system_alerts where tenant_id = $1 and kind = 'billing_past_due' and resolved_at is null`, [t.id])).rows[0].n).toBe(0);
  });

  const at = (sec: number) => new Date(NOW.getTime() + sec * 1000);
  const subObj = (sub: string, customer: string, status: string) => ({ id: sub, customer, status, items: { data: [{ price: { id: 'price_growth' }, current_period_end: 1795000000 }] } });

  it('un évènement plus ancien arrivé en retard n’écrase pas un évènement plus récent', async () => {
    const deps = withPlans(makeDeps(db, NOW));
    const { t, customer, sub } = await subscribed(deps);
    const secret = TEST_ENV.STRIPE_PLATFORM_WEBHOOK_SECRET;
    await platformEvent(deps, 'customer.subscription.deleted', subObj(sub, customer, 'canceled'), 'evt_ord_del', secret, at(20));
    await platformEvent(deps, 'customer.subscription.updated', subObj(sub, customer, 'active'), 'evt_ord_upd', secret, at(10));
    expect((await billingRow(t.id)).status).toBe('CANCELED');
  });

  it('un invoice.payment_failed tardif ne remet pas PAST_DUE sur un abonnement redevenu actif', async () => {
    const deps = withPlans(makeDeps(db, NOW));
    const { t, customer, sub } = await subscribed(deps);
    const secret = TEST_ENV.STRIPE_PLATFORM_WEBHOOK_SECRET;
    await platformEvent(deps, 'customer.subscription.updated', subObj(sub, customer, 'active'), 'evt_ord_a', secret, at(20));
    await platformEvent(deps, 'invoice.payment_failed', { id: 'in_late', customer, subscription: sub }, 'evt_ord_pf', secret, at(10));
    const row = await billingRow(t.id);
    expect(row.status).toBe('ACTIVE');
    expect(row.past_due_since).toBeNull();
  });

  it('un évènement d’un autre abonnement que l’abonnement courant est ignoré', async () => {
    const deps = withPlans(makeDeps(db, NOW));
    const { t, customer, sub } = await subscribed(deps);
    deps.billing.addSubscription({ id: sub, customerId: customer, status: 'active', priceId: 'price_growth', currentPeriodEnd: new Date('2026-11-10T00:00:00Z'), cancelAtPeriodEnd: false });
    await platformEvent(deps, 'checkout.session.completed', { id: 'cs_b', customer, subscription: sub, client_reference_id: t.id });
    await platformEvent(deps, 'customer.subscription.deleted', { id: 'sub_ancien_A', customer, status: 'canceled', items: { data: [] } });
    expect(await billingRow(t.id)).toMatchObject({ status: 'ACTIVE', stripe_subscription_id: sub });
  });

  it('startCheckout redirige vers le portail si un abonnement actif ou en essai existe', async () => {
    const deps = withPlans(makeDeps(db, NOW));
    const t = await founder();
    await db.pool.query(`insert into billing_subscriptions (tenant_id, stripe_customer_id, stripe_subscription_id, status, plan) values ($1,'cus_dup','sub_dup','ACTIVE','start')`, [t.id]);
    const r = await startCheckout(deps, t.id, 'growth');
    expect(r).toMatchObject({ status: 'ok' });
    if (r.status === 'ok') expect(r.url).toContain('fake-portal');
  });

  it('startCheckout redirige aussi vers le portail si l\'abonnement est PAST_DUE (pas de second abonnement)', async () => {
    const deps = withPlans(makeDeps(db, NOW));
    const t = await founder();
    await db.pool.query(`insert into billing_subscriptions (tenant_id, stripe_customer_id, stripe_subscription_id, status, plan, past_due_since) values ($1,'cus_pd','sub_pd','PAST_DUE','start',$2)`, [t.id, NOW]);
    const r = await startCheckout(deps, t.id, 'growth');
    expect(r).toMatchObject({ status: 'ok' });
    if (r.status === 'ok') expect(r.url).toContain('fake-portal');
  });

  it('client Stripe inconnu : ignoré sans erreur', async () => {
    const deps = withPlans(makeDeps(db, NOW));
    expect((await platformEvent(deps, 'invoice.paid', { customer: 'cus_inconnu' })).httpStatus).toBe(200);
  });
});

describe('revenu mensuel et paliers', () => {
  async function withSubs(deps: TestDeps, subs: { amount: number; interval?: 'month' | 'year'; status?: string }[], plan: string | null) {
    const t = await founder();
    const account = `acct_${t.id.slice(0, 8)}`;
    await db.pool.query(`insert into stripe_connections (tenant_id, stripe_account_id, status) values ($1,$2,'ACTIVE')`, [t.id, account]);
    subs.forEach((s, i) => deps.stripe.addSubscription(account, { id: `sub_${t.id.slice(0, 6)}_${i}`, customerId: 'cus', status: s.status ?? 'active', planName: null, amount: s.amount, currency: 'EUR', interval: s.interval ?? 'month' }));
    if (plan) await db.pool.query(`insert into billing_subscriptions (tenant_id, plan, status) values ($1,$2,'ACTIVE')`, [t.id, plan]);
    return t;
  }

  it('additionne les abonnements actifs ramenés au mois et propose le palier adapté', async () => {
    const deps = withPlans(makeDeps(db, NOW));
    const t = await withSubs(deps, [{ amount: 290000 }, { amount: 29000, interval: 'year' }, { amount: 5000, status: 'canceled' }], 'growth');
    const r = await computeTenantMrr(deps, t.id);
    expect(r).toMatchObject({ mrr: 290000 + 2417, currency: 'EUR', suggestedPlan: 'start', exceeded: false });
    expect(await billingRow(t.id)).toMatchObject({ mrr_amount: 292417, mrr_currency: 'EUR' });
  });

  it('dépassement du palier : alerte (sans blocage) puis résolue quand le revenu redescend', async () => {
    const deps = withPlans(makeDeps(db, NOW));
    const t = await withSubs(deps, [{ amount: 600_000 }], 'start');
    const r = await computeTenantMrr(deps, t.id);
    expect(r).toMatchObject({ exceeded: true, suggestedPlan: 'growth' });
    await computeTenantMrr(deps, t.id);
    const open = await db.pool.query(`select kind, message from system_alerts where tenant_id = $1 and kind = 'plan_exceeded' and resolved_at is null`, [t.id]);
    expect(open.rows).toHaveLength(1);
    expect(open.rows[0].message).toContain('Croissance');
    expect((await tenantRow(t.id)).status).toBe('ACTIVE'); // jamais de blocage

    const account = (await db.pool.query(`select stripe_account_id from stripe_connections where tenant_id = $1`, [t.id])).rows[0].stripe_account_id;
    deps.stripe.addSubscription(account, { id: `sub_${t.id.slice(0, 6)}_0`, customerId: 'cus', status: 'active', planName: null, amount: 100_000, currency: 'EUR', interval: 'month' });
    await computeTenantMrr(deps, t.id);
    expect((await db.pool.query(`select count(*)::int n from system_alerts where tenant_id = $1 and kind = 'plan_exceeded' and resolved_at is null`, [t.id])).rows[0].n).toBe(0);
  });

  it('compare les devises en valeur majeure (KWD à 3 décimales vs EUR) et les paliers dans leur devise', async () => {
    const deps = withPlans(makeDeps(db, NOW));
    const t = await founder();
    const account = `acct_${t.id.slice(0, 8)}`;
    await db.pool.query(`insert into stripe_connections (tenant_id, stripe_account_id, status) values ($1,$2,'ACTIVE')`, [t.id, account]);
    // 100 000 unités KWD = 100 KWD (~300 EUR) ; 50 000 centimes EUR = 500 EUR : l'EUR domine
    deps.stripe.addSubscription(account, { id: 'sub_k1', customerId: 'c', status: 'active', planName: null, amount: 100_000, currency: 'KWD', interval: 'month' });
    deps.stripe.addSubscription(account, { id: 'sub_e1', customerId: 'c', status: 'active', planName: null, amount: 50_000, currency: 'EUR', interval: 'month' });
    const r = await computeTenantMrr(deps, t.id);
    expect(r).toMatchObject({ status: 'ok', mrr: 50_000, currency: 'EUR', suggestedPlan: 'start', exceeded: false });
  });

  it('un MRR dans une devise autre que celle des paliers ne déclenche pas de dépassement', async () => {
    const deps = withPlans(makeDeps(db, NOW));
    const t = await founder();
    const account = `acct_${t.id.slice(0, 8)}`;
    await db.pool.query(`insert into stripe_connections (tenant_id, stripe_account_id, status) values ($1,$2,'ACTIVE')`, [t.id, account]);
    await db.pool.query(`insert into billing_subscriptions (tenant_id, plan, status) values ($1,'start','ACTIVE')`, [t.id]);
    // 900 000 JPY (0 décimale) = 900 000 en unités mineures brutes > maxMrr 500 000, mais ce ne sont pas des euros
    deps.stripe.addSubscription(account, { id: 'sub_j1', customerId: 'c', status: 'active', planName: null, amount: 900_000, currency: 'JPY', interval: 'month' });
    const r = await computeTenantMrr(deps, t.id);
    expect(r).toMatchObject({ status: 'ok', mrr: 0, currency: 'EUR', exceeded: false, suggestedPlan: 'start', ignoredCurrencies: ['JPY'], byCurrency: { JPY: 900_000 } });
    expect(await billingRow(t.id)).toMatchObject({ mrr_amount: 0, mrr_currency: 'EUR' });
  });

  it('les paliers peuvent être dans une autre devise (champ currency) : le MRR de cette devise compte', async () => {
    const usdPlans: Plan[] = PLANS.map((p) => ({ ...p, currency: 'USD' }));
    const deps = withPlans(makeDeps(db, NOW), usdPlans);
    const t = await founder();
    const account = `acct_${t.id.slice(0, 8)}`;
    await db.pool.query(`insert into stripe_connections (tenant_id, stripe_account_id, status) values ($1,$2,'ACTIVE')`, [t.id, account]);
    await db.pool.query(`insert into billing_subscriptions (tenant_id, plan, status) values ($1,'start','ACTIVE')`, [t.id]);
    deps.stripe.addSubscription(account, { id: 'sub_u1', customerId: 'c', status: 'active', planName: null, amount: 600_000, currency: 'USD', interval: 'month' });
    deps.stripe.addSubscription(account, { id: 'sub_e9', customerId: 'c', status: 'active', planName: null, amount: 100, currency: 'EUR', interval: 'month' });
    const r = await computeTenantMrr(deps, t.id);
    expect(r).toMatchObject({ status: 'ok', mrr: 600_000, currency: 'USD', exceeded: true, suggestedPlan: 'growth', ignoredCurrencies: ['EUR'] });
  });

  it('multi-devises : MRR stocké et renvoyé dans la devise des paliers (100 EUR + 150 USD)', async () => {
    const deps = withPlans(makeDeps(db, NOW));
    const t = await founder();
    const account = `acct_${t.id.slice(0, 8)}`;
    await db.pool.query(`insert into stripe_connections (tenant_id, stripe_account_id, status) values ($1,$2,'ACTIVE')`, [t.id, account]);
    deps.stripe.addSubscription(account, { id: 'sub_m1', customerId: 'c', status: 'active', planName: null, amount: 10_000, currency: 'EUR', interval: 'month' });
    deps.stripe.addSubscription(account, { id: 'sub_m2', customerId: 'c', status: 'active', planName: null, amount: 15_000, currency: 'USD', interval: 'month' });
    const r = await computeTenantMrr(deps, t.id);
    expect(r).toMatchObject({ status: 'ok', mrr: 10_000, currency: 'EUR', ignoredCurrencies: ['USD'], byCurrency: { EUR: 10_000, USD: 15_000 } });
    expect(await billingRow(t.id)).toMatchObject({ mrr_amount: 10_000, mrr_currency: 'EUR' });
    expect((await getBillingStatus(deps, t.id)).mrr).toEqual({ amount: 10_000, currency: 'EUR' });
  });

  it('devise principale : ISK/UGX sont comptées en centièmes par Stripe (currencyDigits de core)', async () => {
    const deps = withPlans(makeDeps(db, NOW));
    const t = await founder();
    const account = `acct_${t.id.slice(0, 8)}`;
    await db.pool.query(`insert into stripe_connections (tenant_id, stripe_account_id, status) values ($1,$2,'ACTIVE')`, [t.id, account]);
    // 10 000 unités ISK = 100 ISK (~1 EUR) ; 50 000 centimes EUR = 500 EUR : l'EUR domine
    deps.stripe.addSubscription(account, { id: 'sub_i1', customerId: 'c', status: 'active', planName: null, amount: 10_000, currency: 'ISK', interval: 'month' });
    deps.stripe.addSubscription(account, { id: 'sub_e2', customerId: 'c', status: 'active', planName: null, amount: 50_000, currency: 'EUR', interval: 'month' });
    expect(await computeTenantMrr(deps, t.id)).toMatchObject({ status: 'ok', mrr: 50_000, currency: 'EUR' });
  });

  it('sans connexion Stripe : rien à calculer', async () => {
    const deps = withPlans(makeDeps(db, NOW));
    const t = await founder();
    expect(await computeTenantMrr(deps, t.id)).toEqual({ status: 'no_connection' });
  });
});

describe('application de la facturation', () => {
  async function tenantAt(createdDaysAgo: number, billing?: { status: string; pastDueDaysAgo?: number; periodEndDays?: number }) {
    const t = await founder();
    await db.pool.query(`update tenants set created_at = $2 where id = $1`, [t.id, new Date(NOW.getTime() - createdDaysAgo * 86400_000)]);
    if (billing) {
      await db.pool.query(
        `insert into billing_subscriptions (tenant_id, status, plan, past_due_since, current_period_end) values ($1,$2,'start',$3,$4)`,
        [t.id, billing.status, billing.pastDueDaysAgo !== undefined ? new Date(NOW.getTime() - billing.pastDueDaysAgo * 86400_000) : null, billing.periodEndDays !== undefined ? new Date(NOW.getTime() + billing.periodEndDays * 86400_000) : null],
      );
    }
    return t;
  }

  it('ne fait rien sans paliers configurés (auto-hébergement, développement)', async () => {
    const deps = withPlans(makeDeps(db, NOW), []);
    const t = await tenantAt(400);
    expect(await enforceBilling(deps)).toEqual({ suspended: 0, reactivated: 0 });
    expect((await tenantRow(t.id)).status).toBe('ACTIVE');
  });

  it('essai de 14 jours : actif pendant, suspendu après sans abonnement', async () => {
    const deps = withPlans(makeDeps(db, NOW));
    const inTrial = await tenantAt(5);
    const ended = await tenantAt(20);
    await enforceBilling(deps);
    expect((await tenantRow(inTrial.id)).status).toBe('ACTIVE');
    expect((await tenantRow(ended.id)).status).toBe('SUSPENDED');
  });

  it('un abonnement actif réactive un tenant suspendu', async () => {
    const deps = withPlans(makeDeps(db, NOW));
    const t = await tenantAt(40);
    await enforceBilling(deps);
    expect((await tenantRow(t.id)).status).toBe('SUSPENDED');
    await db.pool.query(`insert into billing_subscriptions (tenant_id, status, plan) values ($1,'ACTIVE','start')`, [t.id]);
    expect(await enforceBilling(deps)).toMatchObject({ reactivated: 1 });
    expect((await tenantRow(t.id)).status).toBe('ACTIVE');
  });

  it('la réactivation lance une réconciliation Stripe sans bloquer ni échouer, même si Stripe est en panne', async () => {
    const deps = withPlans(makeDeps(db, NOW));
    const s = await setupScenario(db, deps);
    await db.pool.query(`update tenants set status = 'SUSPENDED', created_at = $2 where id = $1`, [s.tenantId, new Date(NOW.getTime() - 40 * 86400_000)]);
    await db.pool.query(`insert into billing_subscriptions (tenant_id, status, plan) values ($1,'ACTIVE','start')`, [s.tenantId]);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const original = deps.stripe.listOpenInvoices.bind(deps.stripe);
    deps.stripe.listOpenInvoices = async (account: string) => {
      await gate; // Stripe lent : enforceBilling ne doit pas l'attendre
      return original(account);
    };
    expect(await enforceBilling(deps)).toMatchObject({ reactivated: 1 });
    release();
    await vi.waitFor(async () => {
      expect((await db.pool.query(`select count(*)::int n from inbox_events where tenant_id = $1`, [s.tenantId])).rows[0].n).toBe(1);
    });

    const s2 = await setupScenario(db, deps);
    await db.pool.query(`update tenants set status = 'SUSPENDED', created_at = $2 where id = $1`, [s2.tenantId, new Date(NOW.getTime() - 40 * 86400_000)]);
    await db.pool.query(`insert into billing_subscriptions (tenant_id, status, plan) values ($1,'ACTIVE','start')`, [s2.tenantId]);
    deps.stripe.listOpenInvoices = async () => {
      throw new Error('Stripe indisponible');
    };
    await expect(enforceBilling(deps)).resolves.toMatchObject({ reactivated: expect.any(Number) });
    expect((await tenantRow(s2.tenantId)).status).toBe('ACTIVE');
  });

  it('impayé : délai de grâce de 7 jours, puis suspension douce', async () => {
    const deps = withPlans(makeDeps(db, NOW));
    const grace = await tenantAt(60, { status: 'PAST_DUE', pastDueDaysAgo: 3 });
    const over = await tenantAt(60, { status: 'PAST_DUE', pastDueDaysAgo: 8 });
    await enforceBilling(deps);
    expect((await tenantRow(grace.id)).status).toBe('ACTIVE');
    expect((await tenantRow(over.id)).status).toBe('SUSPENDED');
  });

  it('annulation : actif jusqu’à la fin de la période payée, puis suspendu', async () => {
    const deps = withPlans(makeDeps(db, NOW));
    const running = await tenantAt(60, { status: 'CANCELED', periodEndDays: 5 });
    const done = await tenantAt(60, { status: 'CANCELED', periodEndDays: -1 });
    await enforceBilling(deps);
    expect((await tenantRow(running.id)).status).toBe('ACTIVE');
    expect((await tenantRow(done.id)).status).toBe('SUSPENDED');
  });

  it('un tenant suspendu n’envoie plus rien et ses webhooks sont ignorés', async () => {
    const deps = withPlans(makeDeps(db, NOW));
    const t = await tenantAt(60);
    await db.pool.query(`insert into sequences (tenant_id, version, steps) values ($1,1,'[]'::jsonb)`, [t.id]);
    await enforceBilling(deps);
    const { reserveDueSteps } = await import('@recoverkit/db');
    const { seedCase, seedStep } = await import('@recoverkit/testkit');
    const c = await seedCase(db.pool, t.id);
    await seedStep(db.pool, c.id, t.id, { dueAt: new Date('2026-10-28T08:00:00Z') });
    expect(await reserveDueSteps(db.pool, NOW, 10, { tenantId: t.id })).toHaveLength(0);
  });
});

describe('état de facturation et suppression du compte', () => {
  it('résume l’état pour l’écran de facturation', async () => {
    const deps = withPlans(makeDeps(db, NOW));
    const t = await founder();
    await db.pool.query(`update tenants set created_at = $2 where id = $1`, [t.id, new Date(NOW.getTime() - 5 * 86400_000)]);
    let s = await getBillingStatus(deps, t.id);
    expect(s).toMatchObject({ state: 'TRIALING', plan: null, enabled: true });
    expect(s.trialEndsAt!.toISOString()).toBe(new Date(NOW.getTime() + 9 * 86400_000).toISOString());

    await db.pool.query(`update tenants set created_at = $2 where id = $1`, [t.id, new Date(NOW.getTime() - 30 * 86400_000)]);
    expect((await getBillingStatus(deps, t.id)).state).toBe('TRIAL_ENDED');

    await db.pool.query(`insert into billing_subscriptions (tenant_id, status, plan, cancel_at_period_end, current_period_end) values ($1,'ACTIVE','growth',true,$2)`, [t.id, new Date('2026-11-15T00:00:00Z')]);
    s = await getBillingStatus(deps, t.id);
    expect(s).toMatchObject({ state: 'ACTIVE', plan: 'growth', cancelAtPeriodEnd: true });
    expect(await getBillingStatus(withPlans(makeDeps(db, NOW), []), t.id)).toMatchObject({ enabled: false });
  });

  it('la suppression du compte annule l’abonnement RecoverKit', async () => {
    const deps = withPlans(makeDeps(db, NOW));
    const t = await founder('À résilier');
    await db.pool.query(`insert into billing_subscriptions (tenant_id, stripe_customer_id, stripe_subscription_id, status, plan) values ($1,'cus_z','sub_to_cancel','ACTIVE','start')`, [t.id]);
    expect(await deleteTenant(deps, t.id, { confirmName: 'À résilier', actor: 'user:u' })).toEqual({ status: 'deleted' });
    expect(deps.billing.canceled).toContain('sub_to_cancel');
  });
});
