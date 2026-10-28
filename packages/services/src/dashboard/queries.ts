import {
  Money,
  partsInZone,
  recoveryRate,
  summarizeLedger,
  zonedToUtc,
  type LedgerEntry,
} from '@recoverkit/core';
import { mapCase, type CaseRow } from '@recoverkit/db';
import type { Deps } from '../deps';
import { loadTenant } from '../recovery/ops';

const ACTIVE_STATES = ['OPEN', 'RECOVERING', 'PAUSED'] as const;
const ALL_STATES = ['OPEN', 'RECOVERING', 'PAUSED', 'RECOVERED', 'CANCELED', 'LOST', 'CLOSED_MANUAL'];

export interface Period {
  year: number;
  month: number;
}

function monthBounds(p: Period, timeZone: string): { start: Date; end: Date } {
  const next = p.month === 12 ? { y: p.year + 1, m: 1 } : { y: p.year, m: p.month + 1 };
  return { start: zonedToUtc(p.year, p.month, 1, 0, 0, timeZone), end: zonedToUtc(next.y, next.m, 1, 0, 0, timeZone) };
}

const stripeInvoiceUrl = (invoiceId: string) => `https://dashboard.stripe.com/invoices/${invoiceId}`;

export interface DashboardData {
  period: Period;
  currency: string | null;
  otherCurrencies: string[];
  recovered: number;
  natural: number;
  savedCustomers: number;
  previousRecovered: number;
  variation: number | null;
  atRisk: { amount: number; count: number };
  rate: { byCount: number | null; byAmount: number | null; recovered: number; lost: number };
  series: { date: string; cumulative: number }[];
  recent: {
    caseId: string;
    customerName: string | null;
    amount: number;
    currency: string;
    attribution: 'ASSISTED' | 'NATURAL';
    occurredAt: Date;
    afterEmail: number | null;
  }[];
}

function toEntry(r: any): LedgerEntry {
  return {
    caseId: r.case_id,
    invoiceId: r.invoice_id,
    kind: r.kind,
    attribution: r.attribution,
    amount: Money.of(Number(r.amount), r.currency),
    occurredAt: r.occurred_at,
  };
}

