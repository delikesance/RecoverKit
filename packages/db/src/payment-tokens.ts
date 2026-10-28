import type { Queryable } from './queryable';

export interface PaymentTokenRow {
  id: string;
  caseId: string;
  tenantId: string;
  tokenHash: string;
  expiresAt: Date;
  firstOpenedAt: Date | null;
  usedAt: Date | null;
  revokedAt: Date | null;
}

function map(r: any): PaymentTokenRow {
  return {
    id: r.id,
    caseId: r.case_id,
    tenantId: r.tenant_id,
    tokenHash: r.token_hash,
    expiresAt: r.expires_at,
    firstOpenedAt: r.first_opened_at,
    usedAt: r.used_at,
    revokedAt: r.revoked_at,
  };
}

/** Ne stocke que le hash du token. Un seul token actif par dossier (index partiel unique). */
export async function storePaymentToken(
  db: Queryable,
  t: { tenantId: string; caseId: string; tokenHash: string; expiresAt: Date },
): Promise<void> {
  await db.query(
    `insert into payment_tokens (tenant_id, case_id, token_hash, expires_at) values ($1,$2,$3,$4)`,
    [t.tenantId, t.caseId, t.tokenHash, t.expiresAt],
  );
}

export async function findPaymentTokenByHash(db: Queryable, tokenHash: string): Promise<PaymentTokenRow | null> {
  const res = await db.query(`select * from payment_tokens where token_hash = $1`, [tokenHash]);
  return res.rows[0] ? map(res.rows[0]) : null;
}
