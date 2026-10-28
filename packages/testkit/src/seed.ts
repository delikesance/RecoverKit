import { randomUUID } from 'node:crypto';
import type { Queryable } from '@recoverkit/db';

export async function seedTenant(
  db: Queryable,
  o: Partial<{ name: string; emailsEnabled: boolean; dryRun: boolean; timeZone: string }> = {},
): Promise<{ id: string }> {
  const res = await db.query(
    `insert into tenants (name, emails_enabled, dry_run, time_zone) values ($1, $2, $3, $4) returning id`,
    [o.name ?? `Tenant ${randomUUID().slice(0, 6)}`, o.emailsEnabled ?? true, o.dryRun ?? false, o.timeZone ?? 'Europe/Paris'],
  );
  return { id: res.rows[0].id as string };
}

export async function seedCase(
  db: Queryable,
  tenantId: string,
  o: Partial<{
    invoiceId: string;
    state: string;
    amountDue: number;
    currency: string;
    failedAt: Date;
    customerId: string;
  }> = {},
): Promise<{ id: string; invoiceId: string }> {
  const invoiceId = o.invoiceId ?? `in_${randomUUID().slice(0, 8)}`;
  const res = await db.query(
    `insert into recovery_cases (tenant_id, stripe_invoice_id, stripe_customer_id, state, amount_due, currency, failed_at)
     values ($1, $2, $3, $4, $5, $6, $7) returning id`,
    [
      tenantId,
      invoiceId,
      o.customerId ?? 'cus_1',
      o.state ?? 'RECOVERING',
      o.amountDue ?? 2900,
      o.currency ?? 'EUR',
      o.failedAt ?? new Date('2026-10-01T08:00:00Z'),
    ],
  );
  return { id: res.rows[0].id as string, invoiceId };
}

export async function seedStep(
  db: Queryable,
  caseId: string,
  tenantId: string,
  o: Partial<{ stepIndex: number; dueAt: Date; status: string; reservedAt: Date | null }> = {},
): Promise<{ id: string }> {
  const res = await db.query(
    `insert into scheduled_steps (case_id, tenant_id, step_index, due_at, status, reserved_at)
     values ($1, $2, $3, $4, $5, $6) returning id`,
    [caseId, tenantId, o.stepIndex ?? 0, o.dueAt ?? new Date('2026-10-01T09:00:00Z'), o.status ?? 'SCHEDULED', o.reservedAt ?? null],
  );
  return { id: res.rows[0].id as string };
}
