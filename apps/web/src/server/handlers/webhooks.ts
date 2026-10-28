import { receiveEmailProviderWebhook, receivePlatformWebhook, receiveStripeWebhook, type Deps } from '@recoverkit/services';
import { jsonResponse } from '../http';

export async function handleStripeWebhook(deps: Deps, req: Request): Promise<Response> {
  const rawBody = await req.text();
  const r = await receiveStripeWebhook(deps, { rawBody, signature: req.headers.get('stripe-signature') });
  return r.status === 'rejected' ? jsonResponse({ error: r.reason }, 400) : jsonResponse({ received: true }, 200);
}

export async function handlePlatformWebhook(deps: Deps, req: Request): Promise<Response> {
  const rawBody = await req.text();
  const r = await receivePlatformWebhook(deps, { rawBody, signature: req.headers.get('stripe-signature') });
  return r.status === 'rejected' ? jsonResponse({ error: 'rejected' }, 400) : jsonResponse({ received: true }, 200);
}

export async function handleResendWebhook(deps: Deps, req: Request): Promise<Response> {
  const rawBody = await req.text();
  const r = await receiveEmailProviderWebhook(deps, {
    rawBody,
    headers: { id: req.headers.get('svix-id'), timestamp: req.headers.get('svix-timestamp'), signature: req.headers.get('svix-signature') },
  });
  return r.status === 'rejected' ? jsonResponse({ error: 'rejected' }, 400) : jsonResponse({ received: true }, 200);
}
