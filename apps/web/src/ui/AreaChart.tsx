import { buildAreaChart } from '@/lib/chart';
import { formatMoney, formatShortDate } from '@/lib/format';

const W = 600;
const H = 200;

export function AreaChart({ series, currency }: { series: { date: string; cumulative: number }[]; currency: string }) {
  const last = series.at(-1);
  if (!last || last.cumulative === 0) {
    return <p className="muted" style={{ padding: '48px 0', textAlign: 'center' }}>Aucun paiement récupéré pour l’instant. Les montants apparaîtront ici dès le premier paiement.</p>;
  }
  const chart = buildAreaChart(series, { width: W, height: H, padding: 12 });
  const label = `Courbe cumulée du revenu récupéré, de ${formatMoney(0, currency)} à ${formatMoney(last.cumulative, currency)}`;
  const day = (iso: string) => formatShortDate(new Date(`${iso}T12:00:00Z`), 'UTC');
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ display: 'block', width: '100%', height: 200 }} role="img" aria-label={label}>
        <g stroke="#e4e7ec" strokeWidth="1" vectorEffect="non-scaling-stroke">
          {chart.gridY.map((y) => (
            <line key={y} x1="0" y1={y} x2={W} y2={y} vectorEffect="non-scaling-stroke" />
          ))}
        </g>
        <path d={chart.area} fill="#ddf4e9" />
        <path d={chart.line} fill="none" stroke="#0b7a55" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="row muted" style={{ justifyContent: 'space-between', fontSize: 13, marginTop: 8 }}>
        <span>{day(series[0]!.date)}</span>
        <span>{day(last.date)}</span>
      </div>
    </div>
  );
}
