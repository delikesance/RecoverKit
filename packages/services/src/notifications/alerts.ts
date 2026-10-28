import type { Deps } from '../deps';
import { ALERT_SEVERITY } from '../dashboard/queries';

/** Envoie au fondateur un email groupé pour les alertes importantes, une seule fois par alerte. */
export async function notifyFounderAlerts(deps: Deps): Promise<{ emails: number; alerts: number }> {
  const res = await deps.pool.query(
    `select a.id, a.tenant_id, a.kind, a.message, u.email, t.name
       from system_alerts a join tenants t on t.id = a.tenant_id join users u on u.tenant_id = t.id
      where a.resolved_at is null and a.notified_at is null order by a.created_at`,
  );
  type Group = { email: string; name: string; alerts: { id: string; message: string }[] };
  const byTenant = new Map<string, Group>();
  for (const a of res.rows) {
    if (!['critical', 'warning'].includes(ALERT_SEVERITY[a.kind] ?? 'info')) continue;
    const group: Group = byTenant.get(a.tenant_id) ?? { email: a.email, name: a.name, alerts: [] };
    group.alerts.push({ id: a.id, message: a.message });
    byTenant.set(a.tenant_id, group);
  }
  let emails = 0;
  let alerts = 0;
  for (const [tenantId, g] of byTenant) {
    const list = g.alerts.map((a) => `- ${a.message}`).join('\n');
    try {
      await deps.mailer.send({
        to: g.email,
        from: { name: 'RecoverKit', email: deps.config.systemFromEmail },
        subject: `RecoverKit : ${g.alerts.length} point${g.alerts.length > 1 ? 's' : ''} à vérifier pour ${g.name}`,
        text: `Bonjour,\n\nCes points demandent votre attention :\n\n${list}\n\nOuvrez RecoverKit : ${deps.config.appUrl}/app\n`,
        html: `<p>Bonjour,</p><p>Ces points demandent votre attention :</p><ul>${g.alerts.map((a) => `<li>${a.message}</li>`).join('')}</ul><p><a href="${deps.config.appUrl}/app">Ouvrir RecoverKit</a></p>`,
        idempotencyKey: `alerts:${tenantId}:${g.alerts.map((a) => a.id).join(',')}`,
      });
      await deps.pool.query(`update system_alerts set notified_at = $2 where id = any($1)`, [g.alerts.map((a) => a.id), deps.clock.now()]);
      emails++;
      alerts += g.alerts.length;
    } catch (e) {
      deps.log.warn({ tenantId, err: (e as Error).message }, "envoi des alertes impossible");
    }
  }
  return { emails, alerts };
}
