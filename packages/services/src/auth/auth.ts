import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { DEFAULT_SEQUENCE, hashToken } from '@recoverkit/core';
import { hitRateLimit, withTransaction } from '@recoverkit/db';
import type { Deps } from '../deps';
import { SESSION_TTL_SECONDS } from './http';

const LOGIN_TTL_MS = 15 * 60_000;
const emailSchema = z.string().email();

export type RequestLinkResult = { status: 'sent' } | { status: 'invalid' } | { status: 'rate_limited' };

export async function requestLoginLink(
  deps: Deps,
  rawEmail: string,
  ctx: { ip: string },
): Promise<RequestLinkResult> {
  const email = rawEmail.trim().toLowerCase();
  if (!emailSchema.safeParse(email).success) return { status: 'invalid' };

  const now = deps.clock.now();
  const byEmail = await hitRateLimit(deps.pool, `login:email:${email}`, { limit: 5, windowSeconds: 3600 }, now);
  const byIp = await hitRateLimit(deps.pool, `login:ip:${ctx.ip}`, { limit: 20, windowSeconds: 3600 }, now);
  if (!byEmail.allowed || !byIp.allowed) return { status: 'rate_limited' };

  const token = randomBytes(32).toString('base64url');
  const hash = hashToken(token);
  await deps.pool.query(`insert into login_tokens (token_hash, email, expires_at) values ($1, $2, $3)`, [
    hash,
    email,
    new Date(now.getTime() + LOGIN_TTL_MS),
  ]);

  const link = `${deps.config.appUrl}/auth/verify?token=${token}`;
  await deps.mailer.send({
    to: email,
    from: { name: 'RecoverKit', email: deps.config.systemFromEmail },
    subject: 'Votre lien de connexion RecoverKit',
    text: `Bonjour,\n\nConnectez-vous à RecoverKit avec ce lien (valable 15 minutes, à usage unique) :\n${link}\n\nSi vous n'êtes pas à l'origine de cette demande, ignorez cet email.`,
    html: `<p>Bonjour,</p><p>Connectez-vous à RecoverKit avec ce lien (valable 15 minutes, à usage unique) :</p><p><a href="${link}">Se connecter</a></p><p>Si vous n'êtes pas à l'origine de cette demande, ignorez cet email.</p>`,
    idempotencyKey: `login:${hash}`,
  });
  return { status: 'sent' };
}

export type ConsumeResult =
  | { status: 'ok'; sessionToken: string; tenantId: string; userId: string; email: string; isNew: boolean }
  | { status: 'invalid' };

export async function consumeLoginLink(deps: Deps, token: string): Promise<ConsumeResult> {
  const now = deps.clock.now();
  const hash = hashToken(token);

  return withTransaction(deps.pool, async (tx) => {
    const used = await tx.query(
      `update login_tokens set used_at = $2 where token_hash = $1 and used_at is null and expires_at > $2 returning email`,
      [hash, now],
    );
    if (used.rowCount !== 1) return { status: 'invalid' } as const;
    const email = used.rows[0].email as string;

    await tx.query('select pg_advisory_xact_lock(hashtext($1))', [`user:${email}`]);
    const existing = await tx.query(`select id, tenant_id from users where lower(email) = $1`, [email]);
    let userId: string;
    let tenantId: string;
    let isNew = false;
    if (existing.rowCount === 1) {
      userId = existing.rows[0].id;
      tenantId = existing.rows[0].tenant_id;
    } else {
      isNew = true;
      const t = await tx.query(`insert into tenants (name) values ($1) returning id`, ['Mon entreprise']);
      tenantId = t.rows[0].id;
      const u = await tx.query(`insert into users (tenant_id, email) values ($1, $2) returning id`, [tenantId, email]);
      userId = u.rows[0].id;
      await tx.query(`insert into sequences (tenant_id, version, steps) values ($1, 1, $2::jsonb)`, [
        tenantId,
        JSON.stringify(DEFAULT_SEQUENCE),
      ]);
    }

    const sessionToken = randomBytes(32).toString('base64url');
    await tx.query(
      `insert into sessions (user_id, tenant_id, token_hash, created_at, last_seen_at, expires_at) values ($1,$2,$3,$4,$4,$5)`,
      [userId, tenantId, hashToken(sessionToken), now, new Date(now.getTime() + SESSION_TTL_SECONDS * 1000)],
    );
    return { status: 'ok', sessionToken, tenantId, userId, email, isNew } as const;
  });
}

export interface SessionIdentity {
  sessionId: string;
  userId: string;
  tenantId: string;
  email: string;
}

/** Valide la session et prolonge sa durée (glissante, 30 jours). */
export async function getSession(deps: Deps, sessionToken: string): Promise<SessionIdentity | null> {
  if (!sessionToken) return null;
  const now = deps.clock.now();
  const res = await deps.pool.query(
    `select s.id, s.user_id, s.tenant_id, s.last_seen_at, u.email
       from sessions s join users u on u.id = s.user_id
      where s.token_hash = $1 and s.revoked_at is null and s.expires_at > $2`,
    [hashToken(sessionToken), now],
  );
  const row = res.rows[0];
  if (!row) return null;
  if (now.getTime() - new Date(row.last_seen_at).getTime() > 5 * 60_000) {
    await deps.pool.query(`update sessions set last_seen_at = $2, expires_at = $3 where id = $1`, [
      row.id,
      now,
      new Date(now.getTime() + SESSION_TTL_SECONDS * 1000),
    ]);
  }
  return { sessionId: row.id, userId: row.user_id, tenantId: row.tenant_id, email: row.email };
}

export async function revokeSession(deps: Deps, sessionToken: string): Promise<void> {
  await deps.pool.query(`update sessions set revoked_at = $2 where token_hash = $1 and revoked_at is null`, [
    hashToken(sessionToken),
    deps.clock.now(),
  ]);
}
