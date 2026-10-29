import Stripe from 'stripe';
import {
  GatewayError,
  type CustomerData,
  type InvoiceData,
  type InvoiceStatus,
  type PayResult,
  type SetupIntentData,
  type StripeGateway,
  type SubscriptionData,
} from './gateway';

export interface SdkGatewayOptions {
  secretKey: string;
  host?: string;
  port?: number;
  protocol?: 'http' | 'https';
  maxNetworkRetries?: number;
  connectBaseUrl?: string;
  /** Délai maximal d'un appel API Stripe (ms). 20 000 par défaut. */
  timeoutMs?: number;
  /** Délai maximal d'un appel OAuth Connect (ms). 15 000 par défaut. */
  oauthTimeoutMs?: number;
  /** Réservé aux tests : délai entre deux tentatives réseau. */
}

export function normalizeError(e: unknown): GatewayError {
  if (e instanceof GatewayError) return e;
  const err = e as { type?: string; code?: string; statusCode?: number; message?: string };
  const message = err.message ?? 'Erreur Stripe';
  if (err.statusCode === 404 || err.code === 'resource_missing') {
    return new GatewayError(message, { kind: 'not_found', retryable: false });
  }
  if (err.statusCode === 429 || err.type === 'StripeRateLimitError') {
    return new GatewayError(message, { kind: 'rate_limit', retryable: true });
  }
  if (err.statusCode && err.statusCode >= 400 && err.statusCode < 500) {
    return new GatewayError(message, { kind: 'invalid_request', retryable: false });
  }
  return new GatewayError(message, { kind: 'api', retryable: true });
}

const ACTION_REQUIRED_CODES = new Set([
  'invoice_payment_intent_requires_action',
  'payment_intent_action_required',
  'authentication_required',
  'payment_intent_authentication_failure',
]);

function subscriptionIdOf(inv: any): string | null {
  const nested = inv.parent?.subscription_details?.subscription ?? null;
  const legacy = inv.subscription ?? null;
  const v = nested ?? legacy;
  return typeof v === 'string' ? v : (v?.id ?? null);
}

/**
 * Expansion du PaymentIntent de la facture (API basil : invoice.payments). Quatre niveaux au plus,
 * même en comptant « data » (limite Stripe) : c'est pourquoi invoices.list n'est PAS expandé ;
 * la réconciliation relit chaque facture à ouvrir avec retrieveInvoice.
 */
const INVOICE_EXPAND = ['payments.data.payment.payment_intent'];
/** Le produit du prix, pour planName quand le prix n'a pas de nickname. */
const SUBSCRIPTION_EXPAND = ['items.data.price.product'];

function failureOf(inv: any): { code: string | null; paymentMethodId: string | null; failedAt: Date | null } {
  const payments: any[] = inv.payments?.data ?? [];
  for (const p of payments) {
    const pi = p?.payment?.payment_intent;
    const e = pi && typeof pi === 'object' ? pi.last_payment_error : null;
    if (!e) continue;
    const pm = e.payment_method;
    const created = typeof p?.created === 'number' ? p.created : null;
    return {
      code: e.decline_code ?? e.code ?? null,
      paymentMethodId: typeof pm === 'string' ? pm : (pm?.id ?? null),
      failedAt: created ? new Date(created * 1000) : null,
    };
  }
  return { code: null, paymentMethodId: null, failedAt: null };
}

function priceIdOf(inv: any): string | null {
  const line = inv.lines?.data?.[0];
  const p = line?.pricing?.price_details?.price ?? line?.price ?? null;
  return typeof p === 'string' ? p : (p?.id ?? null);
}

function mapInvoice(inv: any): InvoiceData {
  const failure = failureOf(inv);
  const paidAtSec = inv.status_transitions?.paid_at ?? null;
  return {
    id: inv.id,
    customerId: typeof inv.customer === 'string' ? inv.customer : (inv.customer?.id ?? null),
    subscriptionId: subscriptionIdOf(inv),
    status: inv.status as InvoiceStatus,
    amountDue: inv.amount_due,
    amountPaid: inv.amount_paid,
    currency: String(inv.currency).toUpperCase(),
    attemptCount: inv.attempt_count ?? 0,
    planName: null,
    lastErrorCode: failure.code,
    failedPaymentMethodId: failure.paymentMethodId,
    failedAt: failure.failedAt,
    paidAt: paidAtSec ? new Date(paidAtSec * 1000) : null,
    hostedInvoiceUrl: inv.hosted_invoice_url ?? null,
  };
}

function unitAmountOf(price: any): number | null {
  if (typeof price?.unit_amount === 'number') return price.unit_amount;
  const dec = price?.unit_amount_decimal;
  return dec != null && Number.isFinite(Number(dec)) ? Math.round(Number(dec)) : null;
}

