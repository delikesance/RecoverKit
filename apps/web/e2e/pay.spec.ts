import { expect, test } from '@playwright/test';
import { completeOnboarding, e2e, expectNoA11yViolations, failInvoice, lastEmailTo, login, uid } from './helpers';

test.beforeAll(async ({ request }) => {
  await e2e(request, 'clock', { set: '2026-11-03T09:00:00Z' });
});

/** Fondateur actif + un client en échec dont la 1re relance est partie ; renvoie le lien de paiement. */
async function setup(browser: import('@playwright/test').Browser, request: import('@playwright/test').APIRequestContext, locale = 'fr') {
  const n = uid();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const account = `acct_${n}`;
  await login(page, request, `f-${n}@example.com`);
  await completeOnboarding(page, request, account);
  await ctx.close();
  await failInvoice(request, account, { n, email: `c-${n}@example.com`, name: 'Alex Martin', locale });
  await e2e(request, 'clock', { advanceMinutes: 90 });
  await e2e(request, 'worker');
  const mail = await lastEmailTo(request, `c-${n}@example.com`);
  expect(mail, 'la 1re relance doit être partie').toBeTruthy();
  const link = /\/pay\/[A-Za-z0-9_-]+/.exec(mail!.text)![0];
  return { n, link, account };
}

test('client mobile : email, lien, carte valide, paiement réussi, lien consommé', async ({ browser, page, request }) => {
  const { link, n } = await setup(browser, request);
  await page.goto(link);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('paiement');
  await expectNoA11yViolations(page);

  await page.getByLabel(/numéro de carte/i).fill('4242 4242 4242 4242');
  await page.getByRole('button', { name: /mettre à jour et payer/i }).click();
  await expect(page.getByTestId('pay-result')).toHaveAttribute('data-status', 'paid');
  await expectNoA11yViolations(page);

  await e2e(request, 'events', {
    account: `acct_${n}`,
    type: 'invoice.paid',
    object: { id: `in_${n}`, object: 'invoice', customer: `cus_${n}`, subscription: `sub_${n}`, status: 'paid', amount_due: 2900, amount_paid: 2900, currency: 'eur' },
  });
  await e2e(request, 'worker');

  await page.goto(link);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('déjà réglé');
});

test('carte refusée : message précis puis nouvel essai possible', async ({ browser, page, request }) => {
  const { link } = await setup(browser, request);
  await page.goto(link);
  await page.getByLabel(/numéro de carte/i).fill('4000 0000 0000 9995');
  await page.getByRole('button', { name: /mettre à jour et payer/i }).click();
  await expect(page.getByTestId('pay-result')).toHaveAttribute('data-status', 'card_failed');
  await expect(page.getByText(/fonds insuffisants/i)).toBeVisible();
  await expectNoA11yViolations(page);

  await page.getByRole('link', { name: /autre carte/i }).click();
  await page.getByLabel(/numéro de carte/i).fill('4242 4242 4242 4242');
  await page.getByRole('button', { name: /mettre à jour et payer/i }).click();
  await expect(page.getByTestId('pay-result')).toHaveAttribute('data-status', 'paid');
});

test('lien invalide : page neutre, sans accès au dashboard', async ({ page }) => {
  await page.goto('/pay/n-importe-quoi');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('plus valide');
  await expectNoA11yViolations(page);
  await page.goto('/app');
  await expect(page).toHaveURL(/\/login/);
});

test('client anglophone : page en anglais', async ({ browser, page, request }) => {
  const { link } = await setup(browser, request, 'en');
  await page.goto(link);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('didn’t go through');
  await expect(page.getByRole('button', { name: /update and pay/i })).toBeVisible();
});

test('mise en page mobile : pas de défilement horizontal', async ({ browser, page, request }) => {
  const { link } = await setup(browser, request);
  await page.goto(link);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  expect(overflow).toBe(false);
});
