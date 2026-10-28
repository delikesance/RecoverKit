import { signUnsubscribe, verifyUnsubscribe } from '@recoverkit/core';
import { logAction, withTransaction } from '@recoverkit/db';
import type { Deps } from '../deps';

export function buildUnsubscribeUrl(deps: Deps, tenantId: string, email: string): string {
  const url = new URL(`${deps.config.appUrl}/api/unsubscribe`);
  url.searchParams.set('t', tenantId);
  url.searchParams.set('e', Buffer.from(email.trim().toLowerCase()).toString('base64url'));
  url.searchParams.set('s', signUnsubscribe(deps.config.tokenSecret, tenantId, email));
  return url.toString();
}

export async function unsubscribe(
  deps: Deps,
  p: { tenantId: string; email: string; signature: string },
): Promise<{ status: 'unsubscribed' } | { status: 'invalid' }> {
  if (!verifyUnsubscribe(deps.config.tokenSecret, p.tenantId, p.email, p.signature)) return { status: 'invalid' };
  const email = p.email.trim().toLowerCase();
  await withTransaction(deps.pool, async (tx) => {
    await tx.query(
      `insert into suppressions (tenant_id, email, reason, created_at) values ($1,$2,'UNSUBSCRIBED',$3) on conflict do nothing`,
      [p.tenantId, email, deps.clock.now()],
    );
    const canceled = await tx.query(
      `update scheduled_steps s set status = 'CANCELED', skip_reason = 'unsubscribed'
         from recovery_cases c join end_customers e on e.id = c.end_customer_id
        where s.case_id = c.id and s.tenant_id = $1 and s.status = 'SCHEDULED' and lower(e.email) = $2`,
      [p.tenantId, email],
    );
    await logAction(tx, { tenantId: p.tenantId, caseId: null, actor: 'customer', action: 'customer.unsubscribed', details: { canceledSteps: canceled.rowCount ?? 0 } });
  });
  return { status: 'unsubscribed' };
}
