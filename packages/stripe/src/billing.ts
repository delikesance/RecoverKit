import { randomUUID } from 'node:crypto';
import Stripe from 'stripe';
import { GatewayError } from './gateway';
import { normalizeError } from './sdk-gateway';

export interface BillingSubscription {
  id: string;
  customerId: string;
  status: string;
  priceId: string | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
}

/** Facturation de RecoverKit lui-même, sur le compte plateforme (sans en-tête Stripe-Account). */
export interface BillingGateway {
  createCustomer(o: { email: string; name: string; tenantId: string }): Promise<{ id: string }>;
  createCheckoutSession(o: {
    customerId: string;
    priceId: string;
    tenantId: string;
    successUrl: string;
    cancelUrl: string;
    trialDays?: number;
  }): Promise<{ url: string }>;
  createPortalSession(o: { customerId: string; returnUrl: string }): Promise<{ url: string }>;
  retrieveSubscription(id: string): Promise<BillingSubscription>;
  cancelSubscription(id: string): Promise<void>;
}

export class FakeBilling implements BillingGateway {
  private subs = new Map<string, BillingSubscription>();
  readonly canceled: string[] = [];

  addSubscription(s: BillingSubscription): void {
    this.subs.set(s.id, s);
  }
  async createCustomer(_o: { email: string; name: string; tenantId: string }): Promise<{ id: string }> {
    return { id: `cus_fake_${randomUUID().slice(0, 12)}` };
  }
  async createCheckoutSession(o: Parameters<BillingGateway['createCheckoutSession']>[0]): Promise<{ url: string }> {
    return { url: `https://fake-checkout.example/${o.customerId}/${o.priceId}/${o.tenantId}` };
  }
  async createPortalSession(o: Parameters<BillingGateway['createPortalSession']>[0]): Promise<{ url: string }> {
    return { url: `https://fake-portal.example/${o.customerId}` };
  }
  async retrieveSubscription(id: string): Promise<BillingSubscription> {
    const s = this.subs.get(id);
    if (!s) throw new GatewayError('Abonnement introuvable', { kind: 'not_found', retryable: false });
    return { ...s };
  }
  async cancelSubscription(id: string): Promise<void> {
    this.canceled.push(id);
    const s = this.subs.get(id);
    if (s) this.subs.set(id, { ...s, status: 'canceled' });
  }
}

export class StripeSdkBillingGateway implements BillingGateway {
  private readonly stripe: Stripe;
  constructor(opts: { secretKey: string; host?: string; port?: number; protocol?: 'http' | 'https'; maxNetworkRetries?: number }) {
    this.stripe = new Stripe(opts.secretKey, {
      host: opts.host,
      port: opts.port,
      protocol: opts.protocol,
      maxNetworkRetries: opts.maxNetworkRetries ?? 2,
    } as Stripe.StripeConfig);
  }

  private async call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      throw normalizeError(e);
    }
  }

  async createCustomer(o: { email: string; name: string; tenantId: string }): Promise<{ id: string }> {
    return this.call(async () => ({ id: (await this.stripe.customers.create({ email: o.email, name: o.name, metadata: { tenant_id: o.tenantId } })).id }));
  }

  async createCheckoutSession(o: {
    customerId: string;
    priceId: string;
    tenantId: string;
    successUrl: string;
    cancelUrl: string;
    trialDays?: number;
  }): Promise<{ url: string }> {
    return this.call(async () => {
      const s = await this.stripe.checkout.sessions.create({
        mode: 'subscription',
        customer: o.customerId,
        line_items: [{ price: o.priceId, quantity: 1 }],
        success_url: o.successUrl,
        cancel_url: o.cancelUrl,
        client_reference_id: o.tenantId,
        subscription_data: {
          metadata: { tenant_id: o.tenantId },
          ...(o.trialDays ? { trial_period_days: o.trialDays } : {}),
        },
      });
      return { url: s.url! };
    });
  }

  async createPortalSession(o: { customerId: string; returnUrl: string }): Promise<{ url: string }> {
    return this.call(async () => {
      const s = await this.stripe.billingPortal.sessions.create({ customer: o.customerId, return_url: o.returnUrl });
      return { url: s.url };
    });
  }

  async retrieveSubscription(id: string): Promise<BillingSubscription> {
    return this.call(async () => {
      const s: any = await this.stripe.subscriptions.retrieve(id);
      const item = s.items?.data?.[0];
      const periodEnd = item?.current_period_end ?? s.current_period_end ?? null;
      return {
        id: s.id,
        customerId: typeof s.customer === 'string' ? s.customer : s.customer?.id,
        status: s.status,
        priceId: item?.price?.id ?? null,
        currentPeriodEnd: periodEnd ? new Date(periodEnd * 1000) : null,
        cancelAtPeriodEnd: !!s.cancel_at_period_end,
      };
    });
  }

  async cancelSubscription(id: string): Promise<void> {
    await this.call(() => this.stripe.subscriptions.cancel(id));
  }
}
