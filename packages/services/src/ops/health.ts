import type { Deps } from '../deps';

export interface HealthDetails {
  status: 'ok' | 'degraded' | 'down';
  db: 'ok' | 'down';
  inbox: { pending: number; dead: number; oldestPendingAgeSeconds: number };
  steps: { overdue: number; sending: number; failed24h: number };
  emails: { sent24h: number; failed24h: number };
  alerts: { open: number };
}

const STALE_INBOX_SECONDS = 300;
const OVERDUE_MS = 15 * 60_000;

/** Indicateurs d'exploitation : file des webhooks, retards d'envoi, échecs, alertes ouvertes. */
export async function getHealthDetails(deps: Deps): Promise<HealthDetails> {
  const now = deps.clock.now();
  const empty: HealthDetails = {
    status: 'down',
    db: 'down',
    inbox: { pending: 0, dead: 0, oldestPendingAgeSeconds: 0 },
    steps: { overdue: 0, sending: 0, failed24h: 0 },
    emails: { sent24h: 0, failed24h: 0 },
    alerts: { open: 0 },
  };
  try {
    const q = async (sql: string, params: unknown[] = []) => (await deps.pool.query(sql, params)).rows[0];
    const since = new Date(now.getTime() - 24 * 3600_000);
    const inbox = await q(`select count(*) filter (where status = 'pending')::int as pending, count(*) filter (where status = 'dead')::int as dead, min(received_at) filter (where status = 'pending') as oldest from inbox_events`);
    const steps = await q(
      `select count(*) filter (where s.status = 'SCHEDULED' and s.due_at < $1 and c.state = 'RECOVERING')::int as overdue,
              count(*) filter (where s.status = 'SENDING')::int as sending,
              count(*) filter (where s.status = 'FAILED' and s.created_at > $2)::int as failed
         from scheduled_steps s join recovery_cases c on c.id = s.case_id`,
      [new Date(now.getTime() - OVERDUE_MS), since],
    );
    const emails = await q(`select count(*)::int as sent from email_messages where dry_run = false and sent_at > $1`, [since]);
    const alerts = await q(`select count(*)::int as n from system_alerts where resolved_at is null`);

    const age = inbox.oldest ? Math.max(0, Math.round((now.getTime() - new Date(inbox.oldest).getTime()) / 1000)) : 0;
    const degraded = inbox.dead > 0 || age > STALE_INBOX_SECONDS || steps.overdue > 0;
    return {
      status: degraded ? 'degraded' : 'ok',
      db: 'ok',
      inbox: { pending: inbox.pending, dead: inbox.dead, oldestPendingAgeSeconds: age },
      steps: { overdue: steps.overdue, sending: steps.sending, failed24h: steps.failed },
      emails: { sent24h: emails.sent, failed24h: steps.failed },
      alerts: { open: alerts.n },
    };
  } catch (e) {
    deps.log.error({ err: (e as Error).message }, 'indicateurs de santé indisponibles');
    return empty;
  }
}
