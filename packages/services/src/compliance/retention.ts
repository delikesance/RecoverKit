import type { Deps } from '../deps';

export const RETENTION_MONTHS = 18;

/** Efface les données personnelles des dossiers clos depuis plus de 18 mois (emails, identité du client). */
export async function purgeRetention(deps: Deps): Promise<{ customers: number; emails: number }> {
  const now = deps.clock.now();
  const threshold = new Date(now);
  threshold.setUTCMonth(threshold.getUTCMonth() - RETENTION_MONTHS);

  const emails = await deps.pool.query(
    `delete from email_messages m using recovery_cases c
      where m.case_id = c.id and c.state in ('RECOVERED','CANCELED','LOST','CLOSED_MANUAL') and c.closed_at < $1`,
    [threshold],
  );
  const customers = await deps.pool.query(
    `update end_customers e set email = null, name = null, locale = null, anonymized_at = $2
      where e.anonymized_at is null
        and exists (select 1 from recovery_cases c where c.end_customer_id = e.id)
        and not exists (select 1 from recovery_cases c where c.end_customer_id = e.id
                         and (c.closed_at is null or c.closed_at >= $1 or c.state in ('OPEN','RECOVERING','PAUSED')))`,
    [threshold, now],
  );
  return { customers: customers.rowCount ?? 0, emails: emails.rowCount ?? 0 };
}
