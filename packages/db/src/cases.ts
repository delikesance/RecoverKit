import type { Queryable } from './queryable';

export interface CaseRow {
  id: string;
  tenantId: string;
  stripeInvoiceId: string;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  endCustomerId: string | null;
  state: string;
  amountDue: number;
  currency: string;
  planName: string | null;
  attemptCount: number;
  lastFailureCode: string | null;
  failedAt: Date;
  sequenceVersion: number | null;
  closeReason: string | null;
  closedAt: Date | null;
}

export function mapCase(r: any): CaseRow {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    stripeInvoiceId: r.stripe_invoice_id,
    stripeCustomerId: r.stripe_customer_id,
    stripeSubscriptionId: r.stripe_subscription_id,
    endCustomerId: r.end_customer_id,
    state: r.state,
    amountDue: Number(r.amount_due),
    currency: r.currency,
    planName: r.plan_name,
    attemptCount: r.attempt_count,
    lastFailureCode: r.last_failure_code,
    failedAt: r.failed_at,
    sequenceVersion: r.sequence_version,
    closeReason: r.close_reason,
    closedAt: r.closed_at,
  };
}

export interface UpsertCaseInput {
  tenantId: string;
  stripeInvoiceId: string;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  amountDue: number;
  currency: string;
  planName: string | null;
  failedAt: Date;
  failureCode: string | null;
  /** attempt_count de la facture Stripe : on garde le maximum, ce qui rend le rejeu idempotent. */
  attemptCount?: number;
  endCustomerId?: string | null;
}

const ACTIVE = `('OPEN','RECOVERING','PAUSED')`;

/** Crée le dossier ou met à jour la tentative ; un dossier terminal n'est jamais modifié. */
export async function upsertCase(db: Queryable, i: UpsertCaseInput): Promise<{ row: CaseRow; created: boolean }> {
  const res = await db.query(
    `insert into recovery_cases
       (tenant_id, stripe_invoice_id, stripe_customer_id, stripe_subscription_id, end_customer_id,
        amount_due, currency, plan_name, failed_at, last_failure_code, attempt_count)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     on conflict (tenant_id, stripe_invoice_id) do update set
       attempt_count = case when recovery_cases.state in ${ACTIVE}
         then greatest(recovery_cases.attempt_count, excluded.attempt_count) else recovery_cases.attempt_count end,
       last_failure_code = case when recovery_cases.state in ${ACTIVE}
         then excluded.last_failure_code else recovery_cases.last_failure_code end,
       updated_at = now()
     returning *, (xmax = 0) as created`,
    [
      i.tenantId, i.stripeInvoiceId, i.stripeCustomerId, i.stripeSubscriptionId, i.endCustomerId ?? null,
      i.amountDue, i.currency, i.planName, i.failedAt, i.failureCode, i.attemptCount ?? 1,
    ],
  );
  return { row: mapCase(res.rows[0]), created: res.rows[0].created === true };
}

export async function getCase(db: Queryable, tenantId: string, caseId: string): Promise<CaseRow | null> {
  const res = await db.query(`select * from recovery_cases where tenant_id = $1 and id = $2`, [tenantId, caseId]);
  return res.rows[0] ? mapCase(res.rows[0]) : null;
}

export async function getCaseByInvoice(db: Queryable, tenantId: string, invoiceId: string): Promise<CaseRow | null> {
  const res = await db.query(`select * from recovery_cases where tenant_id = $1 and stripe_invoice_id = $2`, [tenantId, invoiceId]);
  return res.rows[0] ? mapCase(res.rows[0]) : null;
}
