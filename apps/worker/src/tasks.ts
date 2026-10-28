import {
  closeExhaustedCases,
  computeTenantMrr,
  enforceBilling,
  notifyFounderAlerts,
  processInbox,
  purgeRetention,
  reconcileAll,
  runDueSteps,
  runPreFinalRetries,
  runWeeklyDigests,
  type Deps,
} from '@recoverkit/services';
import { purgeRateLimits } from '@recoverkit/db';
import type { Task } from './scheduler';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

export function buildTasks(deps: Deps): Task[] {
  return [
    { name: 'inbox', everyMs: 2 * SECOND, run: () => processInbox(deps) },
    { name: 'send-steps', everyMs: 30 * SECOND, run: () => runDueSteps(deps) },
    { name: 'close-exhausted', everyMs: 10 * MINUTE, run: () => closeExhaustedCases(deps) },
    { name: 'pre-final-retries', everyMs: HOUR, run: () => runPreFinalRetries(deps) },
    { name: 'reconcile', everyMs: 24 * HOUR, run: () => reconcileAll(deps) },
    { name: 'digests', everyMs: 15 * MINUTE, run: () => runWeeklyDigests(deps) },
    { name: 'founder-alerts', everyMs: 5 * MINUTE, run: () => notifyFounderAlerts(deps) },
    { name: 'billing-enforce', everyMs: HOUR, run: () => enforceBilling(deps) },
    {
      name: 'billing-mrr',
      everyMs: 24 * HOUR,
      run: async () => {
        const tenants = await deps.pool.query(`select tenant_id from stripe_connections where status = 'ACTIVE'`);
        for (const r of tenants.rows) await computeTenantMrr(deps, r.tenant_id).catch((e) => deps.log.warn({ err: (e as Error).message }, 'calcul du MRR impossible'));
      },
    },
    { name: 'retention', everyMs: 24 * HOUR, run: () => purgeRetention(deps) },
    { name: 'rate-limits', everyMs: HOUR, run: () => purgeRateLimits(deps.pool, deps.clock.now()) },
  ];
}
