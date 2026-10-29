import { insertInboxEvent } from '@recoverkit/db';
import type { InvoiceData } from '@recoverkit/stripe';
import type { Deps } from '../deps';

const PAGE_SIZE = 500;

/** Date réelle du dernier échec si la facture la fournit (défensif : absente du contrat de base). */
function failureDate(inv: Pick<InvoiceData, 'id'>): Date | null {
  const d = (inv as { failedAt?: unknown }).failedAt;
  return d instanceof Date && Number.isFinite(d.getTime()) ? d : null;
}

function syntheticEvent(deps: Deps, account: string, type: string, inv: Pick<InvoiceData, 'id'>) {
  const now = deps.clock.now();
  const failedAt = type === 'invoice.payment_failed' ? failureDate(inv) : null;
  return {
    id: `reconcile:${type}:${inv.id}:${now.toISOString().slice(0, 10)}`,
    type,
    account,
    created: Math.floor((failedAt ?? now).getTime() / 1000),
    data: { object: { id: inv.id, object: 'invoice' } },
    reconciled: true,
  };
}

async function emit(deps: Deps, tenantId: string, account: string, type: string, inv: Pick<InvoiceData, 'id'>): Promise<boolean> {
  const evt = syntheticEvent(deps, account, type, inv);
  const r = await insertInboxEvent(deps.pool, {
    stripeEventId: evt.id,
    accountId: account,
    tenantId,
    type,
    payload: evt,
    status: 'pending',
    receivedAt: deps.clock.now(),
  });
  return r === 'inserted';
}

/**
 * Compare Stripe et la base : rattrape les webhooks perdus en injectant des événements synthétiques
 * (traités par les mêmes gestionnaires, donc avec les mêmes garanties).
 */
export async function reconcileTenant(deps: Deps, tenantId: string): Promise<{ opened: number; closed: number }> {
  const conn = (await deps.pool.query(
    `select c.stripe_account_id from stripe_connections c join tenants t on t.id = c.tenant_id
      where c.tenant_id = $1 and c.status = 'ACTIVE' and t.status = 'ACTIVE'`,
    [tenantId],
  )).rows[0];
  if (!conn) return { opened: 0, closed: 0 };
  const account: string = conn.stripe_account_id;

  const open = await deps.stripe.listOpenInvoices(account);
  const openIds = new Set(open.map((i) => i.id));
  const known = new Set(
    (await deps.pool.query(`select stripe_invoice_id from recovery_cases where tenant_id = $1`, [tenantId])).rows.map((r) => r.stripe_invoice_id as string),
  );

  let opened = 0;
  for (const inv of open) {
    if (!inv.subscriptionId || inv.attemptCount < 1 || known.has(inv.id)) continue;
    // la liste n'expand pas le PaymentIntent (limite de profondeur Stripe) : on relit la facture pour le code et la date d'échec
    const detailed = await deps.stripe.retrieveInvoice(account, inv.id);
    if (await emit(deps, tenantId, account, 'invoice.payment_failed', detailed)) opened++;
  }

  let closed = 0;
  // Pagination par curseur (failed_at, id) : tous les dossiers actifs sont comparés à Stripe, pas seulement les plus anciens.
  let cursor: { failedAt: Date; id: string } | null = null;
  for (;;) {
    const page: { rows: any[] } = await deps.pool.query(
      `select id, failed_at, stripe_invoice_id from recovery_cases
        where tenant_id = $1 and state in ('OPEN','RECOVERING','PAUSED')
          and ($2::timestamptz is null or (failed_at, id) > ($2::timestamptz, $3::uuid))
        order by failed_at, id limit $4`,
      [tenantId, cursor?.failedAt ?? null, cursor?.id ?? null, PAGE_SIZE],
    );
    for (const row of page.rows) {
      const invoiceId = row.stripe_invoice_id as string;
      if (openIds.has(invoiceId)) continue;
      const inv = await deps.stripe.retrieveInvoice(account, invoiceId);
      const type = inv.status === 'paid' ? 'invoice.paid' : inv.status === 'void' ? 'invoice.voided' : inv.status === 'uncollectible' ? 'invoice.marked_uncollectible' : null;
      if (type && (await emit(deps, tenantId, account, type, inv))) closed++;
    }
    if (page.rows.length < PAGE_SIZE) break;
    const last = page.rows[page.rows.length - 1];
    cursor = { failedAt: last.failed_at, id: last.id };
  }
  return { opened, closed };
}

export async function reconcileAll(deps: Deps): Promise<{ tenants: number; opened: number; closed: number; failed: number }> {
  const tenants = await deps.pool.query(
    `select c.tenant_id from stripe_connections c join tenants t on t.id = c.tenant_id where c.status = 'ACTIVE' and t.status = 'ACTIVE'`,
  );
  const total = { tenants: tenants.rowCount ?? 0, opened: 0, closed: 0, failed: 0 };
  for (const r of tenants.rows) {
    try {
      const x = await reconcileTenant(deps, r.tenant_id);
      total.opened += x.opened;
      total.closed += x.closed;
    } catch (e) {
      total.failed++;
      deps.log.warn({ tenantId: r.tenant_id, err: (e as Error).message }, 'réconciliation Stripe impossible pour un tenant');
    }
  }
  return total;
}
