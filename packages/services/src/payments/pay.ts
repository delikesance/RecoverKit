import { randomUUID } from 'node:crypto';
import { Money, evaluateToken, hashToken } from '@recoverkit/core';
import { findPaymentTokenByHash, hitRateLimit, mapCase, withTransaction, type CaseRow, type PaymentTokenRow } from '@recoverkit/db';
import { GatewayError } from '@recoverkit/stripe';
import type { Deps } from '../deps';
import { attemptPayment, loadTenant, lockTenant, type TenantRow } from '../recovery/ops';
import type { PayLocale } from './messages';

export interface PayView {
  tenantName: string;
  amount: string;
  plan: string | null;
  locale: PayLocale;
  account: string;
  publishableKey: string;
}

export type ResolveResult =
  | { status: 'ok'; view: PayView }
  | { status: 'unavailable' }
  | { status: 'paid' }
  | { status: 'rate_limited' };

interface Loaded {
  token: PaymentTokenRow;
  c: CaseRow;
  tenant: TenantRow;
  account: string;
  locale: PayLocale;
}

const ACTIVE_STATES = ['OPEN', 'RECOVERING', 'PAUSED'];

async function load(deps: Deps, token: string, ip: string): Promise<Loaded | { status: 'unavailable' | 'paid' | 'rate_limited' }> {
  const hash = hashToken(token || '');
  const now = deps.clock.now();
  const byIp = await hitRateLimit(deps.pool, `pay:ip:${ip}`, { limit: 60, windowSeconds: 60 }, now);
  const byToken = await hitRateLimit(deps.pool, `pay:token:${hash}`, { limit: 30, windowSeconds: 600 }, now);
  if (!byIp.allowed || !byToken.allowed) return { status: 'rate_limited' };
  if (!token) return { status: 'unavailable' };

  const row = await findPaymentTokenByHash(deps.pool, hash);
  if (!row) return { status: 'unavailable' };
  const caseRes = await deps.pool.query(`select * from recovery_cases where id = $1`, [row.caseId]);
  if (!caseRes.rows[0]) return { status: 'unavailable' };
  const c = mapCase(caseRes.rows[0]);

  if (c.state === 'RECOVERED') return { status: 'paid' };
  const status = evaluateToken(row, now);
  if (status === 'USED') return { status: 'paid' };
  if (status !== 'ACTIVE' || !ACTIVE_STATES.includes(c.state)) return { status: 'unavailable' };

  const tenant = await loadTenant(deps.pool, c.tenantId);
  const conn = await deps.pool.query(`select stripe_account_id, status from stripe_connections where tenant_id = $1`, [c.tenantId]);
  if (!tenant || conn.rows[0]?.status !== 'ACTIVE') return { status: 'unavailable' };

  const cust = await deps.pool.query(`select locale from end_customers where id = $1`, [c.endCustomerId]);
  const l = cust.rows[0]?.locale;
  const locale: PayLocale = l === 'fr' || l === 'en' ? l : tenant.locale;
  return { token: row, c, tenant, account: conn.rows[0].stripe_account_id, locale };
}

export async function resolvePaymentLink(deps: Deps, token: string, ctx: { ip: string }): Promise<ResolveResult> {
  const r = await load(deps, token, ctx.ip);
  if ('status' in r) return r.status === 'rate_limited' ? { status: 'rate_limited' } : { status: r.status };
  await deps.pool.query(`update payment_tokens set first_opened_at = $2 where id = $1 and first_opened_at is null`, [
    r.token.id,
    deps.clock.now(),
  ]);
  return {
    status: 'ok',
    view: {
      tenantName: r.tenant.name,
      amount: Money.of(r.c.amountDue, r.c.currency).format(r.locale === 'fr' ? 'fr-FR' : 'en-US'),
      plan: r.c.planName,
      locale: r.locale,
      account: r.account,
      publishableKey: deps.config.stripePublishableKey,
    },
  };
}

