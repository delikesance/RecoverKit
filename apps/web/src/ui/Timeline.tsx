import { actionLabel, formatDateTime } from '@/lib/format';

export interface TimelineEvent {
  action: string;
  actor: string;
  details: Record<string, unknown>;
  at: Date;
}

export function Timeline({
  events,
  timeZone,
  upcoming = [],
}: {
  events: TimelineEvent[];
  timeZone: string;
  upcoming?: { label: string; at: Date }[];
}) {
  const past = [...events].sort((a, b) => b.at.getTime() - a.at.getTime());
  return (
    <ol className="timeline">
      {upcoming.map((u) => (
        <li key={`up-${u.label}-${u.at.toISOString()}`}>
          <div className="rail"><i style={{ background: '#b54708' }} /><s /></div>
          <div className="body"><b>{u.label}</b><span className="muted" style={{ display: 'block', fontSize: 14 }}>{formatDateTime(u.at, timeZone)}, si la facture est toujours impayée.</span></div>
        </li>
      ))}
      {past.map((e, i) => (
        <li key={`${e.action}-${e.at.toISOString()}-${i}`}>
          <div className="rail"><i style={e.action.startsWith('retry.failed') || e.action === 'case.lost' ? { background: 'var(--red)' } : undefined} /><s /></div>
          <div className="body"><b>{actionLabel(e.action, e.details)}</b><span className="muted" style={{ display: 'block', fontSize: 14 }}>{formatDateTime(e.at, timeZone)}</span></div>
        </li>
      ))}
    </ol>
  );
}
