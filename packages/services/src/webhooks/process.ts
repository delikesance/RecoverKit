import type { PoolClient } from 'pg';
import type { Deps } from '../deps';
import { HANDLERS, type HandlerResult } from './handlers';
import { loadTenant, lockTenant, raiseAlert } from '../recovery/ops';

/** Délais avant chaque nouvel essai ; au 5e échec l'événement est marqué `dead`. */
export const BACKOFF_MINUTES = [1, 5, 30, 120];
export const MAX_ATTEMPTS = BACKOFF_MINUTES.length + 1;

export interface ProcessStats {
  processed: number;
  ignored: number;
  failed: number;
}

type One = 'none' | 'processed' | 'ignored' | 'failed';

async function processOne(deps: Deps): Promise<One> {
  const client: PoolClient = await deps.pool.connect();
  let claimed: { id: string; attempts: number; tenant_id: string | null; type: string; payload: any; stripe_event_id: string } | undefined;
  try {
    await client.query('begin');
    const res = await client.query(
      `select id, attempts, tenant_id, type, payload, stripe_event_id from inbox_events
        where status = 'pending' and next_attempt_at <= $1
        order by seq limit 1 for update skip locked`,
      [deps.clock.now()],
    );
    claimed = res.rows[0];
    if (!claimed) {
      await client.query('commit');
      return 'none';
    }

    const handler = HANDLERS[claimed.type];
    let result: HandlerResult = 'ignored';
    if (handler && claimed.tenant_id) {
      await lockTenant(client, claimed.tenant_id);
      const tenant = await loadTenant(client, claimed.tenant_id);
      const conn = await client.query(`select status, stripe_account_id from stripe_connections where tenant_id = $1`, [claimed.tenant_id]);
      const active = conn.rows[0]?.status === 'ACTIVE' && tenant?.status === 'ACTIVE';
      const isDeauth = claimed.type === 'account.application.deauthorized';
      if (tenant && conn.rows[0] && (active || isDeauth)) {
        const evt = claimed.payload;
        result = await handler({
          deps,
          db: client,
          tenant,
          account: conn.rows[0].stripe_account_id,
          event: {
            id: claimed.stripe_event_id,
            type: claimed.type,
            created: new Date((evt.created ?? 0) * 1000),
            object: evt.data?.object ?? {},
            previousAttributes: evt.data?.previous_attributes ?? null,
          },
        });
      }
    }
    await client.query(`update inbox_events set status = $2, processed_at = $3 where id = $1`, [
      claimed.id,
      result === 'processed' ? 'processed' : 'ignored',
      deps.clock.now(),
    ]);
    await client.query('commit');
    return result;
  } catch (e) {
    await client.query('rollback').catch(() => undefined);
    if (!claimed) throw e;
    await recordFailure(deps, claimed, e as Error);
    return 'failed';
  } finally {
    client.release();
  }
}

async function recordFailure(
  deps: Deps,
  row: { id: string; attempts: number; tenant_id: string | null; stripe_event_id: string; type: string },
  error: Error,
): Promise<void> {
  const now = deps.clock.now();
  const attempts = row.attempts + 1;
  const message = error.message.slice(0, 500);
  deps.log.warn({ eventId: row.stripe_event_id, type: row.type, attempts, err: message }, 'traitement du webhook en échec');
  if (attempts >= MAX_ATTEMPTS) {
    await deps.pool.query(`update inbox_events set status = 'dead', attempts = $2, last_error = $3 where id = $1`, [row.id, attempts, message]);
    await raiseAlert(deps.pool, {
      tenantId: row.tenant_id,
      kind: 'webhook_dead',
      dedupeKey: `webhook_dead:${row.stripe_event_id}`,
      message: `L'événement Stripe ${row.stripe_event_id} (${row.type}) n'a pas pu être traité après ${attempts} essais.`,
      details: { eventId: row.stripe_event_id, error: message },
    });
    return;
  }
  const next = new Date(now.getTime() + BACKOFF_MINUTES[attempts - 1]! * 60_000);
  await deps.pool.query(`update inbox_events set attempts = $2, next_attempt_at = $3, last_error = $4 where id = $1`, [
    row.id,
    attempts,
    next,
    message,
  ]);
}

/** Traite jusqu'à `limit` événements échus. Plusieurs workers peuvent l'exécuter en parallèle. */
export async function processInbox(deps: Deps, opts: { limit?: number } = {}): Promise<ProcessStats> {
  const limit = opts.limit ?? deps.config.inboxBatchSize;
  const stats: ProcessStats = { processed: 0, ignored: 0, failed: 0 };
  for (let i = 0; i < limit; i++) {
    const r = await processOne(deps);
    if (r === 'none') break;
    stats[r]++;
  }
  return stats;
}

/** Remet un événement `dead` en file (rejeu manuel). */
export async function replayDeadEvent(deps: Deps, stripeEventId: string): Promise<boolean> {
  const res = await deps.pool.query(
    `update inbox_events set status = 'pending', attempts = 0, next_attempt_at = $2, last_error = null
      where stripe_event_id = $1 and status = 'dead'`,
    [stripeEventId, deps.clock.now()],
  );
  if ((res.rowCount ?? 0) > 0) {
    await deps.pool.query(`update system_alerts set resolved_at = $2 where dedupe_key = $1 and resolved_at is null`, [
      `webhook_dead:${stripeEventId}`,
      deps.clock.now(),
    ]);
  }
  return (res.rowCount ?? 0) > 0;
}
