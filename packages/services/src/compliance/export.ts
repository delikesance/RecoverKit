import { logAction } from '@recoverkit/db';
import type { Deps } from '../deps';

/** Export complet des données d'un tenant (sans secrets : ni hash de token, ni sessions). */
export async function exportTenantData(deps: Deps, tenantId: string, o: { actor?: string } = {}) {
  const q = async (sql: string) => (await deps.pool.query(sql, [tenantId])).rows;
  const tenant = (await q(`select id, name, time_zone, locale, support_email, sender_name, sender_email, reply_to, send_start_hour, send_end_hour, emails_enabled, dry_run, digest_enabled, created_at from tenants where id = $1`))[0];
  if (!tenant) throw new Error('Tenant introuvable');
  const data = {
    exportedAt: deps.clock.now().toISOString(),
    tenant,
    customers: await q(`select stripe_customer_id, email, name, locale, created_at from end_customers where tenant_id = $1 order by created_at`),
    cases: await q(`select * from recovery_cases where tenant_id = $1 order by failed_at`),
    steps: await q(`select case_id, step_index, due_at, status, skip_reason, sent_at from scheduled_steps where tenant_id = $1 order by due_at`),
    emails: await q(`select case_id, step_index, to_email, subject, status, dry_run, sent_at, delivered_at, opened_at, clicked_at from email_messages where tenant_id = $1 order by sent_at`),
    attempts: await q(`select case_id, payment_method_id, status, error_code, source, created_at from payment_attempts where tenant_id = $1 order by created_at`),
    ledger: await q(`select case_id, invoice_id, kind, attribution, amount, currency, occurred_at from recovery_ledger where tenant_id = $1 order by id`),
    actions: await q(`select case_id, actor, action, details, created_at from action_log where tenant_id = $1 order by id`),
    sequences: await q(`select version, steps, created_at from sequences where tenant_id = $1 order by version`),
    templates: await q(`select step_index, locale, subject, body from email_templates where tenant_id = $1`),
    suppressions: await q(`select email, reason, created_at from suppressions where tenant_id = $1`),
    users: await q(`select email, created_at from users where tenant_id = $1`),
    stripeConnections: await q(`select stripe_account_id, status, created_at from stripe_connections where tenant_id = $1`),
    billing: await q(`select * from billing_subscriptions where tenant_id = $1`),
    digests: await q(`select * from digests where tenant_id = $1`),
  };
  await logAction(deps.pool, { tenantId, caseId: null, actor: o.actor ?? 'user', action: 'tenant.exported', details: { at: data.exportedAt } });
  return data;
}
