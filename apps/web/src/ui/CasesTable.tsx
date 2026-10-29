import { caseBadge, formatMoney, relativeFromNow, failureLabel, type Attribution } from '@/lib/format';
import type { CaseListRow } from '@recoverkit/services';
import { Chip } from './Chip';
import { Segments } from './Segments';

function initials(name: string | null): string {
  if (!name) return '?';
  return name.split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase();
}

export function CasesTable({ rows, now, timeZone, attributions = {}, filtered = false }: { rows: CaseListRow[]; now: Date; timeZone: string; attributions?: Record<string, Attribution>; filtered?: boolean }) {
  void timeZone;
  if (rows.length === 0 && filtered) {
    return (
      <div style={{ padding: '40px 8px', textAlign: 'center' }}>
        <p style={{ fontWeight: 600 }}>Aucun dossier ne correspond à ces filtres.</p>
        <p style={{ marginTop: 8 }}><a href="/app/cases" className="btn btn-s">Réinitialiser les filtres</a></p>
      </div>
    );
  }
  if (rows.length === 0) {
    return (
      <div style={{ padding: '40px 8px', textAlign: 'center' }}>
        <p style={{ fontWeight: 600 }}>Aucun paiement en cours de relance.</p>
        <p className="muted" style={{ marginTop: 4 }}>Quand un paiement échoue, il apparaît ici et la séquence démarre toute seule.</p>
      </div>
    );
  }
  return (
    <div className="table-wrap">
      <table className="data">
        <thead>
          <tr>
            <th scope="col">Client</th>
            <th scope="col" className="right">Montant</th>
            <th scope="col">Relance</th>
            <th scope="col">État</th>
            <th scope="col">Prochaine étape</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const badge = caseBadge({ ...r, attribution: attributions[r.id] ?? null }, now);
            return (
              <tr key={r.id}>
                <td>
                  <a href={`/app/cases/${r.id}`} className="row" style={{ gap: 12 }}>
                    <span className="av" aria-hidden="true">{initials(r.customerName)}</span>
                    <span>
                      <b style={{ fontWeight: 600, display: 'block' }}>{r.customerName ?? 'Client inconnu'}</b>
                      <span className="muted" style={{ fontSize: 13 }}>{relativeFromNow(r.failedAt, now)}{r.failureCode ? ` · ${failureLabel(r.failureCode)}` : ''}</span>
                    </span>
                  </a>
                </td>
                <td className="right num" style={{ fontWeight: 600 }}>{formatMoney(r.amount, r.currency)}</td>
                <td><Segments sent={r.stepsSent} total={r.stepsTotal} /></td>
                <td><Chip tone={badge.tone}>{badge.label}</Chip></td>
                <td style={{ color: 'var(--ink2)' }}>{r.nextDueAt ? relativeFromNow(r.nextDueAt, now) : 'Aucune'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
