import { insertInboxEvent } from '@recoverkit/db';
import type { Deps } from '../deps';
import { verifyStripeSignature } from './signature';

export type ReceiveResult =
  | { status: 'received'; httpStatus: 200 }
  | { status: 'duplicate'; httpStatus: 200 }
  | { status: 'rejected'; httpStatus: 400; reason: string };

/**
 * Point d'entrée des webhooks Connect : vérifie la signature, stocke l'événement (dédoublonné par
 * event.id) et répond immédiatement. Le traitement est asynchrone (worker).
 */
export async function receiveStripeWebhook(
  deps: Deps,
  req: { rawBody: string; signature: string | null },
): Promise<ReceiveResult> {
  const check = verifyStripeSignature(req.rawBody, req.signature, deps.config.stripeConnectWebhookSecret, deps.clock.now());
  if (!check.ok) return { status: 'rejected', httpStatus: 400, reason: check.reason };

  let event: { id?: string; type?: string; account?: string | null };
  try {
    event = JSON.parse(req.rawBody);
  } catch {
    return { status: 'rejected', httpStatus: 400, reason: 'invalid_json' };
  }
  if (!event.id || !event.type) return { status: 'rejected', httpStatus: 400, reason: 'invalid_event' };

  let tenantId: string | null = null;
  if (event.account) {
    const res = await deps.pool.query(`select tenant_id from stripe_connections where stripe_account_id = $1`, [event.account]);
    tenantId = res.rows[0]?.tenant_id ?? null;
  }

  const outcome = await insertInboxEvent(deps.pool, {
    stripeEventId: event.id,
    accountId: event.account ?? null,
    tenantId,
    type: event.type,
    payload: event,
    status: tenantId ? 'pending' : 'ignored',
    receivedAt: deps.clock.now(),
  });
  return { status: outcome === 'inserted' ? 'received' : 'duplicate', httpStatus: 200 };
}
