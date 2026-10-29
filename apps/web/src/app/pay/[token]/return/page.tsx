import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { cardErrorMessage, confirmSetup, payMessage, resolvePaymentLink, type PayLocale } from '@recoverkit/services';
import { PayCard } from '@/ui/pay/PayCard';
import { getDeps } from '@/server/runtime';
import { clientIp } from '@/server/http';

export const metadata: Metadata = { title: 'Paiement', robots: { index: false, follow: false } };
export const dynamic = 'force-dynamic';

export default async function PayReturnPage({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<{ setup_intent?: string }> }) {
  const { token } = await params;
  const sp = await searchParams;
  const deps = getDeps();
  const h = await headers();
  const ip = clientIp(h, deps.config.trustedProxyHops);

  const link = await resolvePaymentLink(deps, token, { ip });
  const locale: PayLocale = link.status === 'ok' ? link.view.locale : 'fr';
  const tenantName = link.status === 'ok' ? link.view.tenantName : undefined;

  const result = sp.setup_intent ? await confirmSetup(deps, token, sp.setup_intent, { ip }) : ({ status: 'invalid' } as const);

  let title: string;
  let body: string;
  let retry = false;
  switch (result.status) {
    case 'paid':
      ({ title, body } = payMessage(link.status === 'paid' ? 'paid' : 'success', locale));
      break;
    case 'processing':
      ({ title, body } = payMessage('success', locale));
      break;
    case 'card_failed':
      title = locale === 'fr' ? 'Le paiement a échoué.' : 'The payment failed.';
      body = cardErrorMessage(result.errorCode, locale);
      retry = true;
      break;
    case 'requires_action':
      ({ title, body } = payMessage('requires_action', locale));
      retry = true;
      break;
    case 'setup_incomplete':
      ({ title, body } = payMessage('setup_incomplete', locale));
      retry = true;
      break;
    case 'dry_run':
      ({ title, body } = payMessage('dry_run', locale));
      break;
    case 'rate_limited':
      ({ title, body } = payMessage('rate_limited', locale));
      break;
    case 'error':
      ({ title, body } = payMessage('error', locale));
      retry = true;
      break;
    default:
      ({ title, body } = payMessage('unavailable', locale));
  }

  return (
    <PayCard tenantName={tenantName}>
      <h1 className="page-title" style={{ fontSize: 26 }} lang={locale} data-testid="pay-result" data-status={result.status}>{title}</h1>
      <p className="muted" style={{ marginTop: 12 }} lang={locale}>{body}</p>
      {result.status === 'requires_action' && result.hostedInvoiceUrl ? (
        <a className="btn btn-p btn-lg" style={{ width: '100%', marginTop: 20 }} href={result.hostedInvoiceUrl} rel="noreferrer noopener">
          {locale === 'fr' ? 'Confirmer auprès de ma banque' : 'Confirm with my bank'}
        </a>
      ) : null}
      {retry ? (
        <a className="btn btn-s btn-lg" style={{ width: '100%', marginTop: 12 }} href={`/pay/${token}`}>
          {locale === 'fr' ? 'Réessayer avec une autre carte' : 'Try another card'}
        </a>
      ) : null}
    </PayCard>
  );
}
