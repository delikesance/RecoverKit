import type { SequenceStep } from '@recoverkit/core';
import { logAction } from '@recoverkit/db';
import type { Deps } from '../deps';

export const MAX_STEPS = 6;
export const MIN_DELAY_MINUTES = 60;
export const MAX_DELAY_MINUTES = 60 * 1440;

export async function getSequence(deps: Deps, tenantId: string): Promise<{ version: number; steps: SequenceStep[] } | null> {
  const res = await deps.pool.query(`select version, steps from sequences where tenant_id = $1 order by version desc limit 1`, [tenantId]);
  return res.rows[0] ? { version: res.rows[0].version, steps: res.rows[0].steps } : null;
}

export function validateSequence(steps: readonly { delayMinutes: number; active: boolean }[]): string[] {
  const errors: string[] = [];
  if (steps.length < 1) errors.push('La séquence doit contenir au moins une étape.');
  if (steps.length > MAX_STEPS) errors.push(`Une séquence contient au plus ${MAX_STEPS} étapes.`);
  if (steps.some((s) => !Number.isInteger(s.delayMinutes) || s.delayMinutes < MIN_DELAY_MINUTES)) {
    errors.push('Le délai minimal est de 1 heure après l’échec.');
  }
  if (steps.some((s) => s.delayMinutes > MAX_DELAY_MINUTES)) errors.push('Le délai maximal est de 60 jours.');
  for (let i = 1; i < steps.length; i++) {
    if (steps[i]!.delayMinutes <= steps[i - 1]!.delayMinutes) {
      errors.push('Les délais doivent être strictement croissants.');
      break;
    }
  }
  if (steps.length > 0 && !steps.some((s) => s.active)) errors.push('Au moins une étape doit être active.');
  return errors;
}

/** Enregistre une nouvelle version : seuls les nouveaux dossiers l'utilisent. */
export async function saveSequence(
  deps: Deps,
  tenantId: string,
  steps: readonly { delayMinutes: number; active: boolean }[],
  actor = 'user',
): Promise<{ status: 'ok'; version: number } | { status: 'invalid'; errors: string[] }> {
  const errors = validateSequence(steps);
  if (errors.length > 0) return { status: 'invalid', errors };
  const indexed = steps.map((s, i) => ({ index: i, delayMinutes: s.delayMinutes, active: s.active }));
  const res = await deps.pool.query(
    `insert into sequences (tenant_id, version, steps)
     select $1, coalesce(max(version), 0) + 1, $2::jsonb from sequences where tenant_id = $1
     returning version`,
    [tenantId, JSON.stringify(indexed)],
  );
  const version = res.rows[0].version as number;
  await logAction(deps.pool, { tenantId, caseId: null, actor, action: 'sequence.saved', details: { version, steps: indexed.length } });
  return { status: 'ok', version };
}
