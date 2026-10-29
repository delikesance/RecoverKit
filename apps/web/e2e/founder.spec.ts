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

test('emails désactivés : l’interface ne dit plus « Relances actives » et prévient que les relances sont abandonnées', async ({ page, request }) => {
  const n = uid();
  await login(page, request, `off-${n}@example.com`);
  await completeOnboarding(page, request, `acct_${n}`);

  await page.goto('/app/settings');
  await expect(page.locator('.chip', { hasText: 'Relances actives' })).toBeVisible();
  await page.getByLabel('Envoyer les emails de relance').uncheck();
  await page.getByRole('button', { name: 'Enregistrer', exact: true }).first().click();

  await page.goto('/app/settings');
  await expect(page.locator('.chip', { hasText: 'Emails désactivés' })).toBeVisible();
  await expect(page.locator('.chip', { hasText: 'Relances actives' })).toHaveCount(0);
  await expect(page.getByText(/abandonnées, pas reportées/).first()).toBeVisible();
  await page.goto('/app/sequence');
  await expect(page.locator('.chip', { hasText: 'Emails désactivés' })).toBeVisible();
  await expect(page.getByText(/12 heures minimum séparent deux emails/)).toBeVisible();
});

test('filtres des dossiers : virgule décimale acceptée, valeur invalide signalée, état vide exact', async ({ page, request }) => {
  const n = uid();
  await login(page, request, `filtre-${n}@example.com`);
  await completeOnboarding(page, request, `acct_${n}`);
  await failInvoice(request, `acct_${n}`, { n, email: `c-${n}@example.com`, name: 'Client Filtre', amount: 2900 });

  await page.goto('/app/cases?min=20,5');
  await expect(page.getByText('Client Filtre')).toBeVisible();
  await page.goto('/app/cases?min=30,5');
  await expect(page.getByText('Aucun dossier ne correspond à ces filtres.')).toBeVisible();
  await page.goto('/app/cases?min=abc');
  await expect(page.locator('.banner[role="alert"]')).toContainText('Montant minimum invalide');
  await page.goto('/app/cases?state=lost');
  await expect(page.getByText('Aucun dossier ne correspond à ces filtres.')).toBeVisible();
  await expect(page.getByText('Aucun paiement en cours de relance')).toHaveCount(0);
});

test('modèle d’email invalide : erreur et brouillon via un flash cookie, jamais dans l’URL, lus une seule fois', async ({ page, request }) => {
  const n = uid();
  await login(page, request, `tpl-${n}@example.com`);
  await completeOnboarding(page, request, `acct_${n}`);
  await page.goto('/app/emails');
  await page.locator('#subject-0').fill('Mon objet sans lien');
  await page.locator('#body-0').fill('Texte sans le lien obligatoire');
  await page.getByRole('button', { name: 'Enregistrer' }).first().click();
  await expect(page.locator('.banner[role="alert"]')).toBeVisible();
  await expect(page.locator('#subject-0')).toHaveValue('Mon objet sans lien');
  await expect(page.locator('#body-0')).toHaveValue('Texte sans le lien obligatoire');
  expect(page.url()).not.toMatch(/error|draft|Mon\+objet|Mon%20objet/);
  // Lu une seule fois : au rechargement le brouillon et l'erreur ont disparu.
  await page.goto('/app/emails');
  await expect(page.locator('.banner[role="alert"]')).toHaveCount(0);
  await expect(page.locator('#body-0')).not.toHaveValue('Texte sans le lien obligatoire');
  // Un texte forgé dans l'URL n'est plus jamais affiché.
  await page.goto('/app/emails?step=0&error=Votre+compte+est+suspendu&draftSubject=forge&draftBody=forge');
  await expect(page.locator('.banner[role="alert"]')).toHaveCount(0);
  await expect(page.getByText('Votre compte est suspendu')).toHaveCount(0);
  await expect(page.locator('#subject-0')).not.toHaveValue('forge');
});

test('mobile : la navigation tient sur une ligne défilante et n’occupe pas la moitié de l’écran', async ({ page, request }) => {
  const n = uid();
  await page.setViewportSize({ width: 375, height: 800 });
  await login(page, request, `mob-${n}@example.com`);
  await completeOnboarding(page, request, `acct_${n}`);
  await page.goto('/app');
  const box = await page.getByRole('navigation', { name: 'Principal' }).boundingBox();
  expect(box!.height).toBeLessThan(80);
  await expectNoA11yViolations(page);
});

test('onboarding : l’activation exige un nom d’entreprise autre que « Mon entreprise »', async ({ page, request }) => {
  const n = uid();
  await login(page, request, `nom-${n}@example.com`);
  await page.goto('/app/onboarding');
  await expect(page.getByLabel('Nom affiché à vos clients')).toHaveValue('');
  await expect(page.getByText('Il est requis pour activer les relances.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Activer les relances' })).toBeDisabled();
});
