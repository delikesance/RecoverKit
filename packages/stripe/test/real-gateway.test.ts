import { createServer, type IncomingMessage, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { StripeSdkGateway } from '../src';

let server: Server | undefined;
afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

type Handler = (req: IncomingMessage, body: string, n: number) => { status: number; json: unknown };

async function start(handler: Handler) {
  const seen: { method?: string; url?: string; headers: IncomingMessage['headers']; body: string }[] = [];
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body: raw });
      const out = handler(req, raw, seen.length);
      res.writeHead(out.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out.json));
    });
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const gateway = new StripeSdkGateway({
    secretKey: 'sk_test_123',
    host: '127.0.0.1',
    port,
    protocol: 'http',
    maxNetworkRetries: 2,
    connectBaseUrl: `http://127.0.0.1:${port}`,
  });
  return { gateway, seen };
}

const params = (body: string) => Object.fromEntries(new URLSearchParams(body));

describe('StripeSdkGateway', () => {
  it('retrieveInvoice : en-tête Stripe-Account et mapping (API récente, abonnement dans parent)', async () => {
    const { gateway, seen } = await start(() => ({
      status: 200,
      json: {
        id: 'in_1', object: 'invoice', customer: 'cus_1', status: 'open', amount_due: 2900, amount_paid: 0,
        currency: 'eur', attempt_count: 2, billing_reason: 'subscription_cycle', hosted_invoice_url: 'https://invoice.stripe.com/i/acct_1/test_123',
        parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_1' } },
        lines: { data: [{ description: 'Pro', pricing: { price_details: { price: 'price_1' } } }] },
        status_transitions: { paid_at: null },
      },
    }));
    const inv = await gateway.retrieveInvoice('acct_1', 'in_1');
    expect(seen[0]!.url).toContain('/v1/invoices/in_1');
    expect(seen[0]!.headers['stripe-account']).toBe('acct_1');
    expect(seen[0]!.headers.authorization).toBe('Bearer sk_test_123');
    expect(inv).toMatchObject({
      id: 'in_1', customerId: 'cus_1', subscriptionId: 'sub_1', status: 'open', amountDue: 2900,
      amountPaid: 0, currency: 'EUR', attemptCount: 2, paidAt: null,
      hostedInvoiceUrl: 'https://invoice.stripe.com/i/acct_1/test_123',
    });
  });

  it('retrieveInvoice : ancienne forme (invoice.subscription) et date de paiement', async () => {
    const { gateway } = await start(() => ({
      status: 200,
      json: {
        id: 'in_2', object: 'invoice', customer: 'cus_1', subscription: 'sub_9', status: 'paid',
        amount_due: 2900, amount_paid: 2900, currency: 'eur', attempt_count: 1,
        status_transitions: { paid_at: 1790000000 }, lines: { data: [] },
      },
    }));
    const inv = await gateway.retrieveInvoice('acct_1', 'in_2');
    expect(inv.subscriptionId).toBe('sub_9');
    expect(inv.paidAt?.getTime()).toBe(1790000000 * 1000);
  });

  it('payInvoice : paramètres, clé d’idempotence, succès', async () => {
    const { gateway, seen } = await start(() => ({ status: 200, json: { id: 'in_1', object: 'invoice', status: 'paid' } }));
    const r = await gateway.payInvoice('acct_1', 'in_1', { paymentMethodId: 'pm_1', idempotencyKey: 'key-1' });
    expect(r).toEqual({ status: 'paid' });
    expect(seen[0]!.method).toBe('POST');
    expect(seen[0]!.url).toContain('/v1/invoices/in_1/pay');
    expect(params(seen[0]!.body)).toMatchObject({ payment_method: 'pm_1', off_session: 'true' });
    expect(seen[0]!.headers['idempotency-key']).toBe('key-1');
    expect(seen[0]!.headers['stripe-account']).toBe('acct_1');
  });

  it('payInvoice : carte refusée = failed avec le motif, pas d’exception', async () => {
    const { gateway } = await start(() => ({
      status: 402,
      json: { error: { type: 'card_error', code: 'card_declined', decline_code: 'insufficient_funds', message: 'no' } },
    }));
    expect(await gateway.payInvoice('acct_1', 'in_1', { paymentMethodId: 'pm_1', idempotencyKey: 'k' })).toEqual({
      status: 'failed',
      errorCode: 'insufficient_funds',
    });
  });

  it('payInvoice : authentification requise = requires_action', async () => {
    const { gateway } = await start(() => ({
      status: 402,
      json: { error: { type: 'card_error', code: 'authentication_required', message: '3ds' } },
    }));
    expect(await gateway.payInvoice('acct_1', 'in_1', { paymentMethodId: 'pm_1', idempotencyKey: 'k' })).toEqual({
      status: 'requires_action',
    });
  });

  it('404 = GatewayError not_found, non réessayable', async () => {
    const { gateway } = await start(() => ({
      status: 404,
      json: { error: { type: 'invalid_request_error', code: 'resource_missing', message: 'nope' } },
    }));
    await expect(gateway.retrieveInvoice('acct_1', 'in_x')).rejects.toMatchObject({ kind: 'not_found', retryable: false });
  });

  it('429 persistant = GatewayError rate_limit réessayable', async () => {
    const { gateway } = await start(() => ({
      status: 429,
      json: { error: { type: 'rate_limit_error', message: 'slow down' } },
    }));
    await expect(gateway.retrieveInvoice('acct_1', 'in_1')).rejects.toMatchObject({ kind: 'rate_limit', retryable: true });
  });

  it('500 puis 200 : le nouvel essai aboutit', async () => {
    const { gateway, seen } = await start((_req, _b, n) =>
      n === 1
        ? { status: 500, json: { error: { type: 'api_error', message: 'oops' } } }
        : {
            status: 200,
            json: { id: 'cus_1', object: 'customer', email: 'a@b.c', name: 'A', preferred_locales: ['fr-FR'], invoice_settings: { default_payment_method: 'pm_1' } },
          },
    );
    const c = await gateway.retrieveCustomer('acct_1', 'cus_1');
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(c).toMatchObject({ id: 'cus_1', email: 'a@b.c', locale: 'fr', defaultPaymentMethodId: 'pm_1' });
  });

  it('createSetupIntent : client, carte, usage hors session', async () => {
    const { gateway, seen } = await start(() => ({
      status: 200,
      json: { id: 'seti_1', object: 'setup_intent', status: 'requires_payment_method', client_secret: 'seti_1_secret_x', customer: 'cus_1' },
    }));
    const si = await gateway.createSetupIntent('acct_1', { customerId: 'cus_1', idempotencyKey: 'si-1' });
    expect(si).toMatchObject({ id: 'seti_1', clientSecret: 'seti_1_secret_x', status: 'requires_payment_method' });
    expect(params(seen[0]!.body)).toMatchObject({ customer: 'cus_1', usage: 'off_session', 'payment_method_types[0]': 'card' });
    expect(seen[0]!.headers['idempotency-key']).toBe('si-1');
  });

  it('retrieveSetupIntent : moyen de paiement attaché', async () => {
    const { gateway } = await start(() => ({
      status: 200,
      json: { id: 'seti_1', object: 'setup_intent', status: 'succeeded', client_secret: 's', customer: 'cus_1', payment_method: 'pm_77' },
    }));
    expect(await gateway.retrieveSetupIntent('acct_1', 'seti_1')).toMatchObject({ status: 'succeeded', paymentMethodId: 'pm_77' });
  });

  it('setDefaultPaymentMethod : met à jour client puis abonnement', async () => {
    const { gateway, seen } = await start(() => ({ status: 200, json: { id: 'x', object: 'customer' } }));
    await gateway.setDefaultPaymentMethod('acct_1', { customerId: 'cus_1', subscriptionId: 'sub_1', paymentMethodId: 'pm_1' });
    expect(seen[0]!.url).toContain('/v1/customers/cus_1');
    expect(params(seen[0]!.body)).toMatchObject({ 'invoice_settings[default_payment_method]': 'pm_1' });
    expect(seen[1]!.url).toContain('/v1/subscriptions/sub_1');
    expect(params(seen[1]!.body)).toMatchObject({ default_payment_method: 'pm_1' });
  });

  it('listSubscriptions : pagination et filtre de statut', async () => {
    const mk = (id: string) => ({
      id, object: 'subscription', customer: 'cus_1', status: 'active',
      items: { data: [{ quantity: 1, price: { unit_amount: 2900, currency: 'eur', recurring: { interval: 'month', interval_count: 1 }, nickname: 'Pro' } }] },
    });
    const { gateway, seen } = await start((req) =>
      req.url!.includes('starting_after=sub_2')
        ? { status: 200, json: { object: 'list', data: [mk('sub_3')], has_more: false } }
        : { status: 200, json: { object: 'list', data: [mk('sub_1'), mk('sub_2')], has_more: true } },
    );
    const subs = await gateway.listSubscriptions('acct_1', { statuses: ['active'] });
    expect(subs.map((s) => s.id)).toEqual(['sub_1', 'sub_2', 'sub_3']);
    expect(subs[0]).toMatchObject({ amount: 2900, currency: 'EUR', interval: 'month', planName: 'Pro' });
    expect(seen[0]!.url).toContain('status=active');
  });

  it('OAuth : échange du code et révocation', async () => {
    const { gateway, seen } = await start((req) =>
      req.url!.includes('/oauth/token')
        ? { status: 200, json: { stripe_user_id: 'acct_42', livemode: false } }
        : { status: 200, json: { stripe_user_id: 'acct_42' } },
    );
    expect(await gateway.exchangeOAuthCode('ac_123')).toEqual({ stripeUserId: 'acct_42', livemode: false });
    expect(params(seen[0]!.body)).toMatchObject({ grant_type: 'authorization_code', code: 'ac_123' });
    await gateway.deauthorize('acct_42');
    expect(seen[1]!.url).toContain('/oauth/deauthorize');
    expect(params(seen[1]!.body)).toMatchObject({ stripe_user_id: 'acct_42' });
  });

  it('OAuth : code invalide = invalid_request', async () => {
    const { gateway } = await start(() => ({ status: 400, json: { error: 'invalid_grant', error_description: 'bad code' } }));
    await expect(gateway.exchangeOAuthCode('bad')).rejects.toMatchObject({ kind: 'invalid_request' });
  });

  it('invoiceIdForPaymentIntent : retrouve la facture via invoice_payments', async () => {
    const { gateway, seen } = await start(() => ({
      status: 200,
      json: { object: 'list', has_more: false, data: [{ id: 'inpay_1', object: 'invoice_payment', invoice: 'in_9' }] },
    }));
    expect(await gateway.invoiceIdForPaymentIntent('acct_1', 'pi_1')).toBe('in_9');
    expect(seen[0]!.url).toContain('/v1/invoice_payments');
    expect(decodeURIComponent(seen[0]!.url!)).toContain('payment[payment_intent]=pi_1');
    expect(seen[0]!.headers['stripe-account']).toBe('acct_1');
  });

  it('invoiceIdForPaymentIntent : null quand aucun paiement de facture', async () => {
    const { gateway } = await start(() => ({ status: 200, json: { object: 'list', has_more: false, data: [] } }));
    expect(await gateway.invoiceIdForPaymentIntent('acct_1', 'pi_2')).toBeNull();
  });

  it('listOpenInvoices : pagination et filtre status=open', async () => {
    const inv = (id: string) => ({ id, object: 'invoice', customer: 'cus_1', subscription: 'sub_1', status: 'open', amount_due: 2900, amount_paid: 0, currency: 'eur', attempt_count: 1, lines: { data: [] } });
    const { gateway, seen } = await start((req) =>
      req.url!.includes('starting_after=in_2')
        ? { status: 200, json: { object: 'list', data: [inv('in_3')], has_more: false } }
        : { status: 200, json: { object: 'list', data: [inv('in_1'), inv('in_2')], has_more: true } },
    );
    const list = await gateway.listOpenInvoices('acct_1');
    expect(list.map((i) => i.id)).toEqual(['in_1', 'in_2', 'in_3']);
    expect(seen[0]!.url).toContain('status=open');
    expect(seen[0]!.headers['stripe-account']).toBe('acct_1');
  });
});
