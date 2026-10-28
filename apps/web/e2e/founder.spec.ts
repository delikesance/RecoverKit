import { expect, test } from '@playwright/test';
import { completeOnboarding, e2e, expectNoA11yViolations, failInvoice, lastEmailTo, login, uid } from './helpers';

test.beforeAll(async ({ request }) => {
  await e2e(request, 'clock', { set: '2026-11-03T09:00:00Z' });
});

test('sans session, /app redirige vers la connexion', async ({ page }) => {
  await page.goto('/app/cases');
  await expect(page).toHaveURL(/\/login/);
});

test('parcours fondateur : connexion, onboarding, échec, pause, clôture, export', async ({ page, request }) => {
  const n = uid();
  const email = `fondateur-${n}@example.com`;
  const account = `acct_${n}`;

  await login(page, request, email);
  await expectNoA11yViolations(page);
  await completeOnboarding(page, request, account);
  await page.getByRole('link', { name: 'Aller au tableau de bord' }).click();
  await expect(page).toHaveURL(/\/app$/);
  await expectNoA11yViolations(page);

  await failInvoice(request, account, { n, email: `client-${n}@example.com`, name: 'Camille Durand' });

  await page.goto('/app/cases');
  await expect(page.getByText('Camille Durand')).toBeVisible();
  await expectNoA11yViolations(page);

  await page.getByText('Camille Durand').first().click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Camille Durand');
  await expectNoA11yViolations(page);

  await page.getByRole('button', { name: 'Mettre en pause' }).click();
  await expect(page.locator('.chip', { hasText: 'En pause' })).toBeVisible();
  await page.getByRole('button', { name: 'Reprendre les relances' }).click();
  await expect(page.locator('.chip', { hasText: 'En pause' })).toHaveCount(0);
  await expect(page.getByText(/mis en pause|pause/i).first()).toBeVisible(); // l’historique garde la trace

  const csv = await page.request.get('/api/app/export/recovered');
  expect(csv.status()).toBe(200);
  expect(csv.headers()['content-type']).toContain('text/csv');

  for (const path of ['/app/recovered', '/app/sequence', '/app/emails', '/app/settings', '/app/billing']) {
    await page.goto(path);
    await expectNoA11yViolations(page);
  }

  await page.goto('/app/cases');
  await page.getByText('Camille Durand').first().click();
  await page.locator('summary', { hasText: 'Clôturer le dossier' }).click();
  await page.getByLabel(/motif/i).fill('Client résilié par téléphone');
  await page.getByRole('button', { name: 'Clôturer', exact: true }).click();
  await expect(page.getByText('Clôturé').first()).toBeVisible();
});

test('un fondateur ne voit jamais le dossier d’un autre', async ({ browser, request }) => {
  const a = uid();
  const b = uid();
  const pageA = await (await browser.newContext()).newPage();
  const pageB = await (await browser.newContext()).newPage();
  await login(pageA, request, `a-${a}@example.com`);
  await completeOnboarding(pageA, request, `acct_${a}`);
  await login(pageB, request, `b-${b}@example.com`);
  await completeOnboarding(pageB, request, `acct_${b}`);
  await failInvoice(request, `acct_${a}`, { n: a, email: `c-${a}@example.com`, name: 'Client Secret' });

  await pageA.goto('/app/cases');
  const href = await pageA.getByText('Client Secret').first().locator('xpath=ancestor-or-self::a[1]').getAttribute('href');
  expect(href).toMatch(/\/app\/cases\//);
  await pageB.goto('/app/cases');
  await expect(pageB.getByText('Client Secret')).toHaveCount(0);
  expect((await pageB.goto(href!))!.status()).toBe(404);
});

test('déconnexion : la session ne donne plus accès', async ({ page, request }) => {
  const n = uid();
  await login(page, request, `bye-${n}@example.com`);
  await page.getByRole('button', { name: /déconnexion|se déconnecter/i }).click();
  await page.goto('/app');
  await expect(page).toHaveURL(/\/login/);
  expect(await lastEmailTo(request, `bye-${n}@example.com`)).toBeTruthy();
});
