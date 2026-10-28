import { expect, type APIRequestContext, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const TOKEN = 'e2e-secret-token';
const headers = { 'x-e2e-token': TOKEN, 'content-type': 'application/json' };

export async function e2e(request: APIRequestContext, action: string, body?: unknown) {
  const res = body === undefined && action !== 'worker'
    ? await request.get(`/api/e2e/${action}`, { headers })
    : await request.post(`/api/e2e/${action}`, { headers, data: body ?? {} });
  expect(res.ok(), `${action} -> ${res.status()}`).toBeTruthy();
  return res.json();
}

export const stripeOp = (request: APIRequestContext, op: Record<string, unknown>) => e2e(request, 'stripe', op);

export async function expectNoA11yViolations(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);
}

let counter = 0;
export const uid = () => `${Date.now().toString(36)}${(counter++).toString(36)}`;

export async function lastEmailTo(request: APIRequestContext, to: string) {
  const { emails } = await e2e(request, 'mailbox');
  const mine = emails.filter((m: { to: string }) => m.to === to);
  return mine.at(-1) as { subject: string; text: string; html: string } | undefined;
}

/** Connexion fondateur par lien magique, avec l'email lu dans la fausse boîte. */
export async function login(page: Page, request: APIRequestContext, email: string) {
  await page.goto('/login');
  await page.getByLabel('Adresse email').fill(email);
  await page.getByRole('button', { name: 'Recevoir mon lien' }).click();
  await expect(page.getByRole('heading', { name: 'Vérifiez votre boîte mail' })).toBeVisible();
  const mail = await lastEmailTo(request, email);
  expect(mail).toBeTruthy();
  const link = /https?:\/\/[^\s"<]+\/auth\/verify\?token=[^\s"<]+/.exec(mail!.text)![0];
  await page.goto(new URL(link).pathname + new URL(link).search);
  await page.getByRole('button', { name: 'Me connecter' }).click();
}

/** Parcourt l'onboarding jusqu'au bout avec Stripe factice. Renvoie l'identifiant du compte connecté. */
export async function completeOnboarding(page: Page, request: APIRequestContext, account: string) {
  const code = `code_${account}`;
  await stripeOp(request, { op: 'setOAuthCode', code, stripeUserId: account, livemode: false });
  // Playwright n'intercepte pas les redirections suivantes : on lit le Location de /oauth/start et on court-circuite Stripe.
  await page.route('**/api/stripe/oauth/start', async (route) => {
    const res = await route.fetch({ maxRedirects: 0 });
    const state = new URL(res.headers()['location']!).searchParams.get('state')!;
    await route.fulfill({ status: 302, headers: { location: `/api/stripe/oauth/callback?code=${code}&state=${state}` } });
  });
  await expect(page).toHaveURL(/\/app\/onboarding/);
  await page.getByRole('link', { name: 'Se connecter avec Stripe' }).click();
  await expect(page.locator('.chip', { hasText: 'Stripe connecté' })).toBeVisible();
  await page.getByRole('button', { name: 'Garder l’expéditeur par défaut' }).click();
  await page.getByRole('button', { name: 'C’est fait dans Stripe' }).click();
  await page.getByRole('button', { name: 'M’envoyer un email de test' }).click();
  await page.getByRole('button', { name: 'Activer les relances' }).click();
  await expect(page.getByRole('link', { name: 'Aller au tableau de bord' })).toBeVisible();
}

/** Prépare un client, un abonnement et une facture impayée, puis livre l'échec de paiement et fait tourner le worker. */
export async function failInvoice(request: APIRequestContext, account: string, o: { n: string; email: string; name: string; amount?: number; locale?: string }) {
  const amount = o.amount ?? 2900;
  await stripeOp(request, { op: 'addCustomer', account, customer: { id: `cus_${o.n}`, email: o.email, name: o.name, locale: o.locale ?? 'fr', defaultPaymentMethodId: null } });
  await stripeOp(request, { op: 'addSubscription', account, subscription: { id: `sub_${o.n}`, customerId: `cus_${o.n}`, status: 'past_due', planName: 'Pro', amount, currency: 'EUR', interval: 'month' } });
  await stripeOp(request, { op: 'addInvoice', account, invoice: { id: `in_${o.n}`, customerId: `cus_${o.n}`, subscriptionId: `sub_${o.n}`, status: 'open', amountDue: amount, amountPaid: 0, currency: 'EUR', attemptCount: 1, planName: 'Pro' } });
  await e2e(request, 'events', {
    account,
    type: 'invoice.payment_failed',
    object: { id: `in_${o.n}`, object: 'invoice', customer: `cus_${o.n}`, subscription: `sub_${o.n}`, status: 'open', amount_due: amount, amount_paid: 0, currency: 'eur', attempt_count: 1 },
  });
  await e2e(request, 'worker');
}
