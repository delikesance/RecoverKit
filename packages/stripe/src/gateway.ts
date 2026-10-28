export type GatewayErrorKind = 'card_declined' | 'rate_limit' | 'not_found' | 'invalid_request' | 'api';

export class GatewayError extends Error {
  readonly kind: GatewayErrorKind;
  readonly retryable: boolean;
  constructor(message: string, opts: { kind: GatewayErrorKind; retryable: boolean }) {
    super(message);
    this.name = 'GatewayError';
    this.kind = opts.kind;
    this.retryable = opts.retryable;
  }
}

export type InvoiceStatus = 'draft' | 'open' | 'paid' | 'void' | 'uncollectible';

export interface InvoiceData {
  id: string;
  customerId: string | null;
  subscriptionId: string | null;
  status: InvoiceStatus;
  amountDue: number;
  amountPaid: number;
  currency: string;
  attemptCount: number;
  planName?: string | null;
  lastErrorCode?: string | null;
  paidAt?: Date | null;
  /** Page Stripe de la facture : sert de repli pour l'authentification 3D Secure. */
  hostedInvoiceUrl?: string | null;
}

export interface CustomerData {
  id: string;
  email: string | null;
  name: string | null;
  locale: string | null;
  defaultPaymentMethodId: string | null;
}

export interface SubscriptionData {
  id: string;
  customerId: string;
  status: string;
  planName: string | null;
  /** Montant par période, en unités mineures. */
  amount: number;
  currency: string;
  interval: 'day' | 'week' | 'month' | 'year';
  intervalCount?: number;
}

export interface SetupIntentData {
  id: string;
  status: 'requires_payment_method' | 'requires_confirmation' | 'requires_action' | 'processing' | 'succeeded' | 'canceled';
  clientSecret: string;
  customerId: string | null;
  paymentMethodId: string | null;
}

export type PayResult =
  | { status: 'paid' }
  | { status: 'failed'; errorCode: string }
  | { status: 'requires_action' };

export interface StripeGateway {
  retrieveInvoice(account: string, invoiceId: string): Promise<InvoiceData>;
  /** Factures ouvertes (impayées) du compte connecté, pour la réconciliation quotidienne. */
  listOpenInvoices(account: string): Promise<InvoiceData[]>;
  /** Les refus de carte sont des résultats (`failed`), pas des exceptions. */
  payInvoice(account: string, invoiceId: string, o: { paymentMethodId: string; idempotencyKey: string }): Promise<PayResult>;
  createSetupIntent(account: string, o: { customerId: string; idempotencyKey: string }): Promise<SetupIntentData>;
  retrieveSetupIntent(account: string, id: string): Promise<SetupIntentData>;
  setDefaultPaymentMethod(
    account: string,
    o: { customerId: string; subscriptionId?: string | null; paymentMethodId: string },
  ): Promise<void>;
  retrieveCustomer(account: string, id: string): Promise<CustomerData>;
  retrieveSubscription(account: string, id: string): Promise<SubscriptionData>;
  listSubscriptions(account: string, o: { statuses: string[] }): Promise<SubscriptionData[]>;
  /** Facture payée par ce PaymentIntent (null si le paiement ne vient pas d'une facture). */
  invoiceIdForPaymentIntent(account: string, paymentIntentId: string): Promise<string | null>;
  exchangeOAuthCode(code: string): Promise<{ stripeUserId: string; livemode: boolean }>;
  deauthorize(stripeUserId: string): Promise<void>;
}
