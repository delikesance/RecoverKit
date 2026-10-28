import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { payMessage, resolvePaymentLink } from '@recoverkit/services';
import { PayForm } from '@/ui/pay/PayForm';
import { PayCard } from '@/ui/pay/PayCard';
import { getDeps } from '@/server/runtime';

export const metadata: Metadata = { title: 'Mettre à jour votre paiement', robots: { index: false, follow: false } };
export const dynamic = 'force-dynamic';

export default async function PayPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const h = await headers();
  const ip = h.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  const r = await resolvePaymentLink(getDeps(), token, { ip });

  if (r.status !== 'ok') {
    const key = r.status === 'paid' ? 'paid' : r.status === 'rate_limited' ? 'rate_limited' : 'unavailable';
    const m = payMessage(key, 'fr');
    const en = payMessage(key, 'en');
    return (
      <PayCard>
        <h1 className="page-title" style={{ fontSize: 26 }}>{m.title}</h1>
        <p className="muted" style={{ marginTop: 12 }}>{m.body}</p>
        <p className="muted" lang="en" style={{ marginTop: 16, fontSize: 14 }}>{en.title} {en.body}</p>
      </PayCard>
    );
  }

  const { view } = r;
  const m = payMessage('form', view.locale);
  return (
    <PayCard tenantName={view.tenantName}>
      <h1 className="page-title" style={{ fontSize: 26 }} lang={view.locale}>{m.title}</h1>
      <p className="muted" style={{ marginTop: 12 }} lang={view.locale}>{m.body}</p>
      <div className="amount-line" style={{ margin: '20px 0', fontWeight: 600 }}>
        {view.plan ? `${view.plan} · ` : ''}{view.amount}
      </div>
      <PayForm token={token} locale={view.locale} amount={view.amount} tenantName={view.tenantName} publishableKey={view.publishableKey} account={view.account} />
    </PayCard>
  );
}
