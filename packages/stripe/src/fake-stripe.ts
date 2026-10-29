import {
  GatewayError,
  type CustomerData,
  type InvoiceData,
  type PayResult,
  type SetupIntentData,
  type StripeGateway,
  type SubscriptionData,
} from './gateway';

type CardBehavior = { kind: 'succeed' } | { kind: 'decline'; code: string } | { kind: '3ds' } | { kind: 'processing' };

/** Stripe en mémoire pour les tests : comptes, factures, cartes programmables. */
export class FakeStripe implements StripeGateway {
  private invoices = new Map<string, InvoiceData>();
  private customers = new Map<string, CustomerData>();
  private subscriptions = new Map<string, SubscriptionData & { defaultPm?: string }>();
  private setupIntents = new Map<string, SetupIntentData>();
  private cards = new Map<string, CardBehavior>();
  private charges = new Map<string, Set<string>>();
  private idempotent = new Map<string, PayResult>();
  private oauth = new Map<string, { stripeUserId: string; livemode: boolean }>();
  private paymentIntents = new Map<string, string>();
  private failures: Error[] = [];
  private seq = 0;
  readonly deauthorized: string[] = [];
  /** Clés d'idempotence reçues par payInvoice, dans l'ordre (rejeux inclus). */
  readonly idempotencyKeys: string[] = [];

  private key(account: string, id: string): string {
    return `${account}/${id}`;
  }

  addInvoice(account: string, inv: InvoiceData): void {
    this.invoices.set(this.key(account, inv.id), { paidAt: null, ...inv });
  }
  addCustomer(account: string, c: CustomerData): void {
    this.customers.set(this.key(account, c.id), c);
  }
  addSubscription(account: string, s: SubscriptionData): void {
    this.subscriptions.set(this.key(account, s.id), { ...s });
  }
  setCardBehavior(paymentMethodId: string, kind: 'succeed' | 'decline' | '3ds' | 'processing', code = 'card_declined'): void {
    this.cards.set(paymentMethodId, kind === 'decline' ? { kind, code } : { kind });
  }
  setOAuthCode(code: string, v: { stripeUserId: string; livemode: boolean }): void {
    this.oauth.set(code, v);
  }
  linkPaymentIntent(account: string, paymentIntentId: string, invoiceId: string): void {
    this.paymentIntents.set(this.key(account, paymentIntentId), invoiceId);
  }
  async invoiceIdForPaymentIntent(account: string, paymentIntentId: string): Promise<string | null> {
    this.maybeFail();
    return this.paymentIntents.get(this.key(account, paymentIntentId)) ?? null;
  }
  failNext(error: Error): void {
    this.failures.push(error);
  }
  chargeCount(invoiceId: string): number {
    return this.charges.get(invoiceId)?.size ?? 0;
  }
  subscriptionDefaultPm(account: string, id: string): string | undefined {
    return this.subscriptions.get(this.key(account, id))?.defaultPm;
  }
  /** Simule le client qui saisit sa carte dans Stripe Elements. */
  completeSetupIntent(account: string, id: string, paymentMethodId: string): void {
    const si = this.must(this.setupIntents, account, id);
    this.setupIntents.set(this.key(account, id), { ...si, status: 'succeeded', paymentMethodId });
  }
  /** Simule Stripe qui marque la facture payée (ex. relance automatique Smart Retries). */
  markPaid(account: string, id: string, paidAt = new Date()): void {
    const inv = this.must(this.invoices, account, id);
    this.invoices.set(this.key(account, id), { ...inv, status: 'paid', amountPaid: inv.amountDue, paidAt });
  }

  private maybeFail(): void {
    const f = this.failures.shift();
    if (f) throw f;
  }

  private must<T>(map: Map<string, T>, account: string, id: string): T {
    const v = map.get(this.key(account, id));
    if (!v) throw new GatewayError(`${id} introuvable`, { kind: 'not_found', retryable: false });
    return v;
  }

