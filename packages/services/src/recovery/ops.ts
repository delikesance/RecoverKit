import {
  attribute,
  buildRecoveryEntry,
  buildRefundAdjustment,
  transitionCase,
  ATTRIBUTION_RULE_VERSION,
  type CaseEvent,
  type EmailRecord,
  type LedgerEntry,
  Money,
} from '@recoverkit/core';
import { insertLedgerEntry, logAction, mapCase, type CaseRow, type Queryable } from '@recoverkit/db';
import type { InvoiceData } from '@recoverkit/stripe';
import type { Deps } from '../deps';

export interface TenantRow {
  id: string;
  name: string;
  timeZone: string;
  locale: 'fr' | 'en';
  dryRun: boolean;
  emailsEnabled: boolean;
  sendStartHour: number;
  sendEndHour: number;
  status: string;
  senderName: string | null;
  senderEmail: string | null;
  senderVerified: boolean;
  replyTo: string | null;
  supportEmail: string | null;
}

export function mapTenant(r: any): TenantRow {
  return {
    id: r.id,
    name: r.name,
    timeZone: r.time_zone,
    locale: r.locale,
    dryRun: r.dry_run,
    emailsEnabled: r.emails_enabled,
    sendStartHour: r.send_start_hour,
    sendEndHour: r.send_end_hour,
    status: r.status,
    senderName: r.sender_name,
    senderEmail: r.sender_email,
    senderVerified: r.sender_verified,
    replyTo: r.reply_to,
    supportEmail: r.support_email,
  };
}

export async function loadTenant(db: Queryable, tenantId: string): Promise<TenantRow | null> {
  const res = await db.query(`select * from tenants where id = $1`, [tenantId]);
  return res.rows[0] ? mapTenant(res.rows[0]) : null;
}

/** Verrou de transaction par tenant : sérialise tous les traitements d'un même tenant. */
export async function lockTenant(db: Queryable, tenantId: string): Promise<void> {
  await db.query(`select pg_advisory_xact_lock(hashtextextended($1, 0))`, [`tenant:${tenantId}`]);
}

export async function raiseAlert(
  db: Queryable,
  a: { tenantId: string | null; kind: string; dedupeKey: string; message: string; details?: Record<string, unknown> },
): Promise<void> {
  await db.query(
    `insert into system_alerts (tenant_id, kind, dedupe_key, message, details) values ($1,$2,$3,$4,$5::jsonb)
     on conflict do nothing`,
    [a.tenantId, a.kind, a.dedupeKey, a.message, JSON.stringify(a.details ?? {})],
  );
}

export async function findCaseByInvoice(db: Queryable, tenantId: string, invoiceId: string): Promise<CaseRow | null> {
  const res = await db.query(`select * from recovery_cases where tenant_id = $1 and stripe_invoice_id = $2`, [tenantId, invoiceId]);
  return res.rows[0] ? mapCase(res.rows[0]) : null;
}

export async function findActiveCasesBy(
  db: Queryable,
  tenantId: string,
  by: { customerId?: string; subscriptionId?: string },
): Promise<CaseRow[]> {
  const res = await db.query(
    `select * from recovery_cases
      where tenant_id = $1 and state in ('OPEN','RECOVERING','PAUSED')
        and ($2::text is null or stripe_customer_id = $2)
        and ($3::text is null or stripe_subscription_id = $3)
      order by failed_at`,
    [tenantId, by.customerId ?? null, by.subscriptionId ?? null],
  );
  return res.rows.map(mapCase);
}

/** Transition + annulation des étapes planifiées + révocation du lien de paiement. */
export async function closeCase(
  deps: Deps,
  db: Queryable,
  c: CaseRow,
  event: Extract<CaseEvent, 'PAID' | 'INVOICE_VOIDED' | 'SUBSCRIPTION_CANCELED' | 'CLOSE_MANUAL' | 'SEQUENCE_EXHAUSTED'>,
  reason: string,
  actor = 'system',
): Promise<CaseRow['state']> {
  const now = deps.clock.now();
  const next = transitionCase(c.state as any, event);
  await db.query(
    `update recovery_cases set state = $2, closed_at = $3, close_reason = $4, updated_at = $3 where id = $1`,
    [c.id, next, now, reason],
  );
  await db.query(
    `update scheduled_steps set status = 'CANCELED', skip_reason = $2 where case_id = $1 and status = 'SCHEDULED'`,
    [c.id, reason],
  );
  await db.query(`update payment_tokens set revoked_at = $2 where case_id = $1 and revoked_at is null and used_at is null`, [c.id, now]);
  await logAction(db, { tenantId: c.tenantId, caseId: c.id, actor, action: `case.${next.toLowerCase()}`, details: { reason, from: c.state } });
  return next;
}

async function emailsOf(db: Queryable, caseId: string): Promise<EmailRecord[]> {
  const res = await db.query(`select sent_at, status, dry_run from email_messages where case_id = $1`, [caseId]);
  return res.rows.map((r) => ({
    sentAt: r.sent_at,
    status: r.dry_run ? 'DRY_RUN' : r.status === 'SENT' || r.status === 'DELIVERED' ? 'SENT' : 'FAILED',
  }));
}

