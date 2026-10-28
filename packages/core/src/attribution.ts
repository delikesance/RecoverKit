import { Money } from './money';
import { zonedToUtc } from './timezone';

export type Attribution = 'ASSISTED' | 'NATURAL';

export interface EmailRecord {
  sentAt: Date;
  status: 'SENT' | 'FAILED' | 'SKIPPED' | 'DRY_RUN';
}

/**
 * Règle D2 (version 1) :
 * - ASSISTED si au moins un email réellement envoyé précède strictement le paiement,
 *   ou si le lien de paiement a été utilisé au plus tard au moment du paiement ;
 * - NATURAL sinon (relance automatique Stripe, client proactif…).
 */
export function attribute(input: {
  paidAt: Date;
  emails: readonly EmailRecord[];
  linkUsedAt: Date | null;
}): Attribution {
  const paid = input.paidAt.getTime();
  const emailBefore = input.emails.some((e) => e.status === 'SENT' && e.sentAt.getTime() < paid);
  const linkUsed = input.linkUsedAt !== null && input.linkUsedAt.getTime() <= paid;
  return emailBefore || linkUsed ? 'ASSISTED' : 'NATURAL';
}

export const ATTRIBUTION_RULE_VERSION = 1;

export interface LedgerEntry {
  caseId: string;
  invoiceId: string;
  kind: 'RECOVERY' | 'ADJUSTMENT';
  attribution: Attribution;
  amount: Money;
  occurredAt: Date;
}

export function buildRecoveryEntry(input: {
  caseId: string;
  invoiceId: string;
  amountPaid: number;
  amountDue: number;
  currency: string;
  paidAt: Date;
  attribution: Attribution;
}): LedgerEntry {
  if (input.amountPaid <= 0) throw new Error('Le montant payé doit être positif');
  return {
    caseId: input.caseId,
    invoiceId: input.invoiceId,
    kind: 'RECOVERY',
    attribution: input.attribution,
    // Toujours le montant réellement encaissé (amount_paid), jamais le montant dû.
    amount: Money.of(input.amountPaid, input.currency),
    occurredAt: input.paidAt,
  };
}

export function buildRefundAdjustment(input: {
  original: LedgerEntry;
  refunded: number;
  occurredAt: Date;
}): LedgerEntry {
  if (input.refunded <= 0) throw new Error('Le montant remboursé doit être positif');
  if (input.refunded > input.original.amount.amount) {
    throw new Error('Le remboursement est supérieur au montant récupéré');
  }
  return {
    caseId: input.original.caseId,
    invoiceId: input.original.invoiceId,
    kind: 'ADJUSTMENT',
    attribution: input.original.attribution,
    amount: Money.of(-input.refunded, input.original.amount.currency),
    occurredAt: input.occurredAt,
  };
}

export interface CurrencySummary {
  /** Revenu récupéré (ASSISTED uniquement, ajustements inclus). */
  recovered: number;
  /** Payé avant tout email : affiché à part, jamais compté dans le revenu récupéré. */
  natural: number;
  savedCustomers: number;
}

export function summarizeLedger(
  entries: readonly LedgerEntry[],
  period: { year: number; month: number; timeZone: string },
): Map<string, CurrencySummary> {
  const start = zonedToUtc(period.year, period.month, 1, 0, 0, period.timeZone).getTime();
  const nextMonth = period.month === 12 ? { y: period.year + 1, m: 1 } : { y: period.year, m: period.month + 1 };
  const end = zonedToUtc(nextMonth.y, nextMonth.m, 1, 0, 0, period.timeZone).getTime();

  const out = new Map<string, CurrencySummary>();
  const saved = new Map<string, Set<string>>();
  for (const e of entries) {
    const t = e.occurredAt.getTime();
    if (t < start || t >= end) continue;
    const cur = e.amount.currency;
    const summary = out.get(cur) ?? { recovered: 0, natural: 0, savedCustomers: 0 };
    if (e.attribution === 'ASSISTED') {
      summary.recovered += e.amount.amount;
      if (e.kind === 'RECOVERY') {
        const set = saved.get(cur) ?? new Set<string>();
        set.add(e.caseId);
        saved.set(cur, set);
        summary.savedCustomers = set.size;
      }
    } else {
      summary.natural += e.amount.amount;
    }
    out.set(cur, summary);
  }
  return out;
}

export function recoveryRate(input: {
  recovered: number;
  lost: number;
  recoveredAmount: number;
  lostAmount: number;
}): { byCount: number | null; byAmount: number | null } {
  const closed = input.recovered + input.lost;
  const closedAmount = input.recoveredAmount + input.lostAmount;
  return {
    byCount: closed === 0 ? null : input.recovered / closed,
    byAmount: closedAmount === 0 ? null : input.recoveredAmount / closedAmount,
  };
}