export async function getDashboard(
  deps: Deps,
  tenantId: string,
  o: Period & { currency?: string },
): Promise<DashboardData> {
  const tenant = await loadTenant(deps.pool, tenantId);
  if (!tenant) throw new Error('Tenant introuvable');
  const tz = tenant.timeZone;
  const cur = monthBounds(o, tz);
  const prevPeriod = o.month === 1 ? { year: o.year - 1, month: 12 } : { year: o.year, month: o.month - 1 };
  const prev = monthBounds(prevPeriod, tz);

  const rows = await deps.pool.query(
    `select * from recovery_ledger where tenant_id = $1 and occurred_at >= $2 and occurred_at < $3 order by occurred_at, id`,
    [tenantId, prev.start, cur.end],
  );
  const entries = rows.rows.map(toEntry);
  const sumCur = summarizeLedger(entries, { ...o, timeZone: tz });
  const sumPrev = summarizeLedger(entries, { ...prevPeriod, timeZone: tz });

  const risk = await deps.pool.query(
    `select currency, coalesce(sum(amount_due), 0)::bigint as amount, count(*)::int as n
       from recovery_cases where tenant_id = $1 and state = any($2) group by currency`,
    [tenantId, ACTIVE_STATES as unknown as string[]],
  );

  // Devise affichée : celle demandée, sinon celle qui a le plus récupéré, sinon celle qui a le plus à risque.
  let currency: string | null = o.currency ?? null;
  if (!currency && sumCur.size > 0) {
    currency = [...sumCur.entries()].sort((a, b) => b[1].recovered + b[1].natural - (a[1].recovered + a[1].natural))[0]![0];
  }
  if (!currency && risk.rows.length > 0) {
    currency = [...risk.rows].sort((a, b) => Number(b.amount) - Number(a.amount))[0].currency;
  }
  const currencies = new Set<string>([...sumCur.keys(), ...risk.rows.map((r) => r.currency)]);
  const otherCurrencies = [...currencies].filter((c) => c !== currency).sort();

  const s = currency ? sumCur.get(currency) : undefined;
  const recovered = s?.recovered ?? 0;
  const previousRecovered = (currency ? sumPrev.get(currency)?.recovered : 0) ?? 0;
  const riskRow = risk.rows.find((r) => r.currency === currency);

  const lost = currency
    ? (
        await deps.pool.query(
          `select count(*)::int n, coalesce(sum(amount_due), 0)::bigint amount from recovery_cases
            where tenant_id = $1 and state = 'LOST' and currency = $2 and closed_at >= $3 and closed_at < $4`,
          [tenantId, currency, cur.start, cur.end],
        )
      ).rows[0]
    : { n: 0, amount: 0 };
  const rate = recoveryRate({
    recovered: s?.savedCustomers ?? 0,
    lost: lost.n,
    recoveredAmount: recovered,
    lostAmount: Number(lost.amount),
  });

  // Série cumulée par jour local (ASSISTED uniquement), jusqu'à aujourd'hui pour le mois en cours.
  const series: DashboardData['series'] = [];
  {
    const byDay = new Map<string, number>();
    for (const e of entries) {
      if (e.amount.currency !== currency || e.attribution !== 'ASSISTED') continue;
      if (e.occurredAt < cur.start || e.occurredAt >= cur.end) continue;
      const p = partsInZone(e.occurredAt, tz);
      const key = `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
      byDay.set(key, (byDay.get(key) ?? 0) + e.amount.amount);
    }
    const daysInMonth = new Date(Date.UTC(o.year, o.month, 0)).getUTCDate();
    const today = partsInZone(deps.clock.now(), tz);
    const isCurrent = today.y === o.year && today.m === o.month;
    const isFuture = today.y < o.year || (today.y === o.year && today.m < o.month);
    const last = isFuture ? 0 : isCurrent ? today.d : daysInMonth;
    let running = 0;
    for (let d = 1; d <= last; d++) {
      const key = `${o.year}-${String(o.month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      running += byDay.get(key) ?? 0;
      series.push({ date: key, cumulative: running });
    }
  }

  const recentRows = currency
    ? (
        await deps.pool.query(
          `select l.case_id, l.amount, l.currency, l.attribution, l.occurred_at, e.name as customer_name,
                  (select count(*)::int from email_messages m
                    where m.case_id = l.case_id and m.dry_run = false and m.sent_at < l.occurred_at) as emails
             from recovery_ledger l
             join recovery_cases c on c.id = l.case_id
             left join end_customers e on e.id = c.end_customer_id
            where l.tenant_id = $1 and l.kind = 'RECOVERY' and l.attribution = 'ASSISTED' and l.currency = $2
              and l.occurred_at >= $3 and l.occurred_at < $4
            order by l.occurred_at desc, l.id desc limit 4`,
          [tenantId, currency, cur.start, cur.end],
        )
      ).rows
    : [];

  return {
    period: { year: o.year, month: o.month },
    currency,
    otherCurrencies,
    recovered,
    natural: s?.natural ?? 0,
    savedCustomers: s?.savedCustomers ?? 0,
    previousRecovered,
    variation: previousRecovered > 0 ? (recovered - previousRecovered) / previousRecovered : null,
    atRisk: { amount: Number(riskRow?.amount ?? 0), count: riskRow?.n ?? 0 },
    rate: { ...rate, recovered: s?.savedCustomers ?? 0, lost: lost.n },
    series,
    recent: recentRows.map((r) => ({
      caseId: r.case_id,
      customerName: r.customer_name,
      amount: Number(r.amount),
      currency: r.currency,
      attribution: r.attribution,
      occurredAt: r.occurred_at,
      afterEmail: r.emails > 0 ? r.emails : null,
    })),
  };
}

export type CaseSort = 'oldest' | 'newest' | 'amount_desc' | 'amount_asc';
const SORTS: Record<CaseSort, string> = {
  oldest: 'c.failed_at asc, c.id',
  newest: 'c.failed_at desc, c.id',
  amount_desc: 'c.amount_due desc, c.failed_at asc, c.id',
  amount_asc: 'c.amount_due asc, c.failed_at asc, c.id',
};

export interface CaseListRow {
  id: string;
  customerName: string | null;
  customerEmail: string | null;
  amount: number;
  currency: string;
  state: string;
  failureCode: string | null;
  attemptCount: number;
  failedAt: Date;
  daysSinceFailure: number;
  stepsSent: number;
  stepsTotal: number;
  nextDueAt: Date | null;
}

export async function listCases(
  deps: Deps,
  tenantId: string,
  o: { states?: string[]; minAmount?: number; maxAmount?: number; sort?: CaseSort; page?: number; pageSize?: number },
): Promise<{ rows: CaseListRow[]; total: number }> {
  const sort = o.sort ?? 'oldest';
  if (!(sort in SORTS)) throw new Error(`Critère de tri inconnu : ${sort}`);
  const states = o.states ?? [...ACTIVE_STATES];
  for (const s of states) if (!ALL_STATES.includes(s)) throw new Error(`Valeur d'état inconnue : ${s}`);
  const pageSize = Math.min(Math.max(o.pageSize ?? 25, 1), 200);
  const page = Math.max(o.page ?? 1, 1);

  const where = `c.tenant_id = $1 and c.state = any($2) and ($3::bigint is null or c.amount_due >= $3) and ($4::bigint is null or c.amount_due <= $4)`;
  const params = [tenantId, states, o.minAmount ?? null, o.maxAmount ?? null];
  const total = (await deps.pool.query(`select count(*)::int n from recovery_cases c where ${where}`, params)).rows[0].n as number;
  const res = await deps.pool.query(
    `select c.*, e.name as customer_name, e.email as customer_email,
            (select count(*)::int from scheduled_steps s where s.case_id = c.id and s.status = 'SENT') as steps_sent,
            (select count(*)::int from scheduled_steps s where s.case_id = c.id and s.status <> 'CANCELED') as steps_total,
            (select min(s.due_at) from scheduled_steps s where s.case_id = c.id and s.status = 'SCHEDULED') as next_due
       from recovery_cases c left join end_customers e on e.id = c.end_customer_id
      where ${where} order by ${SORTS[sort]} limit $5 offset $6`,
    [...params, pageSize, (page - 1) * pageSize],
  );
  const now = deps.clock.now().getTime();
  return {
    total,
    rows: res.rows.map((r) => ({
      id: r.id,
      customerName: r.customer_name,
      customerEmail: r.customer_email,
      amount: Number(r.amount_due),
      currency: r.currency,
      state: r.state,
      failureCode: r.last_failure_code,
      attemptCount: r.attempt_count,
      failedAt: r.failed_at,
      daysSinceFailure: Math.floor((now - new Date(r.failed_at).getTime()) / 86400_000),
      stepsSent: r.steps_sent,
      stepsTotal: r.steps_total,
      nextDueAt: r.next_due,
    })),
  };
}

export interface RecoveredRow {
  caseId: string;
  kind: 'RECOVERY' | 'ADJUSTMENT';
  attribution: 'ASSISTED' | 'NATURAL';
  amount: number;
  currency: string;
  occurredAt: Date;
  customerName: string | null;
  invoiceId: string;
  stripeInvoiceUrl: string;
}

export async function listRecovered(
  deps: Deps,
  tenantId: string,
  o: Period & { page?: number; pageSize?: number },
): Promise<{ rows: RecoveredRow[]; total: number }> {
  const tenant = await loadTenant(deps.pool, tenantId);
  if (!tenant) throw new Error('Tenant introuvable');
  const { start, end } = monthBounds(o, tenant.timeZone);
  const pageSize = Math.min(Math.max(o.pageSize ?? 50, 1), 500);
  const page = Math.max(o.page ?? 1, 1);
  const total = (
    await deps.pool.query(`select count(*)::int n from recovery_ledger where tenant_id = $1 and occurred_at >= $2 and occurred_at < $3`, [tenantId, start, end])
  ).rows[0].n as number;
  const res = await deps.pool.query(
    `select l.*, e.name as customer_name from recovery_ledger l
       left join recovery_cases c on c.id = l.case_id
       left join end_customers e on e.id = c.end_customer_id
      where l.tenant_id = $1 and l.occurred_at >= $2 and l.occurred_at < $3
      order by l.occurred_at desc, l.id desc limit $4 offset $5`,
    [tenantId, start, end, pageSize, (page - 1) * pageSize],
  );
  return {
    total,
    rows: res.rows.map((r) => ({
      caseId: r.case_id,
      kind: r.kind,
      attribution: r.attribution,
      amount: Number(r.amount),
      currency: r.currency,
      occurredAt: r.occurred_at,
      customerName: r.customer_name,
      invoiceId: r.invoice_id,
      stripeInvoiceUrl: stripeInvoiceUrl(r.invoice_id),
    })),
  };
}

export interface CaseDetail {
  case: CaseRow;
  customer: { name: string | null; email: string | null; locale: string | null } | null;
  steps: { stepIndex: number; status: string; dueAt: Date; sentAt: Date | null; skipReason: string | null }[];
  emails: { stepIndex: number; subject: string; sentAt: Date; status: string; opened: boolean; clicked: boolean; dryRun: boolean }[];
  attempts: { paymentMethodId: string; status: string; errorCode: string | null; source: string; createdAt: Date }[];
  timeline: { action: string; actor: string; details: Record<string, unknown>; at: Date }[];
  stripeInvoiceUrl: string;
}

export async function getCaseDetail(deps: Deps, tenantId: string, caseId: string): Promise<CaseDetail | null> {
  const c = await deps.pool.query(`select * from recovery_cases where id = $1 and tenant_id = $2`, [caseId, tenantId]);
  if (!c.rows[0]) return null;
  const row = mapCase(c.rows[0]);
  const [cust, steps, emails, attempts, logs] = await Promise.all([
    deps.pool.query(`select name, email, locale from end_customers where id = $1`, [row.endCustomerId]),
    deps.pool.query(`select step_index, status, due_at, sent_at, skip_reason from scheduled_steps where case_id = $1 order by step_index`, [caseId]),
    deps.pool.query(`select step_index, subject, sent_at, status, opened_at, clicked_at, dry_run from email_messages where case_id = $1 order by sent_at`, [caseId]),
    deps.pool.query(`select payment_method_id, status, error_code, source, created_at from payment_attempts where case_id = $1 order by created_at`, [caseId]),
    deps.pool.query(`select action, actor, details, created_at from action_log where tenant_id = $1 and case_id = $2 order by id`, [tenantId, caseId]),
  ]);
  return {
    case: row,
    customer: cust.rows[0] ?? null,
    steps: steps.rows.map((s) => ({ stepIndex: s.step_index, status: s.status, dueAt: s.due_at, sentAt: s.sent_at, skipReason: s.skip_reason })),
    emails: emails.rows.map((m) => ({ stepIndex: m.step_index, subject: m.subject, sentAt: m.sent_at, status: m.status, opened: m.opened_at !== null, clicked: m.clicked_at !== null, dryRun: m.dry_run })),
    attempts: attempts.rows.map((a) => ({ paymentMethodId: a.payment_method_id, status: a.status, errorCode: a.error_code, source: a.source, createdAt: a.created_at })),
    timeline: logs.rows.map((l) => ({ action: l.action, actor: l.actor, details: l.details, at: l.created_at })),
    stripeInvoiceUrl: stripeInvoiceUrl(row.stripeInvoiceId),
  };
}

export type AlertSeverity = 'critical' | 'warning' | 'info';
export interface BannerAlert {
  kind: string;
  severity: AlertSeverity;
  message: string;
  href?: string;
}

export const ALERT_SEVERITY: Record<string, AlertSeverity> = {
  stripe_revoked: 'critical',
  webhook_dead: 'critical',
  billing_past_due: 'critical',
  email_failed: 'warning',
  customer_email_missing: 'warning',
  sender_domain_failed: 'warning',
  plan_exceeded: 'warning',
  email_bounced: 'info',
};

export async function getBannerAlerts(deps: Deps, tenantId: string): Promise<BannerAlert[]> {
  const tenant = await loadTenant(deps.pool, tenantId);
  if (!tenant) return [];
  const out: BannerAlert[] = [];

  const conn = await deps.pool.query(`select status from stripe_connections where tenant_id = $1`, [tenantId]);
  if (!conn.rows[0]) {
    out.push({ kind: 'stripe_missing', severity: 'critical', message: 'Stripe n’est pas connecté : aucune relance ne peut partir.', href: '/app/onboarding' });
  } else if (conn.rows[0].status === 'REVOKED') {
    out.push({ kind: 'stripe_revoked', severity: 'critical', message: 'La connexion Stripe a été révoquée : les relances sont arrêtées.', href: '/app/settings' });
  }

  const now = deps.clock.now();
  const last = await deps.pool.query(
    `select c.id, c.amount_due, c.currency, e.name, s.due_at
       from recovery_cases c
       join scheduled_steps s on s.case_id = c.id and s.status = 'SCHEDULED'
       left join end_customers e on e.id = c.end_customer_id
      where c.tenant_id = $1 and c.state = 'RECOVERING'
        and s.step_index = (select max(step_index) from scheduled_steps where case_id = c.id)
        and s.due_at > $2 and s.due_at <= $3
      order by s.due_at`,
    [tenantId, now, new Date(now.getTime() + 48 * 3600_000)],
  );
  const fmt = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: tenant.timeZone });
  if (last.rows.length > 0 && last.rows.length <= 2) {
    for (const r of last.rows) {
      out.push({
        kind: 'last_notice',
        severity: 'warning',
        message: `${r.name ?? 'Un client'} (${Money.of(Number(r.amount_due), r.currency).format('fr-FR')}) reçoit son dernier avis le ${fmt.format(r.due_at)}. Sans paiement, son abonnement risque d’être suspendu.`,
        href: `/app/cases/${r.id}`,
      });
    }
  } else if (last.rows.length > 2) {
    out.push({ kind: 'last_notice', severity: 'warning', message: `${last.rows.length} clients reçoivent leur dernier avis dans les 48 prochaines heures.`, href: '/app/cases' });
  }

  const present = new Set(out.map((a) => a.kind));
  const alerts = await deps.pool.query(`select kind, message from system_alerts where tenant_id = $1 and resolved_at is null order by created_at`, [tenantId]);
  for (const a of alerts.rows) {
    if (present.has(a.kind)) continue;
    present.add(a.kind);
    out.push({ kind: a.kind, severity: ALERT_SEVERITY[a.kind] ?? 'info', message: a.message });
  }

  const rank: Record<AlertSeverity, number> = { critical: 0, warning: 1, info: 2 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}