function mapSubscription(s: any): SubscriptionData {
  const items: any[] = s.items?.data ?? [];
  const item = items[0];
  const price = item?.price;
  let amount = 0;
  let unpriced = 0;
  for (const it of items) {
    const unit = unitAmountOf(it.price);
    // Mesuré : le montant dépend de l'usage, ce n'est pas une quantité fixe
    if (it.price?.recurring?.usage_type === 'metered' || unit === null) unpriced++;
    else amount += unit * (it.quantity ?? 1);
  }
  const product = price?.product;
  return {
    id: s.id,
    customerId: typeof s.customer === 'string' ? s.customer : s.customer?.id,
    status: s.status,
    planName: price?.nickname ?? (product && typeof product === 'object' ? (product.name ?? null) : null),
    amount,
    unpricedItems: unpriced,
    currency: String(price?.currency ?? 'eur').toUpperCase(),
    interval: price?.recurring?.interval ?? 'month',
    intervalCount: price?.recurring?.interval_count ?? 1,
  };
}

function mapSetupIntent(si: any): SetupIntentData {
  return {
    id: si.id,
    status: si.status,
    clientSecret: si.client_secret,
    customerId: typeof si.customer === 'string' ? si.customer : (si.customer?.id ?? null),
    paymentMethodId: typeof si.payment_method === 'string' ? si.payment_method : (si.payment_method?.id ?? null),
  };
}

export class StripeSdkGateway implements StripeGateway {
  private readonly stripe: Stripe;
  private readonly connectBaseUrl: string;

  constructor(private readonly opts: SdkGatewayOptions) {
    this.stripe = new Stripe(opts.secretKey, {
      host: opts.host,
      port: opts.port,
      protocol: opts.protocol,
      maxNetworkRetries: opts.maxNetworkRetries ?? 2,
      timeout: opts.timeoutMs ?? 20_000,
    } as Stripe.StripeConfig);
    this.connectBaseUrl = opts.connectBaseUrl ?? 'https://connect.stripe.com';
  }

