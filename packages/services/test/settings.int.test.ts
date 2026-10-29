import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getCaseByInvoice, listStepsForCase } from '@recoverkit/db';
import { createTestDb, seedTenant, type TestDb } from '@recoverkit/testkit';
import { getSequence, saveSequence } from '../src/settings/sequence';
import { getTemplates, previewTemplate, resetTemplate, saveTemplate, sendTestEmail } from '../src/settings/templates';
import { acknowledgeNativeEmails, confirmDefaultSender, getOnboardingStatus, setDryRun, updateSettings } from '../src/settings/general';
import { configureSender } from '../src/settings/sender';
import { processInbox } from '../src/webhooks/process';
import { makeDeps } from './helpers';
import { deliver, invoiceObject, setupScenario } from './scenario';

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.dispose();
});

const tenant = async (id: string) => (await db.pool.query(`select * from tenants where id = $1`, [id])).rows[0];
async function newTenant() {
  const t = await seedTenant(db.pool, { dryRun: true });
  await db.pool.query(`insert into sequences (tenant_id, version, steps) values ($1, 1, '[{"index":0,"delayMinutes":60,"active":true}]'::jsonb)`, [t.id]);
  return t;
}

describe('éditeur de séquence', () => {
  it('enregistre une nouvelle version avec des index recalculés', async () => {
    const deps = makeDeps(db);
    const t = await newTenant();
    const r = await saveSequence(deps, t.id, [
      { delayMinutes: 120, active: true },
      { delayMinutes: 2880, active: true },
      { delayMinutes: 10080, active: false },
    ]);
    expect(r).toEqual({ status: 'ok', version: 2 });
    expect(await getSequence(deps, t.id)).toEqual({
      version: 2,
      steps: [
        { index: 0, delayMinutes: 120, active: true },
        { index: 1, delayMinutes: 2880, active: true },
        { index: 2, delayMinutes: 10080, active: false },
      ],
    });
  });

  it.each([
    ['vide', [], /au moins/],
    ['trop longue', Array.from({ length: 7 }, (_, i) => ({ delayMinutes: 60 * (i + 1), active: true })), /6/],
    ['délai trop court', [{ delayMinutes: 30, active: true }], /1 heure/],
    ['délais non croissants', [{ delayMinutes: 600, active: true }, { delayMinutes: 600, active: true }], /croissant/],
    ['délai trop long', [{ delayMinutes: 61 * 1440, active: true }], /60 jours/],
    ['aucune étape active', [{ delayMinutes: 60, active: false }], /active/],
  ])('refuse une séquence %s', async (_label, steps, message) => {
    const deps = makeDeps(db);
    const t = await newTenant();
    const r = await saveSequence(deps, t.id, steps as any);
    expect(r.status).toBe('invalid');
    if (r.status === 'invalid') expect(r.errors.join(' ')).toMatch(message);
    expect((await getSequence(deps, t.id))!.version).toBe(1);
  });

  it('n’affecte que les nouveaux dossiers : les étapes déjà planifiées gardent leur version', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    await deliver(deps, s, 'invoice.payment_failed', invoiceObject(s));
    await processInbox(deps);
    const before = (await getCaseByInvoice(db.pool, s.tenantId, s.invoiceId))!;
    const stepsBefore = await listStepsForCase(db.pool, s.tenantId, before.id);
    expect(before.sequenceVersion).toBe(1);

    await saveSequence(deps, s.tenantId, [{ delayMinutes: 120, active: true }, { delayMinutes: 7200, active: true }]);
    expect(await listStepsForCase(db.pool, s.tenantId, before.id)).toEqual(stepsBefore);

    const s2 = { ...s, invoiceId: 'in_new_after_edit' };
    deps.stripe.addInvoice(s.account, { id: s2.invoiceId, customerId: s.customerId, subscriptionId: s.subscriptionId, status: 'open', amountDue: 2900, amountPaid: 0, currency: 'EUR', attemptCount: 1 });
    await deliver(deps, s2, 'invoice.payment_failed', invoiceObject(s2));
    await processInbox(deps);
    const fresh = (await getCaseByInvoice(db.pool, s.tenantId, s2.invoiceId))!;
    expect(fresh.sequenceVersion).toBe(2);
    expect(await listStepsForCase(db.pool, s.tenantId, fresh.id)).toHaveLength(2);
  });
});

