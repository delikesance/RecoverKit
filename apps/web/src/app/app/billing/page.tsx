import type { Metadata } from 'next';
import { getBillingStatus } from '@recoverkit/services';
import { loadAppContext } from '@/server/context';
import { readFlash } from '@/server/flash';
import { AppShell } from '@/ui/AppShell';
import { Banners } from '@/ui/Banners';
import { Chip } from '@/ui/Chip';
import { Flash } from '@/ui/Flash';
import { FlashClear } from '@/ui/FlashClear';
import { formatDateTime, formatMoney } from '@/lib/format';
import { openPortalAction, startCheckoutAction } from '../actions';

export const metadata: Metadata = { title: 'Abonnement' };
export const dynamic = 'force-dynamic';

const STATE: Record<string, { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral' | 'info' }> = {
  TRIALING: { label: 'Essai gratuit', tone: 'info' },
  TRIAL_ENDED: { label: 'Essai terminé', tone: 'danger' },
  ACTIVE: { label: 'Abonnement actif', tone: 'success' },
  PAST_DUE: { label: 'Paiement en échec', tone: 'danger' },
  CANCELED: { label: 'Abonnement annulé', tone: 'neutral' },
};

export default async function BillingPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const sp = await searchParams;
  const flash = await readFlash('/app/billing');
  const ctx = await loadAppContext();
  const b = await getBillingStatus(ctx.deps, ctx.tenant.id);
  const plans = ctx.deps.config.plans;
  const state = STATE[b.state] ?? { label: b.state, tone: 'neutral' as const };

  return (
    <AppShell tenantName={ctx.tenant.name} active="billing" activeCases={ctx.activeCases} stripe={ctx.stripe} userEmail={ctx.session.email}>
      <div><h1 className="page-title">Abonnement</h1><p className="page-sub">Votre abonnement RecoverKit.</p></div>
      <Banners alerts={ctx.alerts} />
      <Flash error={flash?.error} />
      {flash ? <FlashClear /> : null}
      {sp.status === 'success' ? <div className="banner banner-info" role="status"><span className="grow">Merci ! Votre abonnement est en cours d’activation.</span></div> : null}
      {!b.enabled ? (
        <section className="panel" style={{ padding: 24 }}><p>La facturation n’est pas activée sur cette installation : toutes les fonctionnalités sont disponibles sans abonnement.</p></section>
      ) : (
        <>
          <section className="panel" style={{ padding: 24 }} aria-labelledby="h-etat">
            <div className="row wrap" style={{ justifyContent: 'space-between', gap: 16 }}>
              <div>
                <h2 id="h-etat" className="section-title">État</h2>
                <div style={{ marginTop: 8 }}><Chip tone={state.tone}>{state.label}</Chip></div>
              </div>
              {b.state === 'ACTIVE' || b.state === 'PAST_DUE' || b.state === 'CANCELED' ? <form action={openPortalAction}><button className="btn btn-s" type="submit">Gérer mon abonnement et ma carte</button></form> : null}
            </div>
            <div style={{ marginTop: 16 }}>
              {b.trialEndsAt ? <div className="kv"><span>Fin de l’essai</span><b style={{ fontWeight: 600 }}>{formatDateTime(b.trialEndsAt, ctx.tenant.timeZone)}</b></div> : null}
              {b.plan ? <div className="kv"><span>Palier</span><b style={{ fontWeight: 600 }}>{plans.find((p) => p.key === b.plan)?.name ?? b.plan}</b></div> : null}
              {b.currentPeriodEnd ? <div className="kv"><span>{b.cancelAtPeriodEnd ? 'Fin de l’abonnement' : 'Prochain renouvellement'}</span><b style={{ fontWeight: 600 }}>{formatDateTime(b.currentPeriodEnd, ctx.tenant.timeZone)}</b></div> : null}
              {b.mrr ? <div className="kv"><span>Revenu mensuel récurrent détecté</span><b style={{ fontWeight: 600 }}>{formatMoney(b.mrr.amount, b.mrr.currency)}</b></div> : null}
            </div>
            {b.cancelAtPeriodEnd ? <p className="hint">L’annulation prendra effet à la fin de la période payée : vos relances continuent jusque-là, et vos données restent exportables.</p> : null}
          </section>

          <section aria-labelledby="h-paliers">
            <h2 id="h-paliers" className="section-title" style={{ marginBottom: 16 }}>Paliers</h2>
            <div className="kpis">
              {plans.map((p) => (
                <div key={p.key} className="panel stack" style={{ flex: '1 1 260px', padding: 24, gap: 8, borderWidth: b.plan === p.key ? 2 : 1, borderColor: b.plan === p.key ? 'var(--blue)' : undefined }}>
                  <div className="row" style={{ justifyContent: 'space-between' }}><b>{p.name}</b>{b.plan === p.key ? <Chip tone="info">Votre palier</Chip> : null}</div>
                  <div className="kpi-value num" style={{ marginTop: 0 }}>{formatMoney(p.monthlyPrice, 'EUR')}<span className="muted" style={{ fontSize: 16, fontWeight: 500, letterSpacing: 0 }}> par mois</span></div>
                  <p className="muted" style={{ flex: 1 }}>{p.maxMrr === null ? 'Sans limite de revenu mensuel récurrent' : `Jusqu’à ${formatMoney(p.maxMrr, 'EUR')} de revenu mensuel récurrent`}</p>
                  {b.plan === p.key && b.state === 'ACTIVE' ? null : (
                    <form action={startCheckoutAction}><input type="hidden" name="plan" value={p.key} /><button type="submit" className="btn btn-p" style={{ width: '100%' }}>Choisir ce palier</button></form>
                  )}
                </div>
              ))}
            </div>
          </section>
        </>
      )}
    </AppShell>
  );
}
