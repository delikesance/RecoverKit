import { z } from 'zod';
import { logAction, withTransaction } from '@recoverkit/db';
import type { DnsRecord } from '@recoverkit/mail';
import type { Deps } from '../deps';
import { raiseAlert } from '../recovery/ops';

const FREEMAIL = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'outlook.fr', 'hotmail.com', 'hotmail.fr', 'live.com', 'msn.com',
  'yahoo.com', 'yahoo.fr', 'icloud.com', 'me.com', 'proton.me', 'protonmail.com', 'orange.fr', 'free.fr', 'sfr.fr', 'laposte.net', 'gmx.com', 'aol.com',
]);

const emailSchema = z.string().email();

export type ConfigureResult =
  | { status: 'pending'; domain: string; records: DnsRecord[] }
  | { status: 'invalid' }
  | { status: 'freemail' };

export type CheckResult =
  | { status: 'none' }
  | { status: 'pending'; records: DnsRecord[] }
  | { status: 'verified' }
  | { status: 'failed'; records: DnsRecord[] };

/** Définit l'expéditeur du tenant ; l'adresse n'est utilisée qu'après vérification du domaine (SPF/DKIM). */
export async function configureSender(
  deps: Deps,
  tenantId: string,
  input: { email: string; name: string },
): Promise<ConfigureResult> {
  const email = input.email.trim().toLowerCase();
  if (!emailSchema.safeParse(email).success) return { status: 'invalid' };
  const domain = email.split('@')[1]!;
  if (FREEMAIL.has(domain)) return { status: 'freemail' };

  const current = (await deps.pool.query(`select sender_domain, sender_domain_id from tenants where id = $1`, [tenantId])).rows[0];
  if (!current) throw new Error('Tenant introuvable');

  let domainId: string = current.sender_domain_id;
  let verified: boolean | null = null;
  let records: DnsRecord[] = [];
  if (current.sender_domain === domain && domainId) {
    const d = await deps.domains.getDomain(domainId);
    records = d.records;
    verified = d.status === 'verified';
  } else {
    if (domainId) await deps.domains.deleteDomain(domainId);
    const d = await deps.domains.createDomain(domain);
    domainId = d.id;
    records = d.records;
    verified = false;
  }

  await withTransaction(deps.pool, async (tx) => {
    await tx.query(
      `update tenants set sender_email = $2, sender_name = $3, sender_domain = $4, sender_domain_id = $5,
              sender_verified = $6 where id = $1`,
      [tenantId, email, input.name.trim() || null, domain, domainId, verified],
    );
    await logAction(tx, { tenantId, caseId: null, actor: 'user', action: 'sender.configured', details: { domain } });
  });
  return { status: 'pending', domain, records };
}

/** Interroge le fournisseur ; active l'expéditeur dès que le domaine est vérifié. */
export async function checkSenderDomain(deps: Deps, tenantId: string, opts: { trigger?: boolean } = {}): Promise<CheckResult> {
  const row = (await deps.pool.query(`select sender_domain_id, sender_verified from tenants where id = $1`, [tenantId])).rows[0];
  if (!row?.sender_domain_id) return { status: 'none' };
  if (opts.trigger) await deps.domains.verifyDomain(row.sender_domain_id);

  const d = await deps.domains.getDomain(row.sender_domain_id);
  if (d.status === 'verified') {
    if (!row.sender_verified) {
      await deps.pool.query(`update tenants set sender_verified = true where id = $1`, [tenantId]);
      await logAction(deps.pool, { tenantId, caseId: null, actor: 'system', action: 'sender.verified', details: { domain: d.name } });
    }
    return { status: 'verified' };
  }
  if (row.sender_verified) await deps.pool.query(`update tenants set sender_verified = false where id = $1`, [tenantId]);
  if (d.status === 'failed') {
    await raiseAlert(deps.pool, {
      tenantId,
      kind: 'sender_domain_failed',
      dedupeKey: `sender_domain_failed:${tenantId}`,
      message: `La vérification du domaine ${d.name} a échoué : vérifiez les enregistrements DNS.`,
    });
    return { status: 'failed', records: d.records };
  }
  return { status: 'pending', records: d.records };
}

export async function removeSender(deps: Deps, tenantId: string): Promise<void> {
  const row = (await deps.pool.query(`select sender_domain_id from tenants where id = $1`, [tenantId])).rows[0];
  if (row?.sender_domain_id) await deps.domains.deleteDomain(row.sender_domain_id);
  await deps.pool.query(
    `update tenants set sender_email = null, sender_name = null, sender_domain = null, sender_domain_id = null, sender_verified = false where id = $1`,
    [tenantId],
  );
  await logAction(deps.pool, { tenantId, caseId: null, actor: 'user', action: 'sender.removed', details: {} });
}
