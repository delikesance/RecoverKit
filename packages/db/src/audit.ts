import type { Queryable } from './queryable';

export interface ActionInput {
  tenantId: string | null;
  caseId: string | null;
  actor: string;
  action: string;
  details: Record<string, unknown>;
}

export interface ActionRow {
  id: number;
  tenantId: string | null;
  caseId: string | null;
  actor: string;
  action: string;
  details: Record<string, unknown>;
  createdAt: Date;
}

export async function logAction(db: Queryable, a: ActionInput): Promise<void> {
  await db.query(
    `insert into action_log (tenant_id, case_id, actor, action, details) values ($1,$2,$3,$4,$5::jsonb)`,
    [a.tenantId, a.caseId, a.actor, a.action, JSON.stringify(a.details)],
  );
}

export async function listCaseActions(db: Queryable, tenantId: string, caseId: string): Promise<ActionRow[]> {
  const res = await db.query(
    `select * from action_log where tenant_id = $1 and case_id = $2 order by id`,
    [tenantId, caseId],
  );
  return res.rows.map((r) => ({
    id: Number(r.id),
    tenantId: r.tenant_id,
    caseId: r.case_id,
    actor: r.actor,
    action: r.action,
    details: r.details,
    createdAt: r.created_at,
  }));
}
