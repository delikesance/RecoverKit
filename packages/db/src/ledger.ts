import type { Queryable } from './queryable';

export interface LedgerInput {
  tenantId: string;
  caseId: string;
  invoiceId: string;
  kind: 'RECOVERY' | 'ADJUSTMENT';
  attribution: 'ASSISTED' | 'NATURAL';
  amount: number;
  currency: string;
  occurredAt: Date;
  stripeEventId: string | null;
  ruleVersion?: number;
}

export interface LedgerRow extends Omit<LedgerInput, 'ruleVersion'> {
  id: number;
  ruleVersion: number;
}

/** Ajoute une écriture ; une 2e écriture RECOVERY pour la même facture est refusée (`duplicate`). */
export async function insertLedgerEntry(db: Queryable, e: LedgerInput): Promise<'inserted' | 'duplicate'> {
  const res = await db.query(
    `insert into recovery_ledger
       (tenant_id, case_id, invoice_id, kind, attribution, amount, currency, occurred_at, rule_version, stripe_event_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     on conflict do nothing
     returning id`,
    [e.tenantId, e.caseId, e.invoiceId, e.kind, e.attribution, e.amount, e.currency, e.occurredAt, e.ruleVersion ?? 1, e.stripeEventId],
  );
  return res.rowCount === 1 ? 'inserted' : 'duplicate';
}

export async function listLedger(db: Queryable, tenantId: string): Promise<LedgerRow[]> {
  const res = await db.query(`select * from recovery_ledger where tenant_id = $1 order by id`, [tenantId]);
  return res.rows.map((r) => ({
    id: Number(r.id),
    tenantId: r.tenant_id,
    caseId: r.case_id,
    invoiceId: r.invoice_id,
    kind: r.kind,
    attribution: r.attribution,
    amount: Number(r.amount),
    currency: r.currency,
    occurredAt: r.occurred_at,
    stripeEventId: r.stripe_event_id,
    ruleVersion: r.rule_version,
  }));
}
