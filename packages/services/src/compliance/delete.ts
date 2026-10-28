import { logAction, withTransaction } from '@recoverkit/db';
import type { Deps } from '../deps';
import { lockTenant } from '../recovery/ops';

/**
 * Suppression définitive d'un compte (action sensible : nom du tenant à saisir). Révoque l'accès Stripe,
 * supprime toutes les données du tenant et ne conserve que le ledger comptable (sans donnée personnelle)
 * et une trace sans nom.
 */
export async function deleteTenant(
  deps: Deps,
  tenantId: string,
  o: { confirmName: string; actor: string },
): Promise<{ status: 'deleted' } | { status: 'confirmation_mismatch' } | { status: 'not_found' }> {
  const row = (await deps.pool.query(`select name from tenants where id = $1`, [tenantId])).rows[0];
  if (!row) return { status: 'not_found' };
  if (o.confirmName !== row.name) return { status: 'confirmation_mismatch' };

  const conn = (await deps.pool.query(`select stripe_account_id, status from stripe_connections where tenant_id = $1`, [tenantId])).rows[0];
  if (conn && conn.status === 'ACTIVE') {
    try {
      await deps.stripe.deauthorize(conn.stripe_account_id);
    } catch (e) {
      deps.log.warn({ tenantId, err: (e as Error).message }, 'révocation Stripe impossible pendant la suppression du compte');
    }
  }

  const sub = (await deps.pool.query(`select stripe_subscription_id, status from billing_subscriptions where tenant_id = $1`, [tenantId])).rows[0];
  if (sub?.stripe_subscription_id && sub.status !== 'CANCELED') {
    try {
      await deps.billing.cancelSubscription(sub.stripe_subscription_id);
    } catch (e) {
      deps.log.warn({ tenantId, err: (e as Error).message }, "annulation de l'abonnement impossible pendant la suppression du compte");
    }
  }

  await withTransaction(deps.pool, async (tx) => {
    await lockTenant(tx, tenantId);
    await tx.query(`set local recoverkit.allow_purge = 'on'`);
    await tx.query(`delete from action_log where tenant_id = $1`, [tenantId]);
    await tx.query(`delete from tenants where id = $1`, [tenantId]);
    await tx.query(`set local recoverkit.allow_purge = 'off'`);
    await logAction(tx, { tenantId: null, caseId: null, actor: o.actor, action: 'tenant.deleted', details: { tenantId, at: deps.clock.now().toISOString() } });
  });
  return { status: 'deleted' };
}
