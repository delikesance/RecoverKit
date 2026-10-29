import type { Metadata } from 'next';
import { partsInZone } from '@recoverkit/core';
import { listRecovered } from '@recoverkit/services';
import { loadAppContext } from '@/server/context';
import { AppShell } from '@/ui/AppShell';
import { Banners } from '@/ui/Banners';
import { Chip } from '@/ui/Chip';
import { parsePeriod } from '@/lib/period';
import { formatDateTime, formatMoney, monthLabel } from '@/lib/format';

export const metadata: Metadata = { title: 'Paiements récupérés' };
export const dynamic = 'force-dynamic';

export default async function RecoveredPage({ searchParams }: { searchParams: Promise<{ year?: string; month?: string; page?: string }> }) {
  const sp = await searchParams;
  const ctx = await loadAppContext();
  const nowLocal = partsInZone(ctx.now, ctx.tenant.timeZone);
  const { year, month } = parsePeriod(sp, nowLocal);
  const page = Math.max(Number(sp.page) || 1, 1);
  const r = await listRecovered(ctx.deps, ctx.tenant.id, { year, month, page, pageSize: 50 });
  const prev = new Date(Date.UTC(year, month - 2, 1));
  const next = new Date(Date.UTC(year, month, 1));
  const isCurrent = year === nowLocal.y && month === nowLocal.m;

  return (
    <AppShell tenantName={ctx.tenant.name} active="recovered" activeCases={ctx.activeCases} stripe={ctx.stripe} userEmail={ctx.session.email}>
      <div className="row wrap" style={{ justifyContent: 'space-between', gap: 16 }}>
        <div><h1 className="page-title">Paiements récupérés</h1><p className="page-sub">{monthLabel(year, month)} · chaque ligne correspond à une facture Stripe payée</p></div>
        <div className="row wrap" style={{ gap: 12 }}>
          <a className="btn btn-s" href={`/app/recovered?year=${prev.getUTCFullYear()}&month=${prev.getUTCMonth() + 1}`}>Mois précédent</a>
          {isCurrent ? null : <a className="btn btn-s" href={`/app/recovered?year=${next.getUTCFullYear()}&month=${next.getUTCMonth() + 1}`}>Mois suivant</a>}
          <a className="btn btn-p" href={`/api/app/export/recovered?year=${year}&month=${month}`}>Exporter en CSV</a>
        </div>
      </div>
      <Banners alerts={ctx.alerts} />
      <section className="panel" style={{ padding: '24px 24px 8px' }}>
        {r.rows.length === 0 ? (
          <div style={{ padding: '40px 8px', textAlign: 'center' }}>
            <p style={{ fontWeight: 600 }}>Aucun paiement récupéré sur cette période.</p>
            <p className="muted" style={{ marginTop: 4 }}>Les paiements qui aboutissent après une relance s’affichent ici avec la règle d’attribution appliquée.</p>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th scope="col">Date</th><th scope="col">Client</th><th scope="col">Type</th><th scope="col">Attribution</th><th scope="col" className="right">Montant</th><th scope="col">Facture</th></tr></thead>
              <tbody>
                {r.rows.map((row) => (
                  <tr key={`${row.invoiceId}-${row.kind}-${row.occurredAt.toISOString()}`}>
                    <td className="muted">{formatDateTime(row.occurredAt, ctx.tenant.timeZone)}</td>
                    <td style={{ fontWeight: 600 }}><a href={`/app/cases/${row.caseId}`}>{row.customerName ?? 'Client'}</a></td>
                    <td>{row.kind === 'RECOVERY' ? 'Récupération' : 'Ajustement'}</td>
                    <td>{row.attribution === 'ASSISTED' ? <Chip tone="success">Récupéré</Chip> : <Chip tone="neutral">Payé sans relance (non compté)</Chip>}</td>
                    <td className="right num" style={{ fontWeight: 600, color: row.amount < 0 ? 'var(--red)' : row.attribution === 'ASSISTED' ? 'var(--green)' : undefined }}>{formatMoney(row.amount, row.currency)}</td>
                    <td><a href={row.stripeInvoiceUrl} target="_blank" rel="noreferrer" style={{ textDecoration: 'underline' }}>{row.invoiceId}</a></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {r.total > 50 ? (
        <nav aria-label="Pagination" className="row" style={{ gap: 12, justifyContent: 'center' }}>
          {page > 1 ? <a className="btn btn-s" href={`/app/recovered?year=${year}&month=${month}&page=${page - 1}`}>Précédent</a> : null}
          <span className="muted">Page {page} sur {Math.ceil(r.total / 50)}</span>
          {page * 50 < r.total ? <a className="btn btn-s" href={`/app/recovered?year=${year}&month=${month}&page=${page + 1}`}>Suivant</a> : null}
        </nav>
      ) : null}
    </AppShell>
  );
}
