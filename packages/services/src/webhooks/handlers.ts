import { decidePaymentFailed, scheduleSteps, transitionCase, type SequenceStep } from '@recoverkit/core';
import { insertScheduledSteps, logAction, upsertCase, type Queryable } from '@recoverkit/db';
import type { Deps } from '../deps';
import { handleDeauthorized } from '../stripe/connect';
import {
  attemptPayment,
  closeCase,
  findActiveCasesBy,
  findCaseByInvoice,
  raiseAlert,
  recordRecovery,
  reverseRecovery,
  type TenantRow,
} from '../recovery/ops';

export interface EventContext {
  deps: Deps;
  db: Queryable;
  tenant: TenantRow;
  account: string;
  event: {
    id: string;
    type: string;
    created: Date;
    object: any;
    previousAttributes: any;
  };
}

export type HandlerResult = 'processed' | 'ignored';
type Handler = (ctx: EventContext) => Promise<HandlerResult>;

const str = (v: unknown): string | null => (typeof v === 'string' ? v : ((v as { id?: string } | null)?.id ?? null));

async function upsertEndCustomer(ctx: EventContext, customer: { id: string; email: string | null; name: string | null; locale: string | null }) {
  const res = await ctx.db.query(
    `insert into end_customers (tenant_id, stripe_customer_id, email, name, locale) values ($1,$2,$3,$4,$5)
     on conflict (tenant_id, stripe_customer_id) do update set email = excluded.email, name = excluded.name, locale = excluded.locale,
       anonymized_at = case when excluded.email is not null or excluded.name is not null then null else end_customers.anonymized_at end
     returning id`,
    [ctx.tenant.id, customer.id, customer.email, customer.name, customer.locale],
  );
  return res.rows[0].id as string;
}

/** Planifie la séquence d'un dossier OPEN et le passe en RECOVERING. */
async function scheduleCaseSteps(
  ctx: EventContext,
  caseId: string,
  failedAt: Date,
  opened: { invoiceId: string; amountDue: number; currency: string } | null,
) {
  const { deps, db, tenant } = ctx;
  const seq = await db.query(`select version, steps from sequences where tenant_id = $1 order by version desc limit 1`, [tenant.id]);
  const steps: SequenceStep[] = seq.rows[0]?.steps ?? [];
  const plans = scheduleSteps({
    failedAt,
    now: deps.clock.now(),
    steps,
    window: { startHour: tenant.sendStartHour, endHour: tenant.sendEndHour, timeZone: tenant.timeZone },
  });
  await insertScheduledSteps(db, caseId, tenant.id, plans);
  await db.query(`update recovery_cases set state = $2, sequence_version = $3, updated_at = $4 where id = $1`, [
    caseId,
    transitionCase('OPEN', 'SEQUENCE_SCHEDULED'),
    seq.rows[0]?.version ?? null,
    deps.clock.now(),
  ]);
  if (opened) {
    await logAction(db, { tenantId: tenant.id, caseId, actor: 'stripe', action: 'case.opened', details: opened });
  }
  await logAction(db, { tenantId: tenant.id, caseId, actor: 'system', action: 'steps.scheduled', details: { count: plans.length, sequenceVersion: seq.rows[0]?.version ?? null } });
}