describe('éditeur de modèles', () => {
  it('renvoie les modèles par défaut puis les modèles personnalisés', async () => {
    const deps = makeDeps(db);
    const t = await newTenant();
    const before = await getTemplates(deps, t.id, 'fr');
    expect(before[0]).toMatchObject({ stepIndex: 0, isCustom: false });
    expect(before[0]!.body).toContain('{{update_link}}');

    const r = await saveTemplate(deps, t.id, { stepIndex: 0, locale: 'fr', subject: 'Perso {{amount}}', body: 'Salut {{customer_name}}\n\n{{update_link}}' });
    expect(r).toEqual({ status: 'ok' });
    const after = await getTemplates(deps, t.id, 'fr');
    expect(after[0]).toMatchObject({ subject: 'Perso {{amount}}', isCustom: true });
    expect((await getTemplates(deps, t.id, 'en'))[0]!.isCustom).toBe(false);
  });

  it('séquence de 6 étapes : étapes 4 et 5 intermédiaires, « dernier avis » seulement pour la dernière', async () => {
    const deps = makeDeps(db);
    const t = await newTenant();
    await saveSequence(deps, t.id, Array.from({ length: 6 }, (_, i) => ({ delayMinutes: 60 * (i + 1), active: true })));
    for (const locale of ['fr', 'en'] as const) {
      const tpl = await getTemplates(deps, t.id, locale);
      expect(tpl).toHaveLength(6);
      const subjects = tpl.map((x) => x.subject);
      expect(new Set(subjects).size).toBe(6);
      const final = /dernier avis|final notice/i;
      const last = /dernier message|last message/i;
      for (const i of [0, 1, 2, 3, 4]) {
        expect(tpl[i]!.subject).not.toMatch(final);
        expect(tpl[i]!.body).not.toMatch(last);
      }
      expect(tpl[5]!.subject).toMatch(final);
      expect(tpl[5]!.body).toMatch(last);
    }
  });

  it('séquence de 4 étapes ou moins : comportement inchangé (dernier avis à l’index 3)', async () => {
    const deps = makeDeps(db);
    const t = await newTenant();
    const tpl = await getTemplates(deps, t.id, 'fr');
    expect(tpl).toHaveLength(4);
    expect(tpl[3]!.subject).toMatch(/dernier avis/i);
  });

  it('refuse un modèle invalide avec le détail de l’erreur', async () => {
    const deps = makeDeps(db);
    const t = await newTenant();
    const r = await saveTemplate(deps, t.id, { stepIndex: 0, locale: 'fr', subject: 'Salut', body: 'Pas de lien {{inconnue}}' });
    expect(r.status).toBe('invalid');
    if (r.status === 'invalid') expect(r.errors.join(' ')).toMatch(/inconnue|update_link/);
  });

  it('restaure le modèle par défaut', async () => {
    const deps = makeDeps(db);
    const t = await newTenant();
    await saveTemplate(deps, t.id, { stepIndex: 1, locale: 'fr', subject: 'x', body: '{{update_link}}' });
    await resetTemplate(deps, t.id, 1, 'fr');
    expect((await getTemplates(deps, t.id, 'fr'))[1]!.isCustom).toBe(false);
  });

  it('aperçu avec des données d’exemple', () => {
    const p = previewTemplate({ subject: 'Paiement de {{amount}}', body: 'Bonjour {{customer_name}}\n\n{{update_link}}' }, 'fr', 'Nimbus Notes');
    expect(p.subject.replace(/\s/g, ' ')).toBe('Paiement de 29,00 €');
    expect(p.html).toContain('Camille');
    expect(p.html).toContain('Nimbus Notes');
  });

  it('envoi de test au fondateur : préfixé, limité à 5 par heure, mémorisé pour l’onboarding', async () => {
    const deps = makeDeps(db);
    const t = await newTenant();
    const results = [];
    for (let i = 0; i < 6; i++) results.push(await sendTestEmail(deps, t.id, 'fondateur@example.com', { stepIndex: 0, locale: 'fr' }));
    expect(results.map((r) => r.status)).toEqual(['sent', 'sent', 'sent', 'sent', 'sent', 'rate_limited']);
    const mail = deps.mailer.sent[0]!;
    expect(mail.to).toBe('fondateur@example.com');
    expect(mail.subject.startsWith('[Test] ')).toBe(true);
    expect(mail.html).toContain('Mode test');
    expect((await tenant(t.id)).onboarding.testEmailSentAt).toBeTruthy();
  });
});

describe('réglages généraux', () => {
  it('met à jour nom, fuseau, fenêtre, contacts, langue, digest', async () => {
    const deps = makeDeps(db);
    const t = await newTenant();
    const r = await updateSettings(deps, t.id, {
      name: 'Nimbus Notes', timeZone: 'America/New_York', sendStartHour: 8, sendEndHour: 20, supportEmail: 'help@nimbusnotes.example',
      replyTo: 'billing@nimbusnotes.example', locale: 'en', emailsEnabled: false, digestEnabled: false,
    });
    expect(r).toEqual({ status: 'ok' });
    expect(await tenant(t.id)).toMatchObject({
      name: 'Nimbus Notes', time_zone: 'America/New_York', send_start_hour: 8, send_end_hour: 20, support_email: 'help@nimbusnotes.example',
      reply_to: 'billing@nimbusnotes.example', locale: 'en', emails_enabled: false, digest_enabled: false,
    });
  });

  it.each([
    [{ timeZone: 'Mars/Olympus' }, /fuseau/],
    [{ sendStartHour: 19, sendEndHour: 9 }, /fenêtre/],
    [{ sendStartHour: -1 }, /heure/],
    [{ sendEndHour: 25 }, /heure/],
    [{ name: '   ' }, /nom/],
    [{ supportEmail: 'pas-un-email' }, /email/],
    [{ locale: 'de' as any }, /langue/],
  ])('refuse %j', async (input, message) => {
    const deps = makeDeps(db);
    const t = await newTenant();
    const r = await updateSettings(deps, t.id, input as any);
    expect(r.status).toBe('invalid');
    if (r.status === 'invalid') expect(r.errors.join(' ')).toMatch(new RegExp(message.source, 'i'));
  });

  it('une mise à jour partielle ne touche pas les autres champs', async () => {
    const deps = makeDeps(db);
    const t = await newTenant();
    await updateSettings(deps, t.id, { name: 'A', sendStartHour: 10 });
    await updateSettings(deps, t.id, { name: 'B' });
    expect(await tenant(t.id)).toMatchObject({ name: 'B', send_start_hour: 10 });
  });
});