export type StartSetupResult =
  | { status: 'ok'; clientSecret: string; setupIntentId: string; account: string; publishableKey: string }
  | { status: 'unavailable' | 'paid' | 'rate_limited' | 'error' };

export async function startSetup(deps: Deps, token: string, ctx: { ip: string }): Promise<StartSetupResult> {
  const r = await load(deps, token, ctx.ip);
  if ('status' in r) return { status: r.status };
  if (!r.c.stripeCustomerId) return { status: 'unavailable' };
  try {
    const si = await deps.stripe.createSetupIntent(r.account, {
      customerId: r.c.stripeCustomerId,
      idempotencyKey: `setup:${r.c.id}:${randomUUID()}`,
    });
    return { status: 'ok', clientSecret: si.clientSecret, setupIntentId: si.id, account: r.account, publishableKey: deps.config.stripePublishableKey };
  } catch (e) {
    deps.log.warn({ err: (e as Error).message }, 'création du SetupIntent impossible');
    return { status: 'error' };
  }
}

export type ConfirmResult =
  | { status: 'paid' }
  | { status: 'processing' }
  | { status: 'card_failed'; errorCode: string }
  | { status: 'requires_action'; hostedInvoiceUrl: string | null }
  | { status: 'setup_incomplete' }
  | { status: 'dry_run' }
  | { status: 'invalid' | 'unavailable' | 'rate_limited' | 'error' };

/** Vérifie côté serveur le SetupIntent (jamais confiance au navigateur), met la carte par défaut, retente le paiement. */
export async function confirmSetup(
  deps: Deps,
  token: string,
  setupIntentId: string,
  ctx: { ip: string },
): Promise<ConfirmResult> {
  const r = await load(deps, token, ctx.ip);
  if ('status' in r) return r.status === 'paid' ? { status: 'paid' } : { status: r.status };
  const { c, account, tenant } = r;

  try {
    const si = await deps.stripe.retrieveSetupIntent(account, setupIntentId);
    if (!c.stripeCustomerId || si.customerId !== c.stripeCustomerId) return { status: 'invalid' };
    if (si.status !== 'succeeded' || !si.paymentMethodId) return { status: 'setup_incomplete' };
    const pm = si.paymentMethodId;

    return await withTransaction(deps.pool, async (tx): Promise<ConfirmResult> => {
      await lockTenant(tx, c.tenantId);
      await deps.stripe.setDefaultPaymentMethod(account, { customerId: c.stripeCustomerId!, subscriptionId: c.stripeSubscriptionId, paymentMethodId: pm });
      const outcome = await attemptPayment(deps, tx, tenant, account, c, pm, 'link');
      if (outcome === 'skipped_dry_run') return { status: 'dry_run' };

      const att = await tx.query(`select status, error_code from payment_attempts where case_id = $1 and payment_method_id = $2`, [c.id, pm]);
      const status = outcome === 'already_attempted' ? (att.rows[0]?.status as string) : outcome;
      if (status === 'paid' || status === 'SUCCEEDED') {
        await tx.query(`update payment_tokens set used_at = $2 where id = $1 and used_at is null`, [r.token.id, deps.clock.now()]);
        return { status: 'paid' };
      }
      if (status === 'failed' || status === 'FAILED') return { status: 'card_failed', errorCode: att.rows[0]?.error_code ?? 'card_declined' };
      if (status === 'requires_action' || status === 'REQUIRES_ACTION') {
        const inv = await deps.stripe.retrieveInvoice(account, c.stripeInvoiceId);
        return { status: 'requires_action', hostedInvoiceUrl: inv.hostedInvoiceUrl ?? null };
      }
      return { status: 'processing' };
    });
  } catch (e) {
    deps.log.warn({ caseId: c.id, err: (e as Error).message, retryable: e instanceof GatewayError ? e.retryable : undefined }, 'confirmation du SetupIntent impossible');
    return { status: 'error' };
  }
}
