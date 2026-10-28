import { derivePaymentToken, hashToken, newTokenExpiry } from '@recoverkit/core';
import { withTransaction } from '@recoverkit/db';
import type { Deps } from '../deps';

export function paymentUrl(deps: Deps, token: string): string {
  return `${deps.config.appUrl}/pay/${token}`;
}

export function tokenFromUrl(url: string): string {
  return url.slice(url.lastIndexOf('/') + 1);
}

/**
 * Lien de mise à jour de paiement du dossier. Il est dérivé (HMAC) : le même lien figure dans tous les
 * emails, seul son hash est stocké, et il y a au plus un lien actif par dossier.
 */
export async function ensurePaymentLink(deps: Deps, tenantId: string, caseId: string): Promise<string> {
  const now = deps.clock.now();
  return withTransaction(deps.pool, async (tx) => {
    await tx.query(`select pg_advisory_xact_lock(hashtextextended($1, 0))`, [`paylink:${caseId}`]);
    const owner = await tx.query(`select 1 from recovery_cases where id = $1 and tenant_id = $2`, [caseId, tenantId]);
    if (owner.rowCount !== 1) throw new Error('Dossier introuvable');

    const active = await tx.query(
      `select generation, expires_at from payment_tokens where case_id = $1 and used_at is null and revoked_at is null`,
      [caseId],
    );
    const current = active.rows[0];
    if (current && new Date(current.expires_at).getTime() > now.getTime()) {
      return paymentUrl(deps, derivePaymentToken(deps.config.tokenSecret, caseId, current.generation));
    }
    if (current) {
      await tx.query(`update payment_tokens set revoked_at = $2 where case_id = $1 and used_at is null and revoked_at is null`, [caseId, now]);
    }
    const max = await tx.query(`select coalesce(max(generation), 0) as g from payment_tokens where case_id = $1`, [caseId]);
    const generation = Number(max.rows[0].g) + 1;
    const token = derivePaymentToken(deps.config.tokenSecret, caseId, generation);
    await tx.query(
      `insert into payment_tokens (case_id, tenant_id, token_hash, expires_at, generation, created_at) values ($1,$2,$3,$4,$5,$6)`,
      [caseId, tenantId, hashToken(token), newTokenExpiry(now), generation, now],
    );
    return paymentUrl(deps, token);
  });
}
