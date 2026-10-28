import type { Queryable } from './queryable';

export interface InboxEventInput {
  stripeEventId: string;
  accountId: string | null;
  tenantId: string | null;
  type: string;
  payload: unknown;
  /** `ignored` pour les événements d'un compte inconnu : stockés, jamais traités. */
  status?: 'pending' | 'ignored';
  /** Horloge de l'application (injectée) : date de réception et première échéance de traitement. */
  receivedAt?: Date;
}

/** Insère l'événement une seule fois (unicité de stripe_event_id). */
export async function insertInboxEvent(db: Queryable, e: InboxEventInput): Promise<'inserted' | 'duplicate'> {
  const res = await db.query(
    `insert into inbox_events (stripe_event_id, stripe_account_id, tenant_id, type, payload, status, received_at, next_attempt_at)
     values ($1, $2, $3, $4, $5::jsonb, $6, coalesce($7, now()), coalesce($7, now()))
     on conflict (stripe_event_id) do nothing
     returning id`,
    [e.stripeEventId, e.accountId, e.tenantId, e.type, JSON.stringify(e.payload), e.status ?? 'pending', e.receivedAt ?? null],
  );
  return res.rowCount === 1 ? 'inserted' : 'duplicate';
}
