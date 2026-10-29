import { transitionCase } from '@recoverkit/core';
import { logAction, withTransaction } from '@recoverkit/db';
import type { Deps } from '../deps';
import { lockTenant, raiseAlert } from '../recovery/ops';
import { verifySvixSignature } from './svix';

export type ProviderResult =
  | { httpStatus: 200; status: 'processed' | 'duplicate' | 'ignored' }
  | { httpStatus: 400; status: 'rejected' }
  /** Message pas encore enregistré : le fournisseur doit réessayer (le svix-id n'est pas consommé). */
  | { httpStatus: 503; status: 'retry' };

/** Au-delà, un message introuvable est considéré comme étranger : on n'invite plus à réessayer. */
const RETRY_WINDOW_MS = 24 * 3600_000;

class RetryLater extends Error {}

/** Webhooks Resend : delivered, bounced, complained, opened, clicked. Dédoublonnés par `svix-id`. */
export async function receiveEmailProviderWebhook(
  deps: Deps,
  req: { rawBody: string; headers: { id: string | null; timestamp: string | null; signature: string | null } },
): Promise<ProviderResult> {
  const secret = deps.config.resendWebhookSecret;
  if (!secret || !verifySvixSignature(req.rawBody, req.headers, secret, deps.clock.now())) {
    return { httpStatus: 400, status: 'rejected' };
  }
  let event: { type?: string; created_at?: string; data?: { email_id?: string } };
  try {
    event = JSON.parse(req.rawBody);
  } catch {
    return { httpStatus: 400, status: 'rejected' };
  }
  const now = deps.clock.now();

  try {
    return await withTransaction(deps.pool, async (tx): Promise<ProviderResult> => {
      // Ordre de verrouillage constant (tenant d'abord) comme les autres traitements : pas d'interblocage.
      const owner = event.data?.email_id
        ? (await tx.query(`select tenant_id from email_messages where provider_message_id = $1`, [event.data.email_id])).rows[0]
        : undefined;
      if (owner) await lockTenant(tx, owner.tenant_id);
      const fresh = await tx.query(`insert into provider_events (id, received_at) values ($1, $2) on conflict do nothing returning id`, [
        req.headers.id,
        now,
      ]);
      if (fresh.rowCount !== 1) return { httpStatus: 200, status: 'duplicate' };

      const providerId = event.data?.email_id;
      const handled = ['email.delivered', 'email.bounced', 'email.complained', 'email.opened', 'email.clicked'];
      if (!providerId || !event.type || !handled.includes(event.type)) return { httpStatus: 200, status: 'ignored' };

      const found = await tx.query(
        `select id, tenant_id, case_id, to_email from email_messages where provider_message_id = $1`,
        [providerId],
      );
      const m = found.rows[0];
      if (!m) {
        // L'évènement a pu précéder l'insertion d'email_messages : on annule (svix-id libre) pour que le fournisseur rejoue.
        const sentAt = event.created_at ? new Date(event.created_at).getTime() : now.getTime();
        if (Number.isFinite(sentAt) && now.getTime() - sentAt < RETRY_WINDOW_MS) throw new RetryLater();
        return { httpStatus: 200, status: 'ignored' };
      }

      switch (event.type) {
        case 'email.delivered':
          await tx.query(`update email_messages set status = 'DELIVERED', delivered_at = $2 where id = $1 and status = 'SENT'`, [m.id, now]);
          break;
        case 'email.opened':
          await tx.query(`update email_messages set opened_at = coalesce(opened_at, $2) where id = $1`, [m.id, now]);
          break;
        case 'email.clicked':
          await tx.query(`update email_messages set clicked_at = coalesce(clicked_at, $2) where id = $1`, [m.id, now]);
          break;
        case 'email.bounced':
        case 'email.complained': {
          const bounced = event.type === 'email.bounced';
          await tx.query(`update email_messages set status = $2 where id = $1`, [m.id, bounced ? 'BOUNCED' : 'COMPLAINED']);
          await tx.query(
            `insert into suppressions (tenant_id, email, reason, created_at) values ($1, lower($2), $3, $4) on conflict do nothing`,
            [m.tenant_id, m.to_email, bounced ? 'BOUNCED' : 'COMPLAINED', now],
          );
          if (bounced) {
            await raiseAlert(tx, {
              tenantId: m.tenant_id,
              kind: 'email_bounced',
              dedupeKey: `email_bounced:${m.id}`,
              message: `Un email de relance n'a pas pu être remis (adresse invalide ou boîte pleine).`,
            });
          } else {
            const c = await tx.query(`select state from recovery_cases where id = $1`, [m.case_id]);
            if (c.rows[0]?.state === 'RECOVERING') {
              await tx.query(`update recovery_cases set state = $2, updated_at = $3 where id = $1 and state = 'RECOVERING'`, [m.case_id, transitionCase('RECOVERING', 'PAUSE'), now]);
            }
          }
          await logAction(tx, { tenantId: m.tenant_id, caseId: m.case_id, actor: 'email-provider', action: `email.${bounced ? 'bounced' : 'complained'}`, details: { providerId } });
          break;
        }
      }
      return { httpStatus: 200, status: 'processed' };
    });
  } catch (e) {
    if (e instanceof RetryLater) return { httpStatus: 503, status: 'retry' };
    throw e;
  }
}
