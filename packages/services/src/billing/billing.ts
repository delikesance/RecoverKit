import { monthlyAmount, planForMrr } from '@recoverkit/core';
import { logAction, withTransaction } from '@recoverkit/db';
import type { Deps } from '../deps';
import { raiseAlert } from '../recovery/ops';
import { verifyStripeSignature } from '../webhooks/signature';

const DAY = 86400_000;

export type BillingState = 'TRIALING' | 'TRIAL_ENDED' | 'ACTIVE' | 'PAST_DUE' | 'CANCELED';

export function mapSubscriptionStatus(status: string): 'TRIALING' | 'ACTIVE' | 'PAST_DUE' | 'CANCELED' {
  switch (status) {
    case 'trialing':
      return 'TRIALING';
    case 'active':
      return 'ACTIVE';
    case 'past_due':
    case 'unpaid':
      return 'PAST_DUE';
    default:
      return 'CANCELED';
  }
}

async function ensureCustomer(deps: Deps, tenantId: string): Promise<string> {
  const existing = await deps.pool.query(`select stripe_customer_id from billing_subscriptions where tenant_id = $1`, [tenantId]);
  if (existing.rows[0]?.stripe_customer_id) return existing.rows[0].stripe_customer_id;
  const owner = (await deps.pool.query(`select t.name, u.email from tenants t join users u on u.tenant_id = t.id where t.id = $1`, [tenantId])).rows[0];
  if (!owner) throw new Error('Tenant introuvable');
  const customer = await deps.billing.createCustomer({ email: owner.email, name: owner.name, tenantId });
  await deps.pool.query(
    `insert into billing_subscriptions (tenant_id, stripe_customer_id, status) values ($1, $2, 'NONE')
     on conflict (tenant_id) do update set stripe_customer_id = coalesce(billing_subscriptions.stripe_customer_id, excluded.stripe_customer_id)`,
    [tenantId, customer.id],
  );
  return (await deps.pool.query(`select stripe_customer_id from billing_subscriptions where tenant_id = $1`, [tenantId])).rows[0].stripe_customer_id;
}

export async function startCheckout(
  deps: Deps,
  tenantId: string,
  planKey: string,
): Promise<{ status: 'ok'; url: string } | { status: 'invalid_plan' | 'billing_disabled' }> {
  if (deps.config.plans.length === 0) return { status: 'billing_disabled' };
  const plan = deps.config.plans.find((p) => p.key === planKey);
  if (!plan) return { status: 'invalid_plan' };
  const customerId = await ensureCustomer(deps, tenantId);

  // L'essai gratuit déjà entamé n'est pas perdu : il est reporté sur l'abonnement.
  const created = (await deps.pool.query(`select created_at from tenants where id = $1`, [tenantId])).rows[0].created_at as Date;
  const remaining = Math.ceil((new Date(created).getTime() + deps.config.trialDays * DAY - deps.clock.now().getTime()) / DAY);
  const session = await deps.billing.createCheckoutSession({
    customerId,
    priceId: plan.priceId,
    tenantId,
    successUrl: `${deps.config.appUrl}/app/billing?status=success`,
    cancelUrl: `${deps.config.appUrl}/app/billing?status=canceled`,
    ...(remaining > 0 ? { trialDays: remaining } : {}),
  });
  return { status: 'ok', url: session.url };
}

export async function openPortal(deps: Deps, tenantId: string): Promise<{ status: 'ok'; url: string } | { status: 'no_customer' }> {
  const row = (await deps.pool.query(`select stripe_customer_id from billing_subscriptions where tenant_id = $1`, [tenantId])).rows[0];
  if (!row?.stripe_customer_id) return { status: 'no_customer' };
  const s = await deps.billing.createPortalSession({ customerId: row.stripe_customer_id, returnUrl: `${deps.config.appUrl}/app/billing` });
  return { status: 'ok', url: s.url };
}

export type PlatformResult =
  | { status: 'processed' | 'duplicate'; httpStatus: 200 }
  | { status: 'rejected'; httpStatus: 400 };

async function tenantOfCustomer(deps: Deps, customerId: string | null | undefined): Promise<string | null> {
  if (!customerId) return null;
  const res = await deps.pool.query(`select tenant_id from billing_subscriptions where stripe_customer_id = $1`, [customerId]);
  return res.rows[0]?.tenant_id ?? null;
}

const idOf = (v: any): string | null => (typeof v === 'string' ? v : (v?.id ?? null));