/** Clôture le dossier payé et écrit la ligne du ledger (attribution + montant encaissé). */
export async function recordRecovery(
  deps: Deps,
  db: Queryable,
  c: CaseRow,
  inv: InvoiceData,
  eventId: string | null,
): Promise<'recorded' | 'already_closed'> {
  if (['RECOVERED', 'CANCELED', 'LOST', 'CLOSED_MANUAL'].includes(c.state)) return 'already_closed';

  const paidAt = inv.paidAt ?? deps.clock.now();
  const link = await db.query(`select min(created_at) as at from payment_attempts where case_id = $1 and source = 'link'`, [c.id]);
  const attribution = attribute({
    paidAt,
    emails: await emailsOf(db, c.id),
    linkUsedAt: link.rows[0]?.at ?? null,
  });

  await closeCase(deps, db, c, 'PAID', 'paid');
  if (inv.amountPaid > 0) {
    const entry = buildRecoveryEntry({
      caseId: c.id,
      invoiceId: c.stripeInvoiceId,
      amountPaid: inv.amountPaid,
      amountDue: inv.amountDue,
      currency: inv.currency,
      paidAt,
      attribution,
    });
    await insertLedgerEntry(db, {
      tenantId: c.tenantId,
      caseId: c.id,
      invoiceId: c.stripeInvoiceId,
      kind: 'RECOVERY',
      attribution: entry.attribution,
      amount: entry.amount.amount,
      currency: entry.amount.currency,
      occurredAt: entry.occurredAt,
      stripeEventId: eventId,
      ruleVersion: ATTRIBUTION_RULE_VERSION,
    });
    await logAction(db, {
      tenantId: c.tenantId,
      caseId: c.id,
      actor: 'system',
      action: 'ledger.recorded',
      details: { attribution, amount: entry.amount.amount, currency: entry.amount.currency },
    });
  }
  return 'recorded';
}

/** Ajuste le ledger quand un remboursement ou un litige annule tout ou partie d'un revenu récupéré. */
export async function reverseRecovery(
  db: Queryable,
  tenantId: string,
  invoiceId: string,
  desiredTotalReversal: number,
  occurredAt: Date,
  eventId: string,
): Promise<'adjusted' | 'noop' | 'no_recovery'> {
  const rows = await db.query(
    `select case_id, kind, attribution, amount, currency, occurred_at from recovery_ledger
      where tenant_id = $1 and invoice_id = $2 order by id`,
    [tenantId, invoiceId],
  );
  const base = rows.rows.find((r) => r.kind === 'RECOVERY');
  if (!base) return 'no_recovery';
  const already = -rows.rows.filter((r) => r.kind === 'ADJUSTMENT').reduce((n, r) => n + Number(r.amount), 0);
  const original: LedgerEntry = {
    caseId: base.case_id,
    invoiceId,
    kind: 'RECOVERY',
    attribution: base.attribution,
    amount: Money.of(Number(base.amount), base.currency),
    occurredAt: base.occurred_at,
  };
  const target = Math.min(desiredTotalReversal, original.amount.amount);
  const delta = target - already;
  if (delta <= 0) return 'noop';

  const adj = buildRefundAdjustment({ original, refunded: delta, occurredAt });
  await insertLedgerEntry(db, {
    tenantId,
    caseId: adj.caseId,
    invoiceId,
    kind: 'ADJUSTMENT',
    attribution: adj.attribution,
    amount: adj.amount.amount,
    currency: adj.amount.currency,
    occurredAt,
    stripeEventId: eventId,
    ruleVersion: ATTRIBUTION_RULE_VERSION,
  });
  await logAction(db, { tenantId, caseId: adj.caseId, actor: 'stripe', action: 'ledger.adjusted', details: { delta, eventId } });
  return 'adjusted';
}

export type AttemptOutcome = 'skipped_dry_run' | 'already_attempted' | 'paid' | 'failed' | 'requires_action';

/** Une seule tentative de paiement par (dossier, moyen de paiement). */
export async function attemptPayment(
  deps: Deps,
  db: Queryable,
  tenant: TenantRow,
  account: string,
  c: CaseRow,
  paymentMethodId: string,
  source: 'link' | 'webhook',
): Promise<AttemptOutcome> {
  if (tenant.dryRun) {
    await logAction(db, { tenantId: c.tenantId, caseId: c.id, actor: 'system', action: 'retry.skipped_dry_run', details: { paymentMethodId } });
    return 'skipped_dry_run';
  }
  const inserted = await db.query(
    `insert into payment_attempts (case_id, tenant_id, payment_method_id, status, source, created_at)
     values ($1,$2,$3,'PENDING',$4,$5) on conflict (case_id, payment_method_id) do nothing returning id`,
    [c.id, c.tenantId, paymentMethodId, source, deps.clock.now()],
  );
  if (inserted.rowCount !== 1) return 'already_attempted';

  const result = await deps.stripe.payInvoice(account, c.stripeInvoiceId, {
    paymentMethodId,
    idempotencyKey: `retry:${c.id}:${paymentMethodId}`,
  });
  const status = result.status === 'paid' ? 'SUCCEEDED' : result.status === 'failed' ? 'FAILED' : 'REQUIRES_ACTION';
  await db.query(`update payment_attempts set status = $2, error_code = $3 where id = $1`, [
    inserted.rows[0].id,
    status,
    result.status === 'failed' ? result.errorCode : null,
  ]);
  await logAction(db, {
    tenantId: c.tenantId,
    caseId: c.id,
    actor: source === 'link' ? 'customer' : 'system',
    action: `retry.${result.status}`,
    details: { paymentMethodId, source, ...(result.status === 'failed' ? { errorCode: result.errorCode } : {}) },
  });
  return result.status;
}
