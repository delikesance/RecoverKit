import { logAction } from '@recoverkit/db';
import type { Deps } from '../deps';

export const RETENTION_MONTHS = 18;
/** Durée de conservation des payloads Stripe bruts déjà traités (rejeu et diagnostic). */
export const INBOX_RETENTION_DAYS = 30;

export interface RetentionSummary {
  customers: number;
  emails: number;
  inboxEvents: number;
  loginTokens: number;
  /** Seuil de clôture (ISO) au-delà duquel les données personnelles ont été effacées. */
  threshold: string;
}

/**
 * Efface les données personnelles des dossiers clos depuis plus de 18 mois (emails, identité du client).
 * Journalise un résumé par tenant concerné (action_log) et retourne les compteurs globaux.
 */
export async function purgeRetention(deps: Deps): Promise<RetentionSummary> {
  const now = deps.clock.now();
  const threshold = new Date(now);
  threshold.setUTCMonth(threshold.getUTCMonth() - RETENTION_MONTHS);

  const emails = await deps.pool.query(
    `delete from email_messages m using recovery_cases c
      where m.case_id = c.id and c.state in ('RECOVERED','CANCELED','LOST','CLOSED_MANUAL') and c.closed_at < $1
      returning m.tenant_id`,
    [threshold],
  );
  const customers = await deps.pool.query(
    `update end_customers e set email = null, name = null, locale = null, anonymized_at = $2
      where (e.email is not null or e.name is not null)
        and exists (select 1 from recovery_cases c where c.end_customer_id = e.id)
        and not exists (select 1 from recovery_cases c where c.end_customer_id = e.id
                         and (c.closed_at is null or c.closed_at >= $1 or c.state in ('OPEN','RECOVERING','PAUSED')))
      returning e.tenant_id`,
    [threshold, now],
  );
  const inboxCutoff = new Date(now.getTime() - INBOX_RETENTION_DAYS * 86_400_000);
  const inbox = await deps.pool.query(`delete from inbox_events where status in ('processed','ignored','dead') and received_at < $1`, [inboxCutoff]);
  const tokens = await deps.pool.query(`delete from login_tokens where expires_at < $1`, [now]);

  const summary: RetentionSummary = {
    customers: customers.rowCount ?? 0,
    emails: emails.rowCount ?? 0,
    inboxEvents: inbox.rowCount ?? 0,
    loginTokens: tokens.rowCount ?? 0,
    threshold: threshold.toISOString(),
  };

  const perTenant = new Map<string, { emails: number; customers: number }>();
  for (const r of emails.rows) perTenant.set(r.tenant_id, { emails: (perTenant.get(r.tenant_id)?.emails ?? 0) + 1, customers: perTenant.get(r.tenant_id)?.customers ?? 0 });
  for (const r of customers.rows) perTenant.set(r.tenant_id, { emails: perTenant.get(r.tenant_id)?.emails ?? 0, customers: (perTenant.get(r.tenant_id)?.customers ?? 0) + 1 });
  for (const [tenantId, n] of perTenant) {
    await logAction(deps.pool, {
      tenantId,
      caseId: null,
      actor: 'system',
      action: 'retention.purged',
      details: { emails: n.emails, customers: n.customers, threshold: summary.threshold },
    });
  }
  // inbox_events et login_tokens ne sont pas rattachés à un tenant de façon fiable : trace structurée globale.
  deps.log.info({ ...summary }, 'purge de rétention');
  return summary;
}
