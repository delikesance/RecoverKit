import { getBannerAlerts, type BannerAlert, type Deps, type SessionIdentity } from '@recoverkit/services';
import { getDeps } from './runtime';
import { requireSession } from './session';

export interface AppContext {
  deps: Deps;
  session: SessionIdentity;
  tenant: { id: string; name: string; timeZone: string; locale: 'fr' | 'en'; dryRun: boolean; emailsEnabled: boolean; supportEmail: string | null; replyTo: string | null; sendStartHour: number; sendEndHour: number; digestEnabled: boolean; senderEmail: string | null; senderName: string | null; senderVerified: boolean };
  stripe: 'PENDING' | 'ACTIVE' | 'REVOKED' | null;
  activeCases: number;
  alerts: BannerAlert[];
  now: Date;
}

/** Contexte commun de l'espace fondateur : session obligatoire, tenant, état Stripe, alertes. */
export async function loadAppContext(): Promise<AppContext> {
  const deps = getDeps();
  const session = await requireSession();
  const t = (await deps.pool.query(`select * from tenants where id = $1`, [session.tenantId])).rows[0];
  const conn = (await deps.pool.query(`select status from stripe_connections where tenant_id = $1`, [session.tenantId])).rows[0];
  const active = (await deps.pool.query(`select count(*)::int n from recovery_cases where tenant_id = $1 and state in ('OPEN','RECOVERING','PAUSED')`, [session.tenantId])).rows[0].n as number;
  return {
    deps,
    session,
    tenant: {
      id: t.id,
      name: t.name,
      timeZone: t.time_zone,
      locale: t.locale,
      dryRun: t.dry_run,
      emailsEnabled: t.emails_enabled,
      supportEmail: t.support_email,
      replyTo: t.reply_to,
      sendStartHour: t.send_start_hour,
      sendEndHour: t.send_end_hour,
      digestEnabled: t.digest_enabled,
      senderEmail: t.sender_email,
      senderName: t.sender_name,
      senderVerified: t.sender_verified,
    },
    stripe: conn?.status ?? null,
    activeCases: active,
    alerts: await getBannerAlerts(deps, session.tenantId),
    now: deps.clock.now(),
  };
}