async function handlePaymentFailed(ctx: EventContext): Promise<HandlerResult> {
  const { deps, db, tenant, account, event } = ctx;
  const invoiceId = str(event.object.id);
  if (!invoiceId) return 'ignored';

  // On se fie à l'état réel chez Stripe, pas à l'ordre d'arrivée des événements.
  const inv = await deps.stripe.retrieveInvoice(account, invoiceId);
  const existing = await findCaseByInvoice(db, tenant.id, invoiceId);

  if (inv.status === 'paid') {
    if (existing) await recordRecovery(deps, db, existing, inv, event.id);
    return 'processed';
  }
  if (!inv.subscriptionId || !inv.customerId) return 'processed'; // D4 : abonnements uniquement

  const decision = decidePaymentFailed((existing?.state as any) ?? null);
  const failureCode = inv.lastErrorCode ?? event.object?.last_payment_error?.code ?? null;

  if (decision === 'IGNORE') {
    await logAction(db, { tenantId: tenant.id, caseId: existing!.id, actor: 'stripe', action: 'case.failure_ignored', details: { state: existing!.state } });
    return 'processed';
  }

  if (decision === 'INCREMENT') {
    const { row } = await upsertCase(db, {
      tenantId: tenant.id, stripeInvoiceId: invoiceId, stripeCustomerId: inv.customerId, stripeSubscriptionId: inv.subscriptionId,
      amountDue: inv.amountDue, currency: inv.currency, planName: inv.planName ?? null, failedAt: existing!.failedAt,
      failureCode, attemptCount: inv.attemptCount,
    });
    await logAction(db, { tenantId: tenant.id, caseId: row.id, actor: 'stripe', action: 'case.attempt', details: { attemptCount: row.attemptCount, failureCode } });
    if (existing!.state === 'OPEN') {
      // Dossier ouvert sans email : si le client en a un désormais, la séquence démarre comme à la création.
      const customer = await deps.stripe.retrieveCustomer(account, inv.customerId);
      if (customer.email) {
        await upsertEndCustomer(ctx, customer);
        await scheduleCaseSteps(ctx, row.id, existing!.failedAt, null);
      }
    }
    return 'processed';
  }

  // La réconciliation fournit la date réelle du dernier échec (failedAt) ; sinon, celle de l'évènement.
  const failedAt = inv.failedAt ?? event.created;
  const customer = await deps.stripe.retrieveCustomer(account, inv.customerId);
  const endCustomerId = await upsertEndCustomer(ctx, customer);
  const { row } = await upsertCase(db, {
    tenantId: tenant.id, stripeInvoiceId: invoiceId, stripeCustomerId: inv.customerId, stripeSubscriptionId: inv.subscriptionId,
    amountDue: inv.amountDue, currency: inv.currency, planName: inv.planName ?? null, failedAt,
    failureCode, attemptCount: inv.attemptCount, endCustomerId,
  });
  if (inv.failedPaymentMethodId) {
    // La carte réellement refusée (PaymentIntent de la facture) est mémorisée : elle ne sera jamais « retentée » comme si elle était nouvelle.
    await db.query(
      `insert into payment_attempts (case_id, tenant_id, payment_method_id, status, error_code, source, created_at)
       values ($1,$2,$3,'FAILED','initial_failure','webhook',$4) on conflict (case_id, payment_method_id) do nothing`,
      [row.id, tenant.id, inv.failedPaymentMethodId, deps.clock.now()],
    );
  }

  if (!customer.email) {
    await raiseAlert(db, {
      tenantId: tenant.id, kind: 'customer_email_missing', dedupeKey: `customer_email_missing:${tenant.id}:${invoiceId}`,
      message: `Le client de la facture ${invoiceId} n'a pas d'adresse email : aucune relance possible.`,
    });
    await logAction(db, { tenantId: tenant.id, caseId: row.id, actor: 'system', action: 'case.opened_no_email', details: {} });
    return 'processed';
  }

  await scheduleCaseSteps(ctx, row.id, failedAt, { invoiceId, amountDue: inv.amountDue, currency: inv.currency });
  return 'processed';
}

async function handlePaid(ctx: EventContext): Promise<HandlerResult> {
  const { deps, db, tenant, account, event } = ctx;
  const invoiceId = str(event.object.id);
  if (!invoiceId) return 'ignored';
  const existing = await findCaseByInvoice(db, tenant.id, invoiceId);
  if (!existing) return 'processed';

  const inv = await deps.stripe.retrieveInvoice(account, invoiceId);
  if (inv.status !== 'paid') {
    await logAction(db, { tenantId: tenant.id, caseId: existing.id, actor: 'stripe', action: 'paid.ignored_stale', details: { stripeStatus: inv.status } });
    return 'processed';
  }
  await recordRecovery(deps, db, existing, inv, event.id);
  return 'processed';
}

function handleCancellation(reason: 'INVOICE_VOIDED'): Handler {
  return async (ctx) => {
    const invoiceId = str(ctx.event.object.id);
    if (!invoiceId) return 'ignored';
    const existing = await findCaseByInvoice(ctx.db, ctx.tenant.id, invoiceId);
    if (existing && ['OPEN', 'RECOVERING', 'PAUSED'].includes(existing.state)) {
      await closeCase(ctx.deps, ctx.db, existing, reason, ctx.event.type.replace('invoice.', ''), 'stripe');
    }
    return 'processed';
  };
}

