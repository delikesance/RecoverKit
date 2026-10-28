import { randomBytes } from 'node:crypto';
import { hashToken } from '@recoverkit/core';
import { logAction, withTransaction, type Queryable } from '@recoverkit/db';
import type { Deps } from '../deps';
import type { SessionIdentity } from '../auth/auth';

const STATE_TTL_MS = 10 * 60_000;

export interface ConnectionRow {
  tenantId: string;
  stripeAccountId: string;
  status: 'PENDING' | 'ACTIVE' | 'REVOKED';
  livemode: boolean;
  connectedAt: Date | null;
  revokedAt: Date | null;
}

function mapConnection(r: any): ConnectionRow {
  return {
    tenantId: r.tenant_id,
    stripeAccountId: r.stripe_account_id,
    status: r.status,
    livemode: r.livemode,
    connectedAt: r.connected_at,
    revokedAt: r.revoked_at,
  };
}

export async function getConnection(deps: Deps, tenantId: string): Promise<ConnectionRow | null> {
  const res = await deps.pool.query(`select * from stripe_connections where tenant_id = $1`, [tenantId]);
  return res.rows[0] ? mapConnection(res.rows[0]) : null;
}

export async function getConnectionByAccount(deps: Deps, accountId: string): Promise<ConnectionRow | null> {
  const res = await deps.pool.query(`select * from stripe_connections where stripe_account_id = $1`, [accountId]);
  return res.rows[0] ? mapConnection(res.rows[0]) : null;
}

/** URL d'autorisation Stripe ; le `state` est à usage unique, lié à la session, valable 10 minutes. */
export async function buildConnectUrl(deps: Deps, session: SessionIdentity): Promise<string> {
  const state = randomBytes(24).toString('base64url');
  await deps.pool.query(`insert into oauth_states (state_hash, session_id, expires_at) values ($1, $2, $3)`, [
    hashToken(state),
    session.sessionId,
    new Date(deps.clock.now().getTime() + STATE_TTL_MS),
  ]);
  const url = new URL('https://connect.stripe.com/oauth/authorize');
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', deps.config.stripeConnectClientId);
  url.searchParams.set('scope', 'read_write');
  url.searchParams.set('redirect_uri', `${deps.config.appUrl}/api/stripe/oauth/callback`);
  url.searchParams.set('state', state);
  return url.toString();
}

export type CallbackResult =
  | { status: 'connected'; accountId: string }
  | { status: 'invalid_state' }
  | { status: 'denied' }
  | { status: 'exchange_failed' }
  | { status: 'account_taken' };

export async function handleOAuthCallback(
  deps: Deps,
  session: SessionIdentity,
  q: { code?: string; state?: string; error?: string },
): Promise<CallbackResult> {
  const now = deps.clock.now();
  if (!q.state) return { status: 'invalid_state' };
  const claimed = await deps.pool.query(
    `update oauth_states set used_at = $3
      where state_hash = $1 and session_id = $2 and used_at is null and expires_at > $3
      returning state_hash`,
    [hashToken(q.state), session.sessionId, now],
  );
  if (claimed.rowCount !== 1) return { status: 'invalid_state' };
  if (q.error) return { status: 'denied' };
  if (!q.code) return { status: 'exchange_failed' };

  let account: { stripeUserId: string; livemode: boolean };
  try {
    account = await deps.stripe.exchangeOAuthCode(q.code);
  } catch {
    return { status: 'exchange_failed' };
  }

  return withTransaction(deps.pool, async (tx) => {
    const taken = await tx.query(
      `select tenant_id from stripe_connections where stripe_account_id = $1 and tenant_id <> $2`,
      [account.stripeUserId, session.tenantId],
    );
    if (taken.rowCount && taken.rowCount > 0) return { status: 'account_taken' } as const;

    await tx.query(
      `insert into stripe_connections (tenant_id, stripe_account_id, status, livemode, connected_at)
       values ($1, $2, 'ACTIVE', $3, $4)
       on conflict (tenant_id) do update set
         stripe_account_id = excluded.stripe_account_id, status = 'ACTIVE', livemode = excluded.livemode,
         connected_at = excluded.connected_at, revoked_at = null`,
      [session.tenantId, account.stripeUserId, account.livemode, now],
    );
    await logAction(tx, {
      tenantId: session.tenantId,
      caseId: null,
      actor: `user:${session.userId}`,
      action: 'stripe.connected',
      details: { accountId: account.stripeUserId, livemode: account.livemode },
    });
    return { status: 'connected', accountId: account.stripeUserId } as const;
  });
}

export type RevokeResult = { status: 'revoked'; tenantId: string } | { status: 'unknown_account' };

/** Révocation (webhook `account.application.deauthorized` ou déconnexion volontaire). */
export async function handleDeauthorized(deps: Deps, accountId: string, db?: Queryable): Promise<RevokeResult> {
  if (db) return revokeConnection(deps, accountId, db);
  return withTransaction(deps.pool, (tx) => revokeConnection(deps, accountId, tx));
}

async function revokeConnection(deps: Deps, accountId: string, tx: Queryable): Promise<RevokeResult> {
  const now = deps.clock.now();
  {
    const res = await tx.query(
      `update stripe_connections set status = 'REVOKED', revoked_at = $2
        where stripe_account_id = $1 returning tenant_id`,
      [accountId, now],
    );
    if (res.rowCount !== 1) return { status: 'unknown_account' } as const;
    const tenantId = res.rows[0].tenant_id as string;

    await tx.query(
      `update scheduled_steps set status = 'CANCELED', skip_reason = 'stripe_revoked'
        where tenant_id = $1 and status in ('SCHEDULED')`,
      [tenantId],
    );
    await tx.query(
      `insert into system_alerts (tenant_id, kind, dedupe_key, message)
       values ($1, 'stripe_revoked', $2, 'La connexion Stripe a été révoquée : les relances sont arrêtées.')
       on conflict do nothing`,
      [tenantId, `stripe_revoked:${tenantId}`],
    );
    await logAction(tx, { tenantId, caseId: null, actor: 'stripe', action: 'stripe.revoked', details: { accountId } });
    return { status: 'revoked', tenantId } as const;
  }
}

export async function disconnectStripe(deps: Deps, tenantId: string): Promise<void> {
  const conn = await getConnection(deps, tenantId);
  if (!conn || conn.status === 'REVOKED') return;
  await deps.stripe.deauthorize(conn.stripeAccountId);
  await handleDeauthorized(deps, conn.stripeAccountId);
}
