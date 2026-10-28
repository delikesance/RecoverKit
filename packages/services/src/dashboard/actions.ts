import { nextWindowInstant, partsInZone, transitionCase, MIN_GAP_MS } from '@recoverkit/core';
import { logAction, mapCase, withTransaction, type CaseRow, type Queryable } from '@recoverkit/db';
import type { Deps } from '../deps';
import { closeCase, loadTenant, lockTenant, type TenantRow } from '../recovery/ops';
import { listRecovered } from './queries';

type Base = { status: 'ok' } | { status: 'not_found' } | { status: 'invalid_state' };

async function withCase<T>(
  deps: Deps,
  tenantId: string,
  caseId: string,
  fn: (tx: Queryable, c: CaseRow, tenant: TenantRow) => Promise<T>,
): Promise<T | { status: 'not_found' }> {
  return withTransaction(deps.pool, async (tx) => {
    await lockTenant(tx, tenantId);
    const res = await tx.query(`select * from recovery_cases where id = $1 and tenant_id = $2`, [caseId, tenantId]);
    const tenant = await loadTenant(tx, tenantId);
    if (!res.rows[0] || !tenant) return { status: 'not_found' as const };
    return fn(tx, mapCase(res.rows[0]), tenant);
  });
}

export async function pauseCase(deps: Deps, tenantId: string, caseId: string, actor: string): Promise<Base> {
  return withCase(deps, tenantId, caseId, async (tx, c): Promise<Base> => {
    if (c.state !== 'RECOVERING') return { status: 'invalid_state' };
    await tx.query(`update recovery_cases set state = $2, updated_at = $3 where id = $1`, [c.id, transitionCase('RECOVERING', 'PAUSE'), deps.clock.now()]);
    await logAction(tx, { tenantId, caseId, actor, action: 'case.paused', details: {} });
    return { status: 'ok' };
  });
}

/** Reprise : les étapes échues sont replanifiées dans la fenêtre d'envoi, avec l'écart minimal entre emails. */
export async function resumeCase(deps: Deps, tenantId: string, caseId: string, actor: string): Promise<Base> {
  return withCase(deps, tenantId, caseId, async (tx, c, tenant): Promise<Base> => {
    if (c.state !== 'PAUSED') return { status: 'invalid_state' };
    const now = deps.clock.now();
    const window = { startHour: tenant.sendStartHour, endHour: tenant.sendEndHour, timeZone: tenant.timeZone };
    const pending = await tx.query(
      `select id, due_at from scheduled_steps where case_id = $1 and status = 'SCHEDULED' order by step_index`,
      [caseId],
    );
    const lastSent = await tx.query(`select max(sent_at) as at from scheduled_steps where case_id = $1 and status = 'SENT'`, [caseId]);
    let previous: number | null = lastSent.rows[0]?.at ? new Date(lastSent.rows[0].at).getTime() : null;
    for (const s of pending.rows) {
      const original = new Date(s.due_at).getTime();
      if (original > now.getTime()) {
        previous = original;
        continue;
      }
      let candidate = now.getTime();
      if (previous !== null) candidate = Math.max(candidate, previous + MIN_GAP_MS);
      const due = nextWindowInstant(new Date(candidate), window);
      await tx.query(`update scheduled_steps set due_at = $2 where id = $1`, [s.id, due]);
      previous = due.getTime();
    }
    await tx.query(`update recovery_cases set state = $2, updated_at = $3 where id = $1`, [c.id, transitionCase('PAUSED', 'RESUME'), now]);
    await logAction(tx, { tenantId, caseId, actor, action: 'case.resumed', details: {} });
    return { status: 'ok' };
  });
}

export type SendNowResult =
  | { status: 'queued'; stepIndex: number }
  | { status: 'already_due'; stepIndex: number }
  | { status: 'not_found' | 'not_active' | 'in_progress' | 'no_step' | 'too_soon' };

