import type { Queryable } from './queryable';

export interface StepRow {
  id: string;
  caseId: string;
  tenantId: string;
  stepIndex: number;
  dueAt: Date;
  status: string;
  attempts: number;
  reservedAt: Date | null;
}

export function mapStep(r: any): StepRow {
  return {
    id: r.id,
    caseId: r.case_id,
    tenantId: r.tenant_id,
    stepIndex: r.step_index,
    dueAt: r.due_at,
    status: r.status,
    attempts: r.attempts,
    reservedAt: r.reserved_at,
  };
}

export async function insertScheduledSteps(
  db: Queryable,
  caseId: string,
  tenantId: string,
  plans: readonly { stepIndex: number; dueAt: Date }[],
): Promise<void> {
  for (const p of plans) {
    await db.query(
      `insert into scheduled_steps (case_id, tenant_id, step_index, due_at) values ($1,$2,$3,$4)
       on conflict (case_id, step_index) do nothing`,
      [caseId, tenantId, p.stepIndex, p.dueAt],
    );
  }
}

/**
 * Réserve atomiquement les étapes échues (SCHEDULED → SENDING).
 * FOR UPDATE SKIP LOCKED : deux workers ne prennent jamais la même ligne.
 * Les tenants dont les emails sont désactivés voient leurs étapes passer en SKIPPED(disabled).
 */
export async function reserveDueSteps(
  db: Queryable,
  now: Date,
  limit: number,
  opts: { tenantId?: string } = {},
): Promise<StepRow[]> {
  const tenantFilter = opts.tenantId ? 'and s.tenant_id = $3' : '';
  const params: unknown[] = [now, limit];
  if (opts.tenantId) params.push(opts.tenantId);

  await db.query(
    `update scheduled_steps s set status = 'SKIPPED', skip_reason = 'disabled'
       from tenants t
      where s.tenant_id = t.id and s.status = 'SCHEDULED' and s.due_at <= $1
        and t.emails_enabled = false ${opts.tenantId ? 'and s.tenant_id = $2' : ''}`,
    opts.tenantId ? [now, opts.tenantId] : [now],
  );

  // Tourniquet entre tenants : on classe les étapes échues par rang au sein de chaque tenant, puis on
  // verrouille (SKIP LOCKED) dans un vivier 4 fois plus large pour que les workers concurrents ne se bloquent pas.
  const res = await db.query(
    `with ranked as (
       select s.id, s.due_at,
              row_number() over (partition by s.tenant_id order by s.due_at, s.id) as rn
         from scheduled_steps s
         join recovery_cases c on c.id = s.case_id
         join tenants t on t.id = s.tenant_id
        where s.status = 'SCHEDULED' and s.due_at <= $1 and c.state = 'RECOVERING'
          and t.emails_enabled = true and t.status = 'ACTIVE' ${tenantFilter}
     ), pool as (
       select id, rn, due_at from ranked order by rn, due_at limit $2 * 4
     ), picked as (
       select s.id from scheduled_steps s join pool p on p.id = s.id
        where s.status = 'SCHEDULED'
        order by p.rn, p.due_at, s.id
        limit $2
        for update of s skip locked
     )
     update scheduled_steps s set status = 'SENDING', reserved_at = $1, attempts = s.attempts + 1
       from picked where s.id = picked.id
     returning s.*`,
    params,
  );
  return res.rows.map(mapStep);
}

/** Remet en file les réservations abandonnées (worker mort entre la réservation et l'envoi). */
export async function recoverStaleReservations(db: Queryable, now: Date, staleMs: number): Promise<StepRow[]> {
  const res = await db.query(
    `update scheduled_steps set status = 'SCHEDULED', reserved_at = null
      where status = 'SENDING' and reserved_at < $1
      returning *`,
    [new Date(now.getTime() - staleMs)],
  );
  return res.rows.map(mapStep);
}

export async function listStepsForCase(db: Queryable, tenantId: string, caseId: string): Promise<StepRow[]> {
  const res = await db.query(
    `select * from scheduled_steps where tenant_id = $1 and case_id = $2 order by step_index`,
    [tenantId, caseId],
  );
  return res.rows.map(mapStep);
}
