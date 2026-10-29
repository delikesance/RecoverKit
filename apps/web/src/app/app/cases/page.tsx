import type { Metadata } from 'next';
import { listCases, type CaseSort } from '@recoverkit/services';
import { loadAppContext } from '@/server/context';
import { AppShell } from '@/ui/AppShell';
import { Banners } from '@/ui/Banners';
import { CasesTable } from '@/ui/CasesTable';
import { Flash } from '@/ui/Flash';
import { parseAmountInput } from '@/lib/amount';
import { caseAttributions } from '@/lib/attribution';

export const metadata: Metadata = { title: 'Échecs en cours' };
export const dynamic = 'force-dynamic';

const STATE_FILTERS: Record<string, string[]> = {
  active: ['OPEN', 'RECOVERING', 'PAUSED'],
  recovering: ['RECOVERING'],
  paused: ['PAUSED'],
  recovered: ['RECOVERED'],
  lost: ['LOST'],
  closed: ['CANCELED', 'CLOSED_MANUAL'],
};
const SORTS: CaseSort[] = ['oldest', 'newest', 'amount_desc', 'amount_asc'];

export default async function CasesPage({ searchParams }: { searchParams: Promise<{ state?: string; sort?: string; min?: string; max?: string; page?: string }> }) {
  const sp = await searchParams;
  const ctx = await loadAppContext();
  const stateKey = sp.state && STATE_FILTERS[sp.state] ? sp.state : 'active';
  const sort = SORTS.includes(sp.sort as CaseSort) ? (sp.sort as CaseSort) : 'oldest';
  const page = Math.max(Number(sp.page) || 1, 1);
  const min = parseAmountInput(sp.min);
  const max = parseAmountInput(sp.max);
  const amountError = !min.ok ? 'Montant minimum invalide : saisissez un nombre, par exemple 12,50.' : !max.ok ? 'Montant maximum invalide : saisissez un nombre, par exemple 12,50.' : undefined;
  const result = await listCases(ctx.deps, ctx.tenant.id, {
    states: STATE_FILTERS[stateKey],
    sort,
    page,
    pageSize: 25,
    minAmount: min.ok ? min.cents : undefined,
    maxAmount: max.ok ? max.cents : undefined,
  });
  const attributions = await caseAttributions(ctx.deps, ctx.tenant.id, result.rows.filter((r) => r.state === 'RECOVERED').map((r) => r.id));
  const filtered = stateKey !== 'active' || (min.ok && min.cents !== undefined) || (max.ok && max.cents !== undefined);
  const pages = Math.max(Math.ceil(result.total / 25), 1);
  const link = (p: number) => `/app/cases?${new URLSearchParams({ state: stateKey, sort, ...(sp.min ? { min: sp.min } : {}), ...(sp.max ? { max: sp.max } : {}), page: String(p) })}`;

  return (
    <AppShell tenantName={ctx.tenant.name} active="cases" activeCases={ctx.activeCases} stripe={ctx.stripe} userEmail={ctx.session.email}>
      <div>
        <h1 className="page-title">Échecs en cours</h1>
        <p className="page-sub">{result.total} dossier{result.total > 1 ? 's' : ''}</p>
      </div>
      <Banners alerts={ctx.alerts} />
      <Flash error={amountError} />
      <form method="get" className="panel row wrap" style={{ padding: 20, gap: 16, alignItems: 'flex-end' }} aria-label="Filtres">
        <div><label htmlFor="state" className="label">État</label>
          <select id="state" name="state" className="field" defaultValue={stateKey} style={{ minWidth: 180 }}>
            <option value="active">En cours</option><option value="recovering">En relance</option><option value="paused">En pause</option>
            <option value="recovered">Récupérés</option><option value="lost">Perdus</option><option value="closed">Annulés ou clôturés</option>
          </select></div>
        <div><label htmlFor="min" className="label">Montant minimum (€)</label><input id="min" name="min" inputMode="decimal" className="field" defaultValue={sp.min} style={{ width: 160 }} /></div>
        <div><label htmlFor="max" className="label">Montant maximum (€)</label><input id="max" name="max" inputMode="decimal" className="field" defaultValue={sp.max} style={{ width: 160 }} /></div>
        <div><label htmlFor="sort" className="label">Tri</label>
          <select id="sort" name="sort" className="field" defaultValue={sort} style={{ minWidth: 200 }}>
            <option value="oldest">Plus anciens d’abord</option><option value="newest">Plus récents d’abord</option>
            <option value="amount_desc">Montant décroissant</option><option value="amount_asc">Montant croissant</option>
          </select></div>
        <button type="submit" className="btn btn-p">Filtrer</button>
      </form>
      <section className="panel" style={{ padding: '24px 24px 8px' }}>
        <CasesTable rows={result.rows} now={ctx.now} timeZone={ctx.tenant.timeZone} attributions={attributions} filtered={filtered} />
      </section>
      {pages > 1 ? (
        <nav aria-label="Pagination" className="row" style={{ gap: 12, justifyContent: 'center' }}>
          {page > 1 ? <a className="btn btn-s" href={link(page - 1)}>Précédent</a> : null}
          <span className="muted">Page {page} sur {pages}</span>
          {page < pages ? <a className="btn btn-s" href={link(page + 1)}>Suivant</a> : null}
        </nav>
      ) : null}
    </AppShell>
  );
}
