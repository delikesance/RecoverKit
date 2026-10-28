import { logAction, mapCase, withTransaction } from '@recoverkit/db';
import type { Deps } from '../deps';
import { attemptPayment, loadTenant, lockTenant } from '../recovery/ops';

const WINDOW_MS = 24 * 3600_000;

/**
 * La veille du dernier avis : si le client a une carte par défaut qui n'a encore jamais été essayée
 * (donc différente de la carte en échec), on retente le paiement une fois.
 */
export async function runPreFinalRetries(deps: Deps): Promise<{ attempted: number }> {
  const now = deps.clock.now();
  const candidates = await deps.pool.query(
    `select c.* from recovery_cases c
      where c.state = 'RECOVERING'
        and exists (
          select 1 from scheduled_steps s
           where s.case_id = c.id and s.status = 'SCHEDULED'
             and s.step_index = (select max(step_index) from scheduled_steps where case_id = c.id)
             and s.due_at > $1 and s.due_at <= $2)
        and not exists (select 1 from action_log a where a.case_id = c.id and a.action = 'retry.pre_final')`,
    [now, new Date(now.getTime() + WINDOW_MS)],
  );

  let attempted = 0;
  for (const row of candidates.rows) {
    const c = mapCase(row);
    const done = await withTransaction(deps.pool, async (tx) => {
      await lockTenant(tx, c.tenantId);
      const tenant = await loadTenant(tx, c.tenantId);
      const conn = await tx.query(`select stripe_account_id, status from stripe_connections where tenant_id = $1`, [c.tenantId]);
      if (!tenant || tenant.dryRun || conn.rows[0]?.status !== 'ACTIVE' || !c.stripeCustomerId) return false;
      const customer = await deps.stripe.retrieveCustomer(conn.rows[0].stripe_account_id, c.stripeCustomerId);
      if (!customer.defaultPaymentMethodId) return false;
      const outcome = await attemptPayment(deps, tx, tenant, conn.rows[0].stripe_account_id, c, customer.defaultPaymentMethodId, 'webhook');
      if (outcome === 'already_attempted' || outcome === 'skipped_dry_run') return false;
      await logAction(tx, { tenantId: c.tenantId, caseId: c.id, actor: 'system', action: 'retry.pre_final', details: { outcome } });
      return true;
    }).catch((e) => {
      deps.log.warn({ caseId: c.id, err: (e as Error).message }, 'retry de la veille du dernier avis impossible');
      return false;
    });
    if (done) attempted++;
  }
  return { attempted };
}