/** Webhooks du compte plateforme (facturation de RecoverKit), distincts des webhooks Connect. */
export async function receivePlatformWebhook(deps: Deps, req: { rawBody: string; signature: string | null }): Promise<PlatformResult> {
  const check = verifyStripeSignature(req.rawBody, req.signature, deps.config.stripePlatformWebhookSecret, deps.clock.now());
  if (!check.ok) return { status: 'rejected', httpStatus: 400 };
  let event: any;
  try {
    event = JSON.parse(req.rawBody);
  } catch {
    return { status: 'rejected', httpStatus: 400 };
  }
  if (!event?.id || !event?.type) return { status: 'rejected', httpStatus: 400 };
  const now = deps.clock.now();

  return withTransaction(deps.pool, async (tx): Promise<PlatformResult> => {
    const fresh = await tx.query(`insert into provider_events (id, received_at) values ($1,$2) on conflict do nothing returning id`, [`stripe_platform:${event.id}`, now]);
    if (fresh.rowCount !== 1) return { status: 'duplicate', httpStatus: 200 };
    const obj = event.data?.object ?? {};
    const planOf = (priceId: string | null) => deps.config.plans.find((p) => p.priceId === priceId)?.key ?? null;

    switch (event.type) {
      case 'checkout.session.completed': {
        const tenantId: string | null = obj.client_reference_id ?? (await tenantOfCustomer(deps, idOf(obj.customer)));
        const subId = idOf(obj.subscription);
        if (!tenantId || !subId) break;
        const sub = await deps.billing.retrieveSubscription(subId);
        await tx.query(
          `insert into billing_subscriptions (tenant_id, stripe_customer_id, stripe_subscription_id, plan, status, current_period_end, cancel_at_period_end, updated_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8)
           on conflict (tenant_id) do update set stripe_customer_id = excluded.stripe_customer_id, stripe_subscription_id = excluded.stripe_subscription_id,
             plan = excluded.plan, status = excluded.status, current_period_end = excluded.current_period_end,
             cancel_at_period_end = excluded.cancel_at_period_end, updated_at = excluded.updated_at`,
          [tenantId, sub.customerId, sub.id, planOf(sub.priceId), mapSubscriptionStatus(sub.status), sub.currentPeriodEnd, sub.cancelAtPeriodEnd, now],
        );
        await logAction(tx, { tenantId, caseId: null, actor: 'billing', action: 'billing.subscribed', details: { plan: planOf(sub.priceId) } });
        break;
      }
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        const tenantId = (await tenantOfCustomer(deps, idOf(obj.customer))) ?? obj.metadata?.tenant_id ?? null;
        if (!tenantId) break;
        const item = obj.items?.data?.[0];
        const status = event.type === 'customer.subscription.deleted' ? 'CANCELED' : mapSubscriptionStatus(obj.status);
        const periodEnd = item?.current_period_end ?? obj.current_period_end ?? null;
        await tx.query(
          `update billing_subscriptions set stripe_subscription_id = $2, status = $3, plan = coalesce($4, plan),
             current_period_end = coalesce($5, current_period_end), cancel_at_period_end = $6,
             past_due_since = case when $3 = 'PAST_DUE' then coalesce(past_due_since, $7) else null end, updated_at = $7
           where tenant_id = $1`,
          [tenantId, obj.id, status, planOf(item?.price?.id ?? null), periodEnd ? new Date(periodEnd * 1000) : null, !!obj.cancel_at_period_end, now],
        );
        if (status !== 'PAST_DUE') {
          await tx.query(`update system_alerts set resolved_at = $2 where tenant_id = $1 and kind = 'billing_past_due' and resolved_at is null`, [tenantId, now]);
        }
        break;
      }
      case 'invoice.payment_failed': {
        const tenantId = await tenantOfCustomer(deps, idOf(obj.customer));
        if (!tenantId) break;
        await tx.query(
          `update billing_subscriptions set status = 'PAST_DUE', past_due_since = coalesce(past_due_since, $2), updated_at = $2 where tenant_id = $1`,
          [tenantId, now],
        );
        await raiseAlert(tx, {
          tenantId,
          kind: 'billing_past_due',
          dedupeKey: `billing_past_due:${tenantId}`,
          message: `Le paiement de votre abonnement RecoverKit a échoué. Mettez à jour votre carte pour éviter la suspension des relances.`,
        });
        break;
      }
      case 'invoice.paid': {
        const tenantId = await tenantOfCustomer(deps, idOf(obj.customer));
        if (!tenantId) break;
        await tx.query(
          `update billing_subscriptions set past_due_since = null, status = case when status = 'PAST_DUE' then 'ACTIVE' else status end, updated_at = $2 where tenant_id = $1`,
          [tenantId, now],
        );
        await tx.query(`update system_alerts set resolved_at = $2 where tenant_id = $1 and kind = 'billing_past_due' and resolved_at is null`, [tenantId, now]);
        break;
      }
    }
    return { status: 'processed', httpStatus: 200 };
  });
}

export type MrrResult =
  | { status: 'ok'; mrr: number; currency: string | null; suggestedPlan: string | null; exceeded: boolean }
  | { status: 'no_connection' };