  private async call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      throw normalizeError(e);
    }
  }

  /**
   * Nom du plan : nickname du prix, sinon nom du produit. Jamais la description de ligne (texte libre).
   * Seul resource_missing donne null ; toute autre erreur remonte (rien de faux n'est mis en cache).
   */
  private async fetchPlanName(account: string, priceId: string): Promise<string | null> {
    try {
      const price: any = await this.stripe.prices.retrieve(priceId, { expand: ['product'] }, { stripeAccount: account });
      const product = price?.product;
      return price?.nickname ?? (product && typeof product === 'object' ? (product.name ?? null) : null);
    } catch (e) {
      const err = normalizeError(e);
      if (err.kind === 'not_found') return null;
      throw err;
    }
  }

  /** Récupère en parallèle les noms des prix distincts non encore connus (pas de N+1 séquentiel). */
  private async prefetchPlanNames(account: string, invoices: any[], cache: Map<string, string | null>): Promise<void> {
    const ids = [...new Set(invoices.map(priceIdOf).filter((id): id is string => !!id && !cache.has(id)))];
    const names = await Promise.all(ids.map((id) => this.fetchPlanName(account, id)));
    ids.forEach((id, i) => cache.set(id, names[i]!));
  }

  private async mapInvoicesWithPlan(account: string, invoices: any[], cache: Map<string, string | null>): Promise<InvoiceData[]> {
    await this.prefetchPlanNames(account, invoices, cache);
    return invoices.map((inv) => {
      const data = mapInvoice(inv);
      const id = priceIdOf(inv);
      data.planName = id ? (cache.get(id) ?? null) : null;
      return data;
    });
  }

  async retrieveInvoice(account: string, id: string): Promise<InvoiceData> {
    return this.call(async () => {
      const inv = await this.stripe.invoices.retrieve(id, { expand: INVOICE_EXPAND }, { stripeAccount: account });
      return (await this.mapInvoicesWithPlan(account, [inv], new Map()))[0]!;
    });
  }

  async listOpenInvoices(account: string): Promise<InvoiceData[]> {
    return this.call(async () => {
      const out: InvoiceData[] = [];
      const cache = new Map<string, string | null>();
      let startingAfter: string | undefined;
      for (;;) {
        const page: any = await this.stripe.invoices.list({ status: 'open', limit: 100, starting_after: startingAfter }, { stripeAccount: account });
        out.push(...(await this.mapInvoicesWithPlan(account, page.data, cache)));
        if (!page.has_more) break;
        startingAfter = page.data[page.data.length - 1].id;
      }
      return out;
    });
  }

  async payInvoice(account: string, id: string, o: { paymentMethodId: string; idempotencyKey: string }): Promise<PayResult> {
    try {
      const inv = await this.stripe.invoices.pay(
        id,
        { payment_method: o.paymentMethodId, off_session: true },
        { stripeAccount: account, idempotencyKey: o.idempotencyKey },
      );
      // 200 ne veut pas dire payé : un débit SEPA laisse la facture ouverte, le paiement en cours
      return inv.status === 'paid' ? { status: 'paid' } : { status: 'processing' };
    } catch (e) {
      const err = e as { type?: string; code?: string; decline_code?: string; raw?: { decline_code?: string } };
      const declineCode = err.decline_code ?? err.raw?.decline_code;
      if ((err.code && ACTION_REQUIRED_CODES.has(err.code)) || (declineCode && ACTION_REQUIRED_CODES.has(declineCode))) {
        return { status: 'requires_action' };
      }
      if (err.type === 'StripeCardError') {
        return { status: 'failed', errorCode: err.decline_code ?? err.raw?.decline_code ?? err.code ?? 'card_declined' };
      }
      throw normalizeError(e);
    }
  }

  async createSetupIntent(account: string, o: { customerId: string; idempotencyKey: string }): Promise<SetupIntentData> {
    return this.call(async () =>
      mapSetupIntent(
        await this.stripe.setupIntents.create(
          { customer: o.customerId, usage: 'off_session', payment_method_types: ['card'] },
          { stripeAccount: account, idempotencyKey: o.idempotencyKey },
        ),
      ),
    );
  }

  async retrieveSetupIntent(account: string, id: string): Promise<SetupIntentData> {
    return this.call(async () => mapSetupIntent(await this.stripe.setupIntents.retrieve(id, {}, { stripeAccount: account })));
  }

  async setDefaultPaymentMethod(
    account: string,
    o: { customerId: string; subscriptionId?: string | null; paymentMethodId: string },
  ): Promise<void> {
    await this.call(async () => {
      await this.stripe.customers.update(
        o.customerId,
        { invoice_settings: { default_payment_method: o.paymentMethodId } },
        { stripeAccount: account },
      );
      if (o.subscriptionId) {
        await this.stripe.subscriptions.update(
          o.subscriptionId,
          { default_payment_method: o.paymentMethodId },
          { stripeAccount: account },
        );
      }
    });
  }

  async retrieveCustomer(account: string, id: string): Promise<CustomerData> {
    return this.call(async () => {
      const c: any = await this.stripe.customers.retrieve(id, {}, { stripeAccount: account });
      const pm = c.invoice_settings?.default_payment_method ?? null;
      return {
        id: c.id,
        email: c.email ?? null,
        name: c.name ?? null,
        locale: c.preferred_locales?.[0]?.split('-')[0]?.toLowerCase() ?? null,
        defaultPaymentMethodId: typeof pm === 'string' ? pm : (pm?.id ?? null),
      };
    });
  }

  async retrieveSubscription(account: string, id: string): Promise<SubscriptionData> {
    return this.call(async () => mapSubscription(await this.stripe.subscriptions.retrieve(id, { expand: SUBSCRIPTION_EXPAND }, { stripeAccount: account })));
  }

  async listSubscriptions(account: string, o: { statuses: string[] }): Promise<SubscriptionData[]> {
    return this.call(async () => {
      const out: SubscriptionData[] = [];
      for (const status of o.statuses) {
        let startingAfter: string | undefined;
        for (;;) {
          const page: any = await this.stripe.subscriptions.list(
            { status: status as Stripe.SubscriptionListParams.Status, limit: 100, starting_after: startingAfter },
            { stripeAccount: account },
          );
          out.push(...page.data.map(mapSubscription));
          if (!page.has_more) break;
          startingAfter = page.data[page.data.length - 1].id;
        }
      }
      return out;
    });
  }

  async invoiceIdForPaymentIntent(account: string, paymentIntentId: string): Promise<string | null> {
    return this.call(async () => {
      const page: any = await this.stripe.invoicePayments.list(
        { payment: { type: 'payment_intent', payment_intent: paymentIntentId }, limit: 1 },
        { stripeAccount: account },
      );
      const inv = page.data[0]?.invoice;
      if (!inv) return null;
      return typeof inv === 'string' ? inv : inv.id;
    });
  }

  async exchangeOAuthCode(code: string): Promise<{ stripeUserId: string; livemode: boolean }> {
    const res = await this.oauthPost('/oauth/token', { grant_type: 'authorization_code', code });
    if (!res.ok) {
      throw new GatewayError('Code OAuth refusé', { kind: 'invalid_request', retryable: false });
    }
    const json = (await res.json()) as { stripe_user_id: string; livemode: boolean };
    return { stripeUserId: json.stripe_user_id, livemode: json.livemode };
  }

  async deauthorize(stripeUserId: string): Promise<void> {
    const res = await this.oauthPost('/oauth/deauthorize', { stripe_user_id: stripeUserId, client_id: process.env.STRIPE_CONNECT_CLIENT_ID ?? '' });
    if (!res.ok) throw new GatewayError('Révocation refusée', { kind: 'api', retryable: true });
  }

  private async oauthPost(path: string, body: Record<string, string>): Promise<Response> {
    try {
      return await fetch(`${this.connectBaseUrl}${path}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.opts.secretKey}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams(body).toString(),
        signal: AbortSignal.timeout(this.opts.oauthTimeoutMs ?? 15_000),
      });
    } catch (e) {
      throw new GatewayError((e as Error).message, { kind: 'api', retryable: true });
    }
  }
}