async function handleSubscriptionDeleted(ctx: EventContext): Promise<HandlerResult> {
  const subId = str(ctx.event.object.id);
  if (!subId) return 'ignored';
  for (const c of await findActiveCasesBy(ctx.db, ctx.tenant.id, { subscriptionId: subId })) {
    await closeCase(ctx.deps, ctx.db, c, 'SUBSCRIPTION_CANCELED', 'subscription_canceled', 'stripe');
  }
  return 'processed';
}

async function handleSubscriptionUpdated(ctx: EventContext): Promise<HandlerResult> {
  const { deps, db, tenant, account, event } = ctx;
  const subId = str(event.object.id);
  const status = event.object.status as string | undefined;
  if (!subId) return 'ignored';
  const cases = await findActiveCasesBy(db, tenant.id, { subscriptionId: subId });

  for (const c of cases) {
    if (status === 'canceled') {
      await closeCase(deps, db, c, 'SUBSCRIPTION_CANCELED', 'subscription_canceled', 'stripe');
    } else if (status === 'active' || status === 'trialing') {
      const inv = await deps.stripe.retrieveInvoice(account, c.stripeInvoiceId);
      if (inv.status === 'paid') await recordRecovery(deps, db, c, inv, event.id);
    }
  }
  return 'processed';
}

async function retryForCustomer(ctx: EventContext, customerId: string | null, paymentMethodId: string | null): Promise<HandlerResult> {
  if (!customerId || !paymentMethodId) return 'processed';
  const cases = await findActiveCasesBy(ctx.db, ctx.tenant.id, { customerId });
  for (const c of cases) {
    await attemptPayment(ctx.deps, ctx.db, ctx.tenant, ctx.account, c, paymentMethodId, 'webhook');
  }
  return 'processed';
}

async function handleCustomerUpdated(ctx: EventContext): Promise<HandlerResult> {
  const prev = ctx.event.previousAttributes?.invoice_settings;
  if (!prev || !('default_payment_method' in prev)) return 'processed';
  const now = str(ctx.event.object.invoice_settings?.default_payment_method);
  if (!now || now === str(prev.default_payment_method)) return 'processed';
  return retryForCustomer(ctx, str(ctx.event.object.id), now);
}

async function invoiceIdOf(ctx: EventContext): Promise<string | null> {
  const direct = str(ctx.event.object.invoice);
  if (direct) return direct;
  const pi = str(ctx.event.object.payment_intent);
  return pi ? ctx.deps.stripe.invoiceIdForPaymentIntent(ctx.account, pi) : null;
}

async function handleRefund(ctx: EventContext): Promise<HandlerResult> {
  const invoiceId = await invoiceIdOf(ctx);
  if (!invoiceId) return 'processed';
  await reverseRecovery(ctx.db, ctx.tenant.id, invoiceId, Number(ctx.event.object.amount_refunded ?? 0), ctx.event.created, ctx.event.id);
  return 'processed';
}

async function handleDispute(ctx: EventContext): Promise<HandlerResult> {
  const invoiceId = await invoiceIdOf(ctx);
  if (!invoiceId) return 'processed';
  await reverseRecovery(ctx.db, ctx.tenant.id, invoiceId, Number(ctx.event.object.amount ?? 0), ctx.event.created, ctx.event.id);
  return 'processed';
}

export const HANDLERS: Record<string, Handler> = {
  'invoice.payment_failed': handlePaymentFailed,
  'invoice.paid': handlePaid,
  'invoice.payment_succeeded': handlePaid,
  'invoice.voided': handleCancellation('INVOICE_VOIDED'),
  'invoice.marked_uncollectible': handleCancellation('INVOICE_VOIDED'),
  'customer.subscription.deleted': handleSubscriptionDeleted,
  'customer.subscription.updated': handleSubscriptionUpdated,
  'setup_intent.succeeded': (ctx) => retryForCustomer(ctx, str(ctx.event.object.customer), str(ctx.event.object.payment_method)),
  'payment_method.attached': (ctx) => retryForCustomer(ctx, str(ctx.event.object.customer), str(ctx.event.object.id)),
  'customer.updated': handleCustomerUpdated,
  'charge.refunded': handleRefund,
  'charge.dispute.created': handleDispute,
  'account.application.deauthorized': async (ctx) => {
    await handleDeauthorized(ctx.deps, ctx.account, ctx.db);
    return 'processed';
  },
};
