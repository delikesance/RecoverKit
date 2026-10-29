import type { Deps } from '@recoverkit/services';
import type { Attribution } from './format';

/** Attribution du ledger des dossiers donnés (première écriture RECOVERY) : distingue « récupéré » de « payé sans relance ». */
export async function caseAttributions(deps: Deps, tenantId: string, caseIds: string[]): Promise<Record<string, Attribution>> {
  if (caseIds.length === 0) return {};
  const res = await deps.pool.query(
    `select distinct on (case_id) case_id, attribution from recovery_ledger
      where tenant_id = $1 and kind = 'RECOVERY' and case_id = any($2::uuid[]) order by case_id, occurred_at, id`,
    [tenantId, caseIds],
  );
  return Object.fromEntries(res.rows.map((r) => [r.case_id as string, r.attribution as Attribution]));
}
