import type { Metadata } from 'next';
import { partsInZone } from '@recoverkit/core';
import { getDashboard, listCases } from '@recoverkit/services';
import { loadAppContext } from '@/server/context';
import { AppShell } from '@/ui/AppShell';
import { AreaChart } from '@/ui/AreaChart';
import { Banners } from '@/ui/Banners';
import { CasesTable } from '@/ui/CasesTable';
import { formatMoney, formatPercent, formatShortDate, monthLabel, sendMode } from '@/lib/format';
import { normalizeCurrency } from '@/lib/amount';
import { parsePeriod, variationNote } from '@/lib/period';

export const metadata: Metadata = { title: 'Tableau de bord' };
export const dynamic = 'force-dynamic';

function shiftMonth(year: number, month: number, delta: number) {
  const d = new Date(Date.UTC(year, month - 1 + delta, 1));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
}

export default async function DashboardPage({ searchParams }: { searchParams: Promise<{ year?: string; month?: string; currency?: string }> }) {
  const sp = await searchParams;
  const ctx = await loadAppContext();
  const nowLocal = partsInZone(ctx.now, ctx.tenant.timeZone);
  const { year, month } = parsePeriod(sp, nowLocal);
  const wantedCurrency = normalizeCurrency(sp.currency);
  const data = await getDashboard(ctx.deps, ctx.tenant.id, { year, month, currency: wantedCurrency });
  const cases = await listCases(ctx.deps, ctx.tenant.id, { pageSize: 5 });
  const currency = data.currency ?? 'EUR';
  const prev = shiftMonth(year, month, -1);
  const next = shiftMonth(year, month, 1);
  const isCurrent = year === nowLocal.y && month === nowLocal.m;
  const cur = wantedCurrency ? `&currency=${encodeURIComponent(currency)}` : '';
  const csvHref = `/api/app/export/recovered?year=${year}&month=${month}${cur}`;
  const mode = sendMode(ctx.tenant);

  return (
    <AppShell tenantName={ctx.tenant.name} active="dashboard" activeCases={ctx.activeCases} stripe={ctx.stripe} userEmail={ctx.session.email}>
      <div className="row wrap" style={{ gap: 16, justifyContent: 'space-between' }}>
        <div>
          <h1 className="page-title">Tableau de bord</h1>
          <p className="page-sub">{monthLabel(year, month)}{mode.key === 'test' ? ' · mode test : aucun email n’est envoyé' : mode.key === 'disabled' ? ' · emails désactivés : aucun email n’est envoyé' : ''}</p>
        </div>
        <div className="row wrap" style={{ gap: 12 }}>
          <nav aria-label="Période" className="row" style={{ gap: 8 }}>
            <a className="btn btn-s" href={`/app?year=${prev.year}&month=${prev.month}${cur}`} aria-label={`Mois précédent : ${monthLabel(prev.year, prev.month)}`}>←</a>
            <span className="btn btn-s" aria-current="date" style={{ pointerEvents: 'none' }}>{monthLabel(year, month)}</span>
            {isCurrent ? <span className="btn btn-s" aria-disabled="true" style={{ opacity: 0.5, pointerEvents: 'none' }}>→</span> : <a className="btn btn-s" href={`/app?year=${next.year}&month=${next.month}${cur}`} aria-label={`Mois suivant : ${monthLabel(next.year, next.month)}`}>→</a>}
          </nav>
          <a className="btn btn-s" href={csvHref}>Exporter en CSV</a>
        </div>
      </div>

      <Banners alerts={ctx.alerts} />

      {data.otherCurrencies.length > 0 ? (
        <p className="muted" style={{ fontSize: 14 }}>
          Affichage en {currency}. Autres devises :{' '}
          {data.otherCurrencies.map((c) => (
            <a key={c} href={`/app?year=${year}&month=${month}&currency=${c}`} style={{ textDecoration: 'underline', marginRight: 8 }}>{c}</a>
          ))}
        </p>
      ) : null}

      <section className="kpis" aria-label="Indicateurs du mois">
        <div className="panel kpi">
          <div className="kpi-label">Revenu récupéré</div>
          <div className="kpi-value num" style={{ color: 'var(--green)' }}>{formatMoney(data.recovered, currency)}</div>
          <div className="kpi-note">{variationNote(data.variation, isCurrent)}</div>
        </div>
        <div className="panel kpi">
          <div className="kpi-label">Clients sauvés</div>
          <div className="kpi-value num">{data.savedCustomers}</div>
          <div className="kpi-note">{data.rate.recovered + data.rate.lost > 0 ? `sur ${data.rate.recovered + data.rate.lost} dossiers clos` : 'Aucun dossier clos ce mois-ci'}</div>
        </div>
        <div className="panel kpi">
          <div className="kpi-label">Taux de récupération</div>
          <div className="kpi-value num">{formatPercent(data.rate.byCount)}</div>
          <div className="kpi-note">en nombre de clients</div>
        </div>
        <div className="panel kpi">
          <div className="kpi-label">En cours de relance (aujourd’hui)</div>
          <div className="kpi-value num" style={{ color: 'var(--amber-ink)' }}>{formatMoney(data.atRisk.amount, currency)}</div>
          <div className="kpi-note">sur {data.atRisk.count} paiement{data.atRisk.count > 1 ? 's' : ''}, au {formatShortDate(data.atRiskAsOf, ctx.tenant.timeZone)} (indépendant du mois affiché)</div>
        </div>
      </section>

      {ctx.stripe !== 'ACTIVE' && data.recovered === 0 && cases.total === 0 ? (
        <section className="panel" style={{ padding: 32 }}>
          <h2 className="section-title">Commencez par connecter Stripe</h2>
          <p className="muted" style={{ margin: '8px 0 20px', maxWidth: '48em' }}>RecoverKit détecte vos paiements échoués dès que Stripe est connecté. La connexion prend une minute et n’expose aucune donnée de carte.</p>
          <a className="btn btn-p" href="/app/onboarding">Configurer RecoverKit</a>
        </section>
      ) : (
        <div className="cols">
          <section className="panel col-main" style={{ padding: 24 }} aria-labelledby="h-courbe">
            <div className="row wrap" style={{ justifyContent: 'space-between', gap: 12, marginBottom: 16 }}>
              <h2 id="h-courbe" className="section-title">Revenu récupéré, cumulé</h2>
              {data.natural > 0 ? <span className="muted" style={{ fontSize: 13 }}>{formatMoney(data.natural, currency)} payés avant tout email, non comptés</span> : null}
            </div>
            <AreaChart series={data.series} currency={currency} />
          </section>
          <section className="panel col-side stack" style={{ padding: 24 }} aria-labelledby="h-recent">
            <h2 id="h-recent" className="section-title" style={{ marginBottom: 8 }}>Dernières récupérations</h2>
            {data.recent.length === 0 ? (
              <p className="muted" style={{ padding: '16px 0' }}>Les paiements récupérés grâce à vos relances apparaîtront ici.</p>
            ) : (
              <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                {data.recent.map((r) => (
                  <li key={`${r.caseId}-${r.occurredAt.toISOString()}`} className="row" style={{ gap: 12, padding: '12px 0', borderBottom: '1px solid var(--line)' }}>
                    <span className="av" aria-hidden="true">{(r.customerName ?? '?').slice(0, 2).toUpperCase()}</span>
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <b style={{ fontWeight: 600, fontSize: 15, display: 'block' }}>{r.customerName ?? 'Client'}</b>
                      <span className="muted" style={{ fontSize: 13 }}>{formatShortDate(r.occurredAt, ctx.tenant.timeZone)}{r.afterEmail ? `, après l’email ${r.afterEmail}` : ', via le lien de paiement'}</span>
                    </span>
                    <b className="num" style={{ color: 'var(--green)' }}>+{formatMoney(r.amount, r.currency)}</b>
                  </li>
                ))}
              </ul>
            )}
            <div style={{ flex: 1 }} />
            <a className="btn btn-s" href="/app/recovered" style={{ marginTop: 12 }}>Voir tous les paiements récupérés</a>
          </section>
        </div>
      )}

      <section className="panel" style={{ padding: '24px 24px 8px' }} aria-labelledby="h-cours">
        <div className="row wrap" style={{ justifyContent: 'space-between', gap: 12, marginBottom: 8 }}>
          <h2 id="h-cours" className="section-title">Paiements en cours de relance</h2>
          <a className="btn btn-s btn-sm" href="/app/cases">Tout voir</a>
        </div>
        <CasesTable rows={cases.rows} now={ctx.now} timeZone={ctx.tenant.timeZone} />
      </section>
    </AppShell>
  );
}