describe('activation sécurisée et onboarding', () => {
  async function ready(deps: ReturnType<typeof makeDeps>, t: { id: string }) {
    await db.pool.query(`insert into stripe_connections (tenant_id, stripe_account_id, status) values ($1,$2,'ACTIVE') on conflict (tenant_id) do nothing`, [t.id, `acct_${t.id.slice(0, 8)}`]);
    await acknowledgeNativeEmails(deps, t.id);
    await sendTestEmail(deps, t.id, 'f@example.com', { stepIndex: 0, locale: 'fr' });
  }

  it('refuse l’activation tant qu’il manque Stripe, l’accusé de réception ou le test', async () => {
    const deps = makeDeps(db);
    const t = await newTenant();
    let r = await setDryRun(deps, t.id, false, 'user:u1');
    expect(r).toEqual({ status: 'blocked', missing: ['stripe_connected', 'native_emails_acknowledged', 'test_email_sent'] });
    expect((await tenant(t.id)).dry_run).toBe(true);

    await db.pool.query(`insert into stripe_connections (tenant_id, stripe_account_id, status) values ($1,'acct_x1','ACTIVE')`, [t.id]);
    r = await setDryRun(deps, t.id, false, 'user:u1');
    expect(r).toEqual({ status: 'blocked', missing: ['native_emails_acknowledged', 'test_email_sent'] });
  });

  it('active quand tout est en place, et journalise la bascule', async () => {
    const deps = makeDeps(db);
    const t = await newTenant();
    await ready(deps, t);
    expect(await setDryRun(deps, t.id, false, 'user:u1')).toEqual({ status: 'ok' });
    expect((await tenant(t.id)).dry_run).toBe(false);
    const log = await db.pool.query(`select action, actor from action_log where tenant_id = $1 order by id desc limit 1`, [t.id]);
    expect(log.rows[0]).toEqual({ action: 'tenant.activated', actor: 'user:u1' });
  });

  it('un expéditeur personnalisé non vérifié bloque l’activation', async () => {
    const deps = makeDeps(db);
    const t = await newTenant();
    await ready(deps, t);
    await configureSender(deps, t.id, { email: 'billing@nimbusnotes.example', name: 'Nimbus' });
    expect(await setDryRun(deps, t.id, false, 'user:u1')).toEqual({ status: 'blocked', missing: ['sender_valid'] });
    deps.domains.markVerified((await tenant(t.id)).sender_domain_id);
    const { checkSenderDomain } = await import('../src/settings/sender');
    await checkSenderDomain(deps, t.id);
    expect(await setDryRun(deps, t.id, false, 'user:u1')).toEqual({ status: 'ok' });
  });

  it('repasser en dry-run est toujours possible', async () => {
    const deps = makeDeps(db);
    const t = await newTenant();
    await ready(deps, t);
    await setDryRun(deps, t.id, false, 'user:u1');
    expect(await setDryRun(deps, t.id, true, 'user:u1')).toEqual({ status: 'ok' });
    expect((await tenant(t.id)).dry_run).toBe(true);
  });

  it('suit la progression des 4 étapes et permet la reprise', async () => {
    const deps = makeDeps(db);
    const t = await newTenant();
    let s = await getOnboardingStatus(deps, t.id);
    expect(s.steps.map((x) => [x.key, x.done])).toEqual([['stripe', false], ['sender', false], ['native_emails', false], ['activate', false]]);
    expect(s.current).toBe('stripe');

    await db.pool.query(`insert into stripe_connections (tenant_id, stripe_account_id, status) values ($1,'acct_x2','ACTIVE')`, [t.id]);
    await confirmDefaultSender(deps, t.id);
    s = await getOnboardingStatus(deps, t.id);
    expect(s.current).toBe('native_emails');
    expect(s.steps.slice(0, 2).every((x) => x.done)).toBe(true);

    await acknowledgeNativeEmails(deps, t.id);
    await sendTestEmail(deps, t.id, 'f@example.com', { stepIndex: 0, locale: 'fr' });
    s = await getOnboardingStatus(deps, t.id);
    expect(s.current).toBe('activate');
    await setDryRun(deps, t.id, false, 'user:u1');
    s = await getOnboardingStatus(deps, t.id);
    expect(s.current).toBeNull();
    expect(s.complete).toBe(true);
  });
});
