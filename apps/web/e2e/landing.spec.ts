import { expect, test } from '@playwright/test';
import { e2e, expectNoA11yViolations } from './helpers';

test.beforeAll(async ({ request }) => {
  await e2e(request, 'clock', { set: '2026-11-03T09:00:00Z' });
});

test('le site : message, calculateur, FAQ, liens légaux, accessibilité', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Récupérez les abonnements perdus');
  await expect(page.getByText('Exemple avec des données fictives')).toBeVisible();

  const total = page.getByTestId('year-total');
  const before = await total.textContent();
  const mrr = page.getByLabel(/revenu mensuel/i);
  await mrr.focus();
  await mrr.press('End');
  await expect(total).not.toHaveText(before!);

  const first = page.locator('details').first();
  await first.locator('summary').click();
  await expect(first).toHaveAttribute('open', '');

  await expect(page.getByRole('link', { name: /mentions légales/i })).toHaveAttribute('href', '/mentions-legales');
  await expect(page.getByText(/Le plus choisi/i)).toHaveCount(0);
  expect(await page.locator('body').innerText()).not.toMatch(/\[[A-Z]{2,}\]|lorem/i);
  await expectNoA11yViolations(page);
});

test('pages légales, login, robots', async ({ page, request }) => {
  for (const path of ['/mentions-legales', '/confidentialite', '/login']) {
    await page.goto(path);
    await expectNoA11yViolations(page);
  }
  // Aucune consigne destinée à l'exploitant sur les pages publiques.
  for (const path of ['/mentions-legales', '/confidentialite']) {
    await page.goto(path);
    const text = await page.locator('main').innerText();
    expect(text).not.toMatch(/exploitant|dans ce fichier|LEGAL_|mise en production/i);
  }
  await page.goto('/mentions-legales');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Mentions légales');
  const robots = await request.get('/robots.txt');
  expect(await robots.text()).toContain('Disallow: /app');
});

test('en-têtes de sécurité sur le site et les pages client', async ({ request }) => {
  const res = await request.get('/');
  expect(res.headers()['x-content-type-options']).toBe('nosniff');
  expect(res.headers()['content-security-policy']).toBeTruthy();
  const pay = await request.get('/pay/jeton-inconnu');
  expect(pay.headers()['cache-control']).toContain('no-store');
  expect(pay.headers()['x-robots-tag']).toContain('noindex');
});

test('vitrine : le bouton du bandeau bleu a un anneau de focus blanc visible', async ({ page }) => {
  await page.goto('/');
  const cta = page.locator('.m-final a.btn');
  await cta.focus();
  await expect(cta).toBeFocused();
  const outline = await cta.evaluate((el) => getComputedStyle(el).outlineColor);
  expect(outline).toBe('rgb(255, 255, 255)');
});