/** « Envoyer maintenant » : la prochaine étape devient échue ; le worker l'envoie (jamais en double). */
export async function sendNextNow(deps: Deps, tenantId: string, caseId: string, actor: string): Promise<SendNowResult> {
  return withCase(deps, tenantId, caseId, async (tx, c): Promise<SendNowResult> => {
    if (c.state !== 'RECOVERING') return { status: 'not_active' };
    const now = deps.clock.now();
    const busy = await tx.query(`select 1 from scheduled_steps where case_id = $1 and status = 'SENDING'`, [caseId]);
    if ((busy.rowCount ?? 0) > 0) return { status: 'in_progress' };
    const next = await tx.query(`select id, step_index, due_at from scheduled_steps where case_id = $1 and status = 'SCHEDULED' order by step_index limit 1`, [caseId]);
    const step = next.rows[0];
    if (!step) return { status: 'no_step' };
    if (new Date(step.due_at).getTime() <= now.getTime()) return { status: 'already_due', stepIndex: step.step_index };
    const recent = await tx.query(`select 1 from email_messages where case_id = $1 and sent_at > $2`, [caseId, new Date(now.getTime() - 3600_000)]);
    if ((recent.rowCount ?? 0) > 0) return { status: 'too_soon' };
    await tx.query(`update scheduled_steps set due_at = $2 where id = $1`, [step.id, now]);
    await logAction(tx, { tenantId, caseId, actor, action: 'case.send_now', details: { stepIndex: step.step_index } });
    return { status: 'queued', stepIndex: step.step_index };
  });
}

export type CloseManualResult = Base | { status: 'reason_required' };

export async function closeCaseManually(deps: Deps, tenantId: string, caseId: string, actor: string, reason: string): Promise<CloseManualResult> {
  const clean = reason.trim();
  if (clean.length < 3) return { status: 'reason_required' };
  return withCase(deps, tenantId, caseId, async (tx, c): Promise<CloseManualResult> => {
    if (!['RECOVERING', 'PAUSED', 'OPEN'].includes(c.state)) return { status: 'invalid_state' };
    await closeCase(deps, tx, c, 'CLOSE_MANUAL', clean, actor);
    return { status: 'ok' };
  });
}

const CSV_HEADER = ['Date', 'Client', 'Type', 'Attribution', 'Montant', 'Devise', 'Facture Stripe', 'Lien Stripe'];

function cell(value: string, numeric = false): string {
  // Texte : neutralise les formules (injection CSV). Nombre : laissé tel quel (un montant négatif est légitime).
  const safe = !numeric && /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[;"\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** CSV des écritures du mois (séparateur « ; », BOM UTF-8 pour Excel), diffusé par blocs. */
export async function* exportRecoveredCsv(deps: Deps, tenantId: string, period: { year: number; month: number }): AsyncGenerator<string> {
  const tenant = await loadTenant(deps.pool, tenantId);
  if (!tenant) throw new Error('Tenant introuvable');
  yield '﻿' + CSV_HEADER.join(';') + '\r\n';
  const pageSize = 500;
  for (let page = 1; ; page++) {
    const { rows } = await listRecovered(deps, tenantId, { ...period, page, pageSize });
    if (rows.length === 0) break;
    let chunk = '';
    for (const r of rows) {
      const p = partsInZone(r.occurredAt, tenant.timeZone);
      const date = `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')} ${String(p.h).padStart(2, '0')}:${String(p.min).padStart(2, '0')}`;
      const digits = new Intl.NumberFormat('en', { style: 'currency', currency: r.currency }).resolvedOptions().maximumFractionDigits ?? 2;
      const amount = (r.amount / 10 ** digits).toFixed(digits).replace('.', ',');
      const attribution = r.attribution === 'ASSISTED' ? 'Récupéré' : 'Payé avant relance (non compté)';
      chunk +=
        [
          cell(date),
          cell(r.customerName ?? ''),
          cell(r.kind === 'RECOVERY' ? 'Récupération' : 'Ajustement'),
          cell(attribution),
          cell(amount, true),
          cell(r.currency),
          cell(r.invoiceId),
          cell(r.stripeInvoiceUrl),
        ].join(';') + '\r\n';
    }
    yield chunk;
    if (rows.length < pageSize) break;
  }
}

