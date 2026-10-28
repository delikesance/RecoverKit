import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getCaseDetail } from '@recoverkit/services';
import { loadAppContext } from '@/server/context';
import { AppShell } from '@/ui/AppShell';
import { Banners } from '@/ui/Banners';
import { Chip } from '@/ui/Chip';
import { Flash } from '@/ui/Flash';
import { Timeline } from '@/ui/Timeline';
import { IconBack } from '@/ui/icons';
import { failureLabel, formatDateTime, formatMoney, stateLabel } from '@/lib/format';
import { closeCaseAction, pauseCaseAction, resumeCaseAction, sendNowAction } from '../../actions';

export const metadata: Metadata = { title: 'Détail du paiement' };
export const dynamic = 'force-dynamic';

export default async function CaseDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ notice?: string }> }) {
  const { id } = await params;
  const sp = await searchParams;
  const ctx = await loadAppContext();
  const detail = /^[0-9a-f-]{36}$/i.test(id) ? await getCaseDetail(ctx.deps, ctx.tenant.id, id) : null;
  if (!detail) notFound();
  const c = detail.case;
  const state = stateLabel(c.state);
  const active = ['RECOVERING', 'PAUSED', 'OPEN'].includes(c.state);
  const name = detail.customer?.name ?? 'Client inconnu';
  const upcoming = detail.steps.filter((s) => s.status === 'SCHEDULED').slice(0, 1).map((s) => ({ label: s.stepIndex === Math.max(...detail.steps.map((x) => x.stepIndex)) ? 'Dernier avis planifié' : `Email ${s.stepIndex + 1} planifié`, at: s.dueAt }));

  return (
    <AppShell tenantName={ctx.tenant.name} active="cases" activeCases={ctx.activeCases} stripe={ctx.stripe} userEmail={ctx.session.email}>
      <a href="/app/cases" className="row muted" style={{ gap: 6, fontWeight: 500, fontSize: 14, minHeight: 44, alignSelf: 'flex-start' }}><IconBack /> Échecs en cours</a>
      <Banners alerts={ctx.alerts} />
      <Flash notice={sp.notice} />

      <div className="row wrap" style={{ gap: 20, justifyContent: 'space-between' }}>
        <div className="row" style={{ gap: 16 }}>
          <span className="av" style={{ width: 56, height: 56, fontSize: 18 }} aria-hidden="true">{name.split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase()}</span>
          <div>
            <div className="row wrap" style={{ gap: 12 }}>
              <h1 className="page-title">{name}</h1>
              <Chip tone={state.tone}>{state.label}</Chip>
            </div>
            <p className="page-sub">{detail.customer?.email ?? 'Pas d’adresse email'}{c.planName ? `, abonnement ${c.planName}` : ''}</p>
          </div>
        </div>
        {active ? (
          <div className="row wrap" style={{ gap: 12, alignItems: 'flex-start' }}>
            {c.state === 'PAUSED' ? (
              <form action={resumeCaseAction}><input type="hidden" name="caseId" value={c.id} /><button className="btn btn-s" type="submit">Reprendre les relances</button></form>
            ) : c.state === 'RECOVERING' ? (
              <form action={pauseCaseAction}><input type="hidden" name="caseId" value={c.id} /><button className="btn btn-s" type="submit">Mettre en pause</button></form>
            ) : null}
            {c.state === 'RECOVERING' ? (
              <details className="confirm">
                <summary className="btn btn-s">Envoyer le prochain email maintenant</summary>
                <form action={sendNowAction} className="confirm-box" style={{ maxWidth: 320 }}>
                  <p style={{ fontSize: 14, marginBottom: 12 }}>Le prochain email de la séquence part dans la minute, sans attendre la fenêtre d’envoi.</p>
                  <input type="hidden" name="caseId" value={c.id} />
                  <button className="btn btn-p btn-sm" type="submit">Confirmer l’envoi</button>
                </form>
              </details>
            ) : null}
            <details className="confirm">
              <summary className="btn btn-danger">Clôturer le dossier</summary>
              <form action={closeCaseAction} className="confirm-box" style={{ maxWidth: 320 }}>
                <input type="hidden" name="caseId" value={c.id} />
                <label htmlFor="reason" className="label">Motif (obligatoire)</label>
                <input id="reason" name="reason" required minLength={3} className="field" placeholder="Client contacté par téléphone" />
                <p className="hint">Les relances s’arrêtent et le lien de paiement est désactivé.</p>
                <button className="btn btn-danger btn-sm" type="submit" style={{ marginTop: 12 }}>Clôturer</button>
              </form>
            </details>
          </div>
        ) : null}
      </div>

      <div className="cols" style={{ alignItems: 'flex-start' }}>
        <section className="panel col-main" style={{ padding: 28 }} aria-labelledby="h-histo">
          <h2 id="h-histo" className="section-title">Historique des relances</h2>
          <p className="muted" style={{ fontSize: 14, margin: '4px 0 24px' }}>Chaque action est enregistrée. Aucun email n’est envoyé deux fois pour le même échec.</p>
          <Timeline events={detail.timeline} timeZone={ctx.tenant.timeZone} upcoming={active ? upcoming : []} />
          {detail.emails.length > 0 ? (
            <div style={{ marginTop: 28 }}>
              <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>Emails envoyés</h3>
              <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                {detail.emails.map((m) => (
                  <li key={`${m.stepIndex}-${m.sentAt.toISOString()}`} className="kv" style={{ alignItems: 'baseline' }}>
                    <span style={{ color: 'var(--ink)' }}>{m.subject}</span>
                    <span className="muted" style={{ whiteSpace: 'nowrap' }}>{formatDateTime(m.sentAt, ctx.tenant.timeZone)}{m.dryRun ? ' · test' : m.opened ? ' · ouvert' : ''}{m.clicked ? ' · cliqué' : ''}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </section>

        <div className="col-side stack" style={{ gap: 16 }}>
          <section className="panel" style={{ padding: 24 }} aria-labelledby="h-facture">
            <div className="row" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
              <h2 id="h-facture" style={{ fontSize: 16, fontWeight: 600 }}>Facture</h2>
              <Chip tone={c.state === 'RECOVERED' ? 'success' : 'warning'}>{c.state === 'RECOVERED' ? 'Payée' : 'Impayée'}</Chip>
            </div>
            <div className="kpi-value num" style={{ marginTop: 0, marginBottom: 12 }}>{formatMoney(c.amountDue, c.currency)}</div>
            <div className="kv"><span>Identifiant</span><b style={{ fontWeight: 600 }}>{c.stripeInvoiceId}</b></div>
            <div className="kv"><span>Tentatives</span><b style={{ fontWeight: 600 }}>{c.attemptCount}</b></div>
            <div className="kv"><span>Motif du refus</span><b style={{ fontWeight: 600 }}>{failureLabel(c.lastFailureCode)}</b></div>
            <a className="btn btn-s" href={detail.stripeInvoiceUrl} rel="noreferrer" target="_blank" style={{ width: '100%', marginTop: 8 }}>Ouvrir dans Stripe</a>
          </section>
          <section className="panel" style={{ padding: 24, background: 'var(--green-tint)', borderColor: '#b7e4cf' }}>
            <h2 style={{ fontSize: 16, fontWeight: 600, color: '#0b6b4a', marginBottom: 6 }}>Si le paiement aboutit</h2>
            <p style={{ color: '#145c41', fontSize: 15 }}>Il sera compté comme récupéré si au moins un email est parti avant. Le montant vient directement de la facture Stripe.</p>
          </section>
        </div>
      </div>
    </AppShell>
  );
}
