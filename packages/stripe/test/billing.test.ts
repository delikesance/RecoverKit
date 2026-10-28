import { createServer, type IncomingMessage, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeBilling, StripeSdkBillingGateway } from '../src';

let server: Server | undefined;
afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

async function start(handler: (req: IncomingMessage, body: string) => { status: number; json: unknown }) {
  const seen: { method?: string; url?: string; headers: IncomingMessage['headers']; body: string }[] = [];
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body: raw });
      const out = handler(req, raw);
      res.writeHead(out.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out.json));
    });
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return { gateway: new StripeSdkBillingGateway({ secretKey: 'sk_test_plat', host: '127.0.0.1', port, protocol: 'http', maxNetworkRetries: 0 }), seen };
}
const params = (b: string) => Object.fromEntries(new URLSearchParams(b));

describe('StripeSdkBillingGateway (compte plateforme, sans Stripe-Account)', () => {
  it('createCustomer : email, nom, tenant en métadonnée', async () => {
    const { gateway, seen } = await start(() => ({ status: 200, json: { id: 'cus_p1', object: 'customer' } }));
    expect(await gateway.createCustomer({ email: 'f@example.com', name: 'Nimbus', tenantId: 't1' })).toEqual({ id: 'cus_p1' });
    expect(params(seen[0]!.body)).toMatchObject({ email: 'f@example.com', name: 'Nimbus', 'metadata[tenant_id]': 't1' });
    expect(seen[0]!.headers['stripe-account']).toBeUndefined();
  });

  it('createCheckoutSession : abonnement, prix, essai, retours et tenant', async () => {
    const { gateway, seen } = await start(() => ({ status: 200, json: { id: 'cs_1', object: 'checkout.session', url: 'https://checkout.stripe.com/c/pay/cs_1' } }));
    const r = await gateway.createCheckoutSession({ customerId: 'cus_p1', priceId: 'price_growth', tenantId: 't1', successUrl: 'https://app/ok', cancelUrl: 'https://app/no', trialDays: 7 });
    expect(r).toEqual({ url: 'https://checkout.stripe.com/c/pay/cs_1' });
    expect(params(seen[0]!.body)).toMatchObject({
      mode: 'subscription', customer: 'cus_p1', 'line_items[0][price]': 'price_growth', 'line_items[0][quantity]': '1',
      success_url: 'https://app/ok', cancel_url: 'https://app/no', client_reference_id: 't1',
      'subscription_data[metadata][tenant_id]': 't1', 'subscription_data[trial_period_days]': '7',
    });
  });

  it('createPortalSession', async () => {
    const { gateway, seen } = await start(() => ({ status: 200, json: { id: 'bps_1', object: 'billing_portal.session', url: 'https://billing.stripe.com/p/session/x' } }));
    expect(await gateway.createPortalSession({ customerId: 'cus_p1', returnUrl: 'https://app/billing' })).toEqual({ url: 'https://billing.stripe.com/p/session/x' });
    expect(params(seen[0]!.body)).toMatchObject({ customer: 'cus_p1', return_url: 'https://app/billing' });
  });

  it('retrieveSubscription : statut, prix, fin de période, annulation programmée', async () => {
    const { gateway } = await start(() => ({
      status: 200,
      json: {
        id: 'sub_p1', object: 'subscription', customer: 'cus_p1', status: 'active', cancel_at_period_end: true,
        items: { data: [{ price: { id: 'price_growth' }, current_period_end: 1795000000 }] },
      },
    }));
    const s = await gateway.retrieveSubscription('sub_p1');
    expect(s).toMatchObject({ id: 'sub_p1', customerId: 'cus_p1', status: 'active', priceId: 'price_growth', cancelAtPeriodEnd: true });
    expect(s.currentPeriodEnd?.getTime()).toBe(1795000000 * 1000);
  });

  it('cancelSubscription', async () => {
    const { gateway, seen } = await start(() => ({ status: 200, json: { id: 'sub_p1', object: 'subscription', status: 'canceled' } }));
    await gateway.cancelSubscription('sub_p1');
    expect(seen[0]!.method).toBe('DELETE');
    expect(seen[0]!.url).toContain('/v1/subscriptions/sub_p1');
  });

  it('erreur API : GatewayError', async () => {
    const { gateway } = await start(() => ({ status: 404, json: { error: { type: 'invalid_request_error', code: 'resource_missing', message: 'x' } } }));
    await expect(gateway.retrieveSubscription('sub_x')).rejects.toMatchObject({ kind: 'not_found' });
  });
});

describe('FakeBilling', () => {
  it('crée client, session et abonnement', async () => {
    const f = new FakeBilling();
    const c = await f.createCustomer({ email: 'a@b.c', name: 'N', tenantId: 't1' });
    const s = await f.createCheckoutSession({ customerId: c.id, priceId: 'price_x', tenantId: 't1', successUrl: 'u', cancelUrl: 'c' });
    expect(s.url).toContain('fake-checkout');
    f.addSubscription({ id: 'sub_1', customerId: c.id, status: 'active', priceId: 'price_x', currentPeriodEnd: null, cancelAtPeriodEnd: false });
    expect((await f.retrieveSubscription('sub_1')).priceId).toBe('price_x');
    await f.cancelSubscription('sub_1');
    expect(f.canceled).toContain('sub_1');
  });
});
