import { describe, expect, it } from 'vitest';
import { FakeStripe, GatewayError } from '../src';

const ACCT = 'acct_1';
const invoice = {
  id: 'in_1',
  customerId: 'cus_1',
  subscriptionId: 'sub_1',
  status: 'open' as const,
  amountDue: 2900,
  amountPaid: 0,
  currency: 'EUR',
  attemptCount: 1,
  planName: 'Pro',
  lastErrorCode: 'card_declined',
};

function setup() {
  const s = new FakeStripe();
  s.addCustomer(ACCT, { id: 'cus_1', email: 'camille@example.com', name: 'Camille', locale: 'fr', defaultPaymentMethodId: 'pm_old' });
  s.addSubscription(ACCT, { id: 'sub_1', customerId: 'cus_1', status: 'past_due', planName: 'Pro', amount: 2900, currency: 'EUR', interval: 'month' });
  s.addInvoice(ACCT, invoice);
  return s;
}

describe('FakeStripe', () => {
  it('lit une facture, un client, un abonnement', async () => {
    const s = setup();
    expect((await s.retrieveInvoice(ACCT, 'in_1')).amountDue).toBe(2900);
    expect((await s.retrieveCustomer(ACCT, 'cus_1')).email).toBe('camille@example.com');
    expect((await s.retrieveSubscription(ACCT, 'sub_1')).status).toBe('past_due');
  });

  it('refuse une ressource inconnue ou d’un autre compte (not_found)', async () => {
    const s = setup();
    await expect(s.retrieveInvoice(ACCT, 'in_x')).rejects.toMatchObject({ kind: 'not_found' });
    await expect(s.retrieveInvoice('acct_2', 'in_1')).rejects.toBeInstanceOf(GatewayError);
  });

  it('payInvoice réussi : facture payée, montant encaissé', async () => {
    const s = setup();
    s.setCardBehavior('pm_new', 'succeed');
    const r = await s.payInvoice(ACCT, 'in_1', { paymentMethodId: 'pm_new', idempotencyKey: 'k1' });
    expect(r).toEqual({ status: 'paid' });
    const inv = await s.retrieveInvoice(ACCT, 'in_1');
    expect(inv).toMatchObject({ status: 'paid', amountPaid: 2900 });
    expect(inv.paidAt).toBeInstanceOf(Date);
  });

  it('payInvoice refusé : renvoie failed avec le code, facture toujours ouverte', async () => {
    const s = setup();
    s.setCardBehavior('pm_bad', 'decline', 'insufficient_funds');
    const r = await s.payInvoice(ACCT, 'in_1', { paymentMethodId: 'pm_bad', idempotencyKey: 'k1' });
    expect(r).toEqual({ status: 'failed', errorCode: 'insufficient_funds' });
    expect((await s.retrieveInvoice(ACCT, 'in_1')).status).toBe('open');
  });

  it('payInvoice 3D Secure : requires_action', async () => {
    const s = setup();
    s.setCardBehavior('pm_3ds', '3ds');
    expect(await s.payInvoice(ACCT, 'in_1', { paymentMethodId: 'pm_3ds', idempotencyKey: 'k1' })).toEqual({
      status: 'requires_action',
    });
  });

  it("idempotence : une même clé n'encaisse qu'une fois", async () => {
    const s = setup();
    s.setCardBehavior('pm_new', 'succeed');
    await s.payInvoice(ACCT, 'in_1', { paymentMethodId: 'pm_new', idempotencyKey: 'same' });
    await s.payInvoice(ACCT, 'in_1', { paymentMethodId: 'pm_new', idempotencyKey: 'same' });
    expect(s.chargeCount('in_1')).toBe(1);
  });

  it('payer une facture déjà payée = GatewayError invalid_request non réessayable (comme Stripe), sans nouvel encaissement', async () => {
    const s = setup();
    s.setCardBehavior('pm_new', 'succeed');
    await s.payInvoice(ACCT, 'in_1', { paymentMethodId: 'pm_new', idempotencyKey: 'a' });
    const again = s.payInvoice(ACCT, 'in_1', { paymentMethodId: 'pm_new', idempotencyKey: 'b' });
    await expect(again).rejects.toMatchObject({ kind: 'invalid_request', retryable: false });
    expect(s.chargeCount('in_1')).toBe(1);
  });

  it("rejouer la même clé d'idempotence sur une facture payée renvoie le résultat d'origine", async () => {
    const s = setup();
    await s.payInvoice(ACCT, 'in_1', { paymentMethodId: 'pm_new', idempotencyKey: 'a' });
    expect(await s.payInvoice(ACCT, 'in_1', { paymentMethodId: 'pm_new', idempotencyKey: 'a' })).toEqual({ status: 'paid' });
  });

  it("enregistre les clés d'idempotence reçues par payInvoice", async () => {
    const s = setup();
    s.setCardBehavior('pm_bad', 'decline', 'card_declined');
    await s.payInvoice(ACCT, 'in_1', { paymentMethodId: 'pm_bad', idempotencyKey: 'retry:case1:pm_bad' });
    await s.payInvoice(ACCT, 'in_1', { paymentMethodId: 'pm_new', idempotencyKey: 'retry:case1:pm_new' });
    expect(s.idempotencyKeys).toEqual(['retry:case1:pm_bad', 'retry:case1:pm_new']);
  });

  it('paiement asynchrone (SEPA) : processing, facture toujours ouverte, pas encore encaissée', async () => {
    const s = setup();
    s.setCardBehavior('pm_sepa', 'processing');
    expect(await s.payInvoice(ACCT, 'in_1', { paymentMethodId: 'pm_sepa', idempotencyKey: 'k' })).toEqual({
      status: 'processing',
    });
    expect((await s.retrieveInvoice(ACCT, 'in_1')).status).toBe('open');
    expect(s.chargeCount('in_1')).toBe(0);
  });

  it('SetupIntent : création puis confirmation par le client', async () => {
    const s = setup();
    const si = await s.createSetupIntent(ACCT, { customerId: 'cus_1', idempotencyKey: 'si1' });
    expect(si.clientSecret).toMatch(/_secret_/);
    expect((await s.retrieveSetupIntent(ACCT, si.id)).status).toBe('requires_payment_method');
    s.completeSetupIntent(ACCT, si.id, 'pm_new');
    expect(await s.retrieveSetupIntent(ACCT, si.id)).toMatchObject({ status: 'succeeded', paymentMethodId: 'pm_new' });
  });

  it('setDefaultPaymentMethod met à jour le client et l’abonnement', async () => {
    const s = setup();
    await s.setDefaultPaymentMethod(ACCT, { customerId: 'cus_1', subscriptionId: 'sub_1', paymentMethodId: 'pm_new' });
    expect((await s.retrieveCustomer(ACCT, 'cus_1')).defaultPaymentMethodId).toBe('pm_new');
    expect(s.subscriptionDefaultPm(ACCT, 'sub_1')).toBe('pm_new');
  });

  it('listSubscriptions filtre par statut', async () => {
    const s = setup();
    s.addSubscription(ACCT, { id: 'sub_2', customerId: 'cus_1', status: 'active', planName: 'Pro', amount: 4900, currency: 'EUR', interval: 'month' });
    const active = await s.listSubscriptions(ACCT, { statuses: ['active'] });
    expect(active.map((x) => x.id)).toEqual(['sub_2']);
  });

  it('simule une panne Stripe puis un retour à la normale', async () => {
    const s = setup();
    s.failNext(new GatewayError('boum', { kind: 'api', retryable: true }));
    await expect(s.retrieveInvoice(ACCT, 'in_1')).rejects.toMatchObject({ retryable: true });
    await expect(s.retrieveInvoice(ACCT, 'in_1')).resolves.toBeDefined();
  });

  it('OAuth : échange de code et révocation', async () => {
    const s = setup();
    s.setOAuthCode('code_ok', { stripeUserId: 'acct_9', livemode: false });
    expect(await s.exchangeOAuthCode('code_ok')).toEqual({ stripeUserId: 'acct_9', livemode: false });
    await expect(s.exchangeOAuthCode('code_bad')).rejects.toMatchObject({ kind: 'invalid_request' });
    await s.deauthorize('acct_9');
    expect(s.deauthorized).toContain('acct_9');
  });

  it('retrouve la facture d’un PaymentIntent', async () => {
    const s = setup();
    s.linkPaymentIntent(ACCT, 'pi_1', 'in_1');
    expect(await s.invoiceIdForPaymentIntent(ACCT, 'pi_1')).toBe('in_1');
    expect(await s.invoiceIdForPaymentIntent(ACCT, 'pi_x')).toBeNull();
  });
});
