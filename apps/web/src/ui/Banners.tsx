import type { BannerAlert } from '@recoverkit/services';

export function Banners({ alerts }: { alerts: BannerAlert[] }) {
  if (alerts.length === 0) return null;
  return (
    <div className="stack" style={{ gap: 12 }}>
      {alerts.map((a) => {
        const body = a.href ? <a href={a.href} className="grow">{a.message}</a> : <span className="grow">{a.message}</span>;
        return (
          <div key={`${a.kind}-${a.message}`} className={`banner banner-${a.severity}`} role={a.severity === 'critical' ? 'alert' : 'status'}>
            {body}
          </div>
        );
      })}
    </div>
  );
}