/** Revenu mensuel récurrent du tenant (via Stripe), palier conseillé, alerte de dépassement (jamais de blocage). */
export async function computeTenantMrr(deps: Deps, tenantId: string): Promise<MrrResult> {
  const conn = (await deps.pool.query(`select stripe_account_id, status from stripe_connections where tenant_id = $1`, [tenantId])).rows[0];
  if (!conn || conn.status !== 'ACTIVE') return { status: 'no_connection' };

  const subs = await deps.stripe.listSubscriptions(conn.stripe_account_id, { statuses: ['active', 'trialing', 'past_due'] });
  const byCurrency = new Map<string, number>();
  for (const s of subs) {
    byCurrency.set(s.currency, (byCurrency.get(s.currency) ?? 0) + monthlyAmount({ amount: s.amount, interval: s.interval, intervalCount: s.intervalCount }));
  }
  const [currency, mrr] = [...byCurrency.entries()].sort((a, b) => b[1] - a[1])[0] ?? [null, 0];

  const { plan: suggested } = planForMrr(deps.config.plans, mrr);
  const row = (await deps.pool.query(`select plan from billing_subscriptions where tenant_id = $1`, [tenantId])).rows[0];
  const current = deps.config.plans.find((p) => p.key === row?.plan) ?? null;
  const exceeded = !!current && current.maxMrr !== null && mrr > current.maxMrr;

  await deps.pool.query(
    `insert into billing_subscriptions (tenant_id, status, mrr_amount, mrr_currency, mrr_updated_at) values ($1,'NONE',$2,$3,$4)
     on conflict (tenant_id) do update set mrr_amount = excluded.mrr_amount, mrr_currency = excluded.mrr_currency, mrr_updated_at = excluded.mrr_updated_at`,
    [tenantId, mrr, currency, deps.clock.now()],
  );
  if (exceeded && suggested) {
    await raiseAlert(deps.pool, {
      tenantId,
      kind: 'plan_exceeded',
      dedupeKey: `plan_exceeded:${tenantId}`,
      message: `Votre revenu mensuel dépasse le palier ${current!.name} : passez au palier ${suggested.name}. Vos relances continuent normalement.`,
    });
  } else {
    await deps.pool.query(`update system_alerts set resolved_at = $2 where tenant_id = $1 and kind = 'plan_exceeded' and resolved_at is null`, [tenantId, deps.clock.now()]);
  }
  return { status: 'ok', mrr, currency, suggestedPlan: suggested?.key ?? null, exceeded };
}

/** Suspend (ou réactive) les tenants selon l'essai et l'abonnement ; sans paliers configurés, ne fait rien. */
export async function enforceBilling(deps: Deps): Promise<{ suspended: number; reactivated: number }> {
  const out = { suspended: 0, reactivated: 0 };
  if (deps.config.plans.length === 0) return out;
  const now = deps.clock.now().getTime();
  const rows = await deps.pool.query(
    `select t.id, t.status, t.created_at, b.status as bstatus, b.past_due_since, b.current_period_end
       from tenants t left join billing_subscriptions b on b.tenant_id = t.id
      where t.status in ('ACTIVE', 'SUSPENDED')`,
  );
  for (const r of rows.rows) {
    let desired: 'ACTIVE' | 'SUSPENDED';
    switch (r.bstatus) {
      case 'ACTIVE':
      case 'TRIALING':
        desired = 'ACTIVE';
        break;
      case 'PAST_DUE':
        desired = r.past_due_since && now - new Date(r.past_due_since).getTime() > deps.config.billingGraceDays * DAY ? 'SUSPENDED' : 'ACTIVE';
        break;
      case 'CANCELED':
        desired = r.current_period_end && new Date(r.current_period_end).getTime() > now ? 'ACTIVE' : 'SUSPENDED';
        break;
      default:
        desired = now > new Date(r.created_at).getTime() + deps.config.trialDays * DAY ? 'SUSPENDED' : 'ACTIVE';
    }
    if (desired === r.status) continue;
    await deps.pool.query(`update tenants set status = $2 where id = $1`, [r.id, desired]);
    await logAction(deps.pool, { tenantId: r.id, caseId: null, actor: 'billing', action: desired === 'SUSPENDED' ? 'tenant.suspended' : 'tenant.reactivated', details: {} });
    out[desired === 'SUSPENDED' ? 'suspended' : 'reactivated']++;
  }
  return out;
}

export async function getBillingStatus(deps: Deps, tenantId: string) {
  const t = (await deps.pool.query(`select created_at from tenants where id = $1`, [tenantId])).rows[0];
  const b = (await deps.pool.query(`select * from billing_subscriptions where tenant_id = $1`, [tenantId])).rows[0];
  const trialEndsAt = t ? new Date(new Date(t.created_at).getTime() + deps.config.trialDays * DAY) : null;
  const subscribed = b && b.status !== 'NONE';
  const state: BillingState = subscribed ? b.status : deps.clock.now() < trialEndsAt! ? 'TRIALING' : 'TRIAL_ENDED';
  return {
    enabled: deps.config.plans.length > 0,
    state,
    plan: (b?.plan as string | null) ?? null,
    currentPeriodEnd: (b?.current_period_end as Date | null) ?? null,
    cancelAtPeriodEnd: !!b?.cancel_at_period_end,
    trialEndsAt: subscribed ? null : trialEndsAt,
    mrr: b?.mrr_amount != null ? { amount: Number(b.mrr_amount), currency: b.mrr_currency as string } : null,
  };
}