  async retrieveInvoice(account: string, id: string): Promise<InvoiceData> {
    this.maybeFail();
    return { ...this.must(this.invoices, account, id) };
  }
  async listOpenInvoices(account: string): Promise<InvoiceData[]> {
    this.maybeFail();
    return [...this.invoices.entries()]
      .filter(([k, inv]) => k.startsWith(`${account}/`) && inv.status === 'open')
      .map(([, inv]) => ({ ...inv }));
  }
  async retrieveCustomer(account: string, id: string): Promise<CustomerData> {
    this.maybeFail();
    return { ...this.must(this.customers, account, id) };
  }
  async retrieveSubscription(account: string, id: string): Promise<SubscriptionData> {
    this.maybeFail();
    return { ...this.must(this.subscriptions, account, id) };
  }
  async listSubscriptions(account: string, o: { statuses: string[] }): Promise<SubscriptionData[]> {
    this.maybeFail();
    return [...this.subscriptions.entries()]
      .filter(([k, s]) => k.startsWith(`${account}/`) && o.statuses.includes(s.status))
      .map(([, s]) => ({ ...s }));
  }

  async payInvoice(
    account: string,
    invoiceId: string,
    o: { paymentMethodId: string; idempotencyKey: string },
  ): Promise<PayResult> {
    this.maybeFail();
    this.idempotencyKeys.push(o.idempotencyKey);
    const idem = `${account}/${o.idempotencyKey}`;
    const cached = this.idempotent.get(idem);
    if (cached) return cached;

    const inv = this.must(this.invoices, account, invoiceId);
    let result: PayResult;
    if (inv.status === 'paid') {
      // Stripe répond 400 sur une facture déjà payée
      throw new GatewayError(`La facture ${invoiceId} est déjà payée`, { kind: 'invalid_request', retryable: false });
    } else {
      const behavior = this.cards.get(o.paymentMethodId) ?? { kind: 'succeed' as const };
      if (behavior.kind === 'succeed') {
        const set = this.charges.get(invoiceId) ?? new Set<string>();
        set.add(`${o.paymentMethodId}#${set.size}`);
        this.charges.set(invoiceId, set);
        this.markPaid(account, invoiceId);
        result = { status: 'paid' };
      } else if (behavior.kind === 'decline') {
        result = { status: 'failed', errorCode: behavior.code };
      } else if (behavior.kind === 'processing') {
        result = { status: 'processing' };
      } else {
        result = { status: 'requires_action' };
      }
    }
    this.idempotent.set(idem, result);
    return result;
  }

  async createSetupIntent(account: string, o: { customerId: string; idempotencyKey: string }): Promise<SetupIntentData> {
    this.maybeFail();
    this.must(this.customers, account, o.customerId);
    const id = `seti_${++this.seq}`;
    const si: SetupIntentData = {
      id,
      status: 'requires_payment_method',
      clientSecret: `${id}_secret_fake`,
      customerId: o.customerId,
      paymentMethodId: null,
    };
    this.setupIntents.set(this.key(account, id), si);
    return { ...si };
  }
  async retrieveSetupIntent(account: string, id: string): Promise<SetupIntentData> {
    this.maybeFail();
    return { ...this.must(this.setupIntents, account, id) };
  }

  async setDefaultPaymentMethod(
    account: string,
    o: { customerId: string; subscriptionId?: string | null; paymentMethodId: string },
  ): Promise<void> {
    this.maybeFail();
    const c = this.must(this.customers, account, o.customerId);
    this.customers.set(this.key(account, o.customerId), { ...c, defaultPaymentMethodId: o.paymentMethodId });
    if (o.subscriptionId) {
      const s = this.must(this.subscriptions, account, o.subscriptionId);
      this.subscriptions.set(this.key(account, o.subscriptionId), { ...s, defaultPm: o.paymentMethodId });
    }
  }

  async exchangeOAuthCode(code: string): Promise<{ stripeUserId: string; livemode: boolean }> {
    this.maybeFail();
    const v = this.oauth.get(code);
    if (!v) throw new GatewayError('Code OAuth invalide', { kind: 'invalid_request', retryable: false });
    return v;
  }
  async deauthorize(stripeUserId: string): Promise<void> {
    this.deauthorized.push(stripeUserId);
  }
}
