import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getCaseByInvoice, listCaseActions, listStepsForCase, recoverStaleReservations, reserveDueSteps } from '@recoverkit/db';
import { FakeMailer, MailerError } from '@recoverkit/mail';
import { GatewayError } from '@recoverkit/stripe';
import { createTestDb, seedCase, seedTenant, type TestDb } from '@recoverkit/testkit';
import { handleDeauthorized } from '../src/stripe/connect';
import { processInbox } from '../src/webhooks/process';
import { closeExhaustedCases, runDueSteps, sendReservedStep } from '../src/engine/send-steps';
import { makeDeps, type TestDeps } from './helpers';
import { deliver, invoiceObject, setupScenario, type Scenario } from './scenario';

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.dispose();
});
// chaque test part d'une file d'envoi vide (les horloges de test ne sont pas partagées)
beforeEach(async () => {
  await db.pool.query(`update scheduled_steps set status = 'CANCELED' where status in ('SCHEDULED', 'SENDING')`);
});

/** Ouvre un dossier via webhook, puis avance l'horloge de 90 min : l'étape 0 (+1 h) est échue. */
async function openCase(deps: TestDeps, s: Scenario) {
  await deliver(deps, s, 'invoice.payment_failed', invoiceObject(s));
  await processInbox(deps);
  deps.clock.advance({ minutes: 90 });
  const c = await getCaseByInvoice(db.pool, s.tenantId, s.invoiceId);
  return c!;
}

const stepRow = async (caseId: string, index: number) =>
  (await db.pool.query(`select status, skip_reason, attempts, message_id, due_at from scheduled_steps where case_id = $1 and step_index = $2`, [caseId, index])).rows[0];

class CrashAfterSend extends FakeMailer {
  crashed = false;
  override async send(e: Parameters<FakeMailer['send']>[0]) {
    const r = await super.send(e);
    if (!this.crashed) {
      this.crashed = true;
      throw new MailerError('timeout après envoi', { permanent: false });
    }
    return r;
  }
}

describe('envoi des étapes', () => {
  it('envoie l’email avec lien sécurisé, en-têtes de désinscription et expéditeur par défaut', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    const c = await openCase(deps, s);
    const stats = await runDueSteps(deps);
    expect(stats).toMatchObject({ sent: 1, skipped: 0, failed: 0 });

    expect(deps.mailer.sent).toHaveLength(1);
    const mail = deps.mailer.sent[0]!;
    expect(mail.to).toMatch(/@example\.com$/);
    expect(mail.idempotencyKey).toBe(`${c.id}:0`);
    expect(mail.subject).toContain('29,00');
    expect(mail.html).toMatch(/https:\/\/app\.recoverkit\.test\/pay\/[\w-]{43}/);
    expect(mail.text).toContain('/unsubscribe?');
    expect(mail.from.email).toBe('no-reply@mail.recoverkit.test');
    expect(mail.headers?.['List-Unsubscribe']).toMatch(/^<https:\/\/app\.recoverkit\.test\/api\/unsubscribe\?/);
    expect(mail.headers?.['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');

    const step = await stepRow(c.id, 0);
    expect(step.status).toBe('SENT');
    expect(step.message_id).toMatch(/^fake_/);
    const rec = await db.pool.query(`select idempotency_key, dry_run, status from email_messages where case_id = $1`, [c.id]);
    expect(rec.rows).toEqual([{ idempotency_key: `${c.id}:0`, dry_run: false, status: 'SENT' }]);
    expect((await listCaseActions(db.pool, s.tenantId, c.id)).map((a) => a.action)).toContain('email.sent');
  });

  it('n’envoie rien avant l’échéance', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    await deliver(deps, s, 'invoice.payment_failed', invoiceObject(s));
    await processInbox(deps);
    deps.clock.advance({ minutes: 30 });
    expect(await runDueSteps(deps)).toMatchObject({ sent: 0 });
    expect(deps.mailer.sent).toHaveLength(0);
  });

  it('utilise l’expéditeur du tenant seulement si son domaine est vérifié, et le Reply-To', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    await db.pool.query(
      `update tenants set sender_name = 'Équipe Nimbus', sender_email = 'billing@nimbusnotes.example', sender_verified = false, reply_to = 'help@nimbusnotes.example' where id = $1`,
      [s.tenantId],
    );
    await openCase(deps, s);
    await runDueSteps(deps);
    expect(deps.mailer.sent[0]!.from).toEqual({ name: 'Équipe Nimbus', email: 'no-reply@mail.recoverkit.test' });
    expect(deps.mailer.sent[0]!.replyTo).toBe('help@nimbusnotes.example');

    const deps2 = makeDeps(db);
    const s2 = await setupScenario(db, deps2);
    await db.pool.query(`update tenants set sender_email = 'billing@verified.example', sender_verified = true where id = $1`, [s2.tenantId]);
    await openCase(deps2, s2);
    await runDueSteps(deps2);
    expect(deps2.mailer.sent[0]!.from.email).toBe('billing@verified.example');
  });

  it('relit la facture chez Stripe : déjà payée = SKIPPED(already_paid), aucun email', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    const c = await openCase(deps, s);
    deps.stripe.markPaid(s.account, s.invoiceId);
    expect(await runDueSteps(deps)).toMatchObject({ sent: 0, skipped: 1 });
    expect(deps.mailer.sent).toHaveLength(0);
    expect(await stepRow(c.id, 0)).toMatchObject({ status: 'SKIPPED', skip_reason: 'already_paid' });
  });

  it('facture annulée côté Stripe : SKIPPED(invoice_closed)', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    const c = await openCase(deps, s);
    deps.stripe.addInvoice(s.account, { id: s.invoiceId, customerId: s.customerId, subscriptionId: s.subscriptionId, status: 'void', amountDue: 2900, amountPaid: 0, currency: 'EUR', attemptCount: 1 });
    await runDueSteps(deps);
    expect(await stepRow(c.id, 0)).toMatchObject({ status: 'SKIPPED', skip_reason: 'invoice_closed' });
  });

  it('client désinscrit ou rebondi : SKIPPED(suppressed)', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    const c = await openCase(deps, s);
    const email = (await db.pool.query(`select email from end_customers where tenant_id = $1`, [s.tenantId])).rows[0].email;
    await db.pool.query(`insert into suppressions (tenant_id, email, reason) values ($1,$2,'BOUNCED')`, [s.tenantId, email]);
    await runDueSteps(deps);
    expect(deps.mailer.sent).toHaveLength(0);
    expect(await stepRow(c.id, 0)).toMatchObject({ status: 'SKIPPED', skip_reason: 'suppressed' });
  });

  it('emails désactivés par le tenant : SKIPPED(disabled), la réactivation ne rejoue pas', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    const c = await openCase(deps, s);
    await db.pool.query(`update tenants set emails_enabled = false where id = $1`, [s.tenantId]);
    await runDueSteps(deps);
    expect(await stepRow(c.id, 0)).toMatchObject({ status: 'SKIPPED', skip_reason: 'disabled' });
    await db.pool.query(`update tenants set emails_enabled = true where id = $1`, [s.tenantId]);
    await runDueSteps(deps);
    expect(deps.mailer.sent).toHaveLength(0);
    expect((await stepRow(c.id, 0)).status).toBe('SKIPPED');
  });

  it('mode dry-run : étape SENT journalisée, aucun email envoyé', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps, { dryRun: true });
    const c = await openCase(deps, s);
    expect(await runDueSteps(deps)).toMatchObject({ sent: 1 });
    expect(deps.mailer.sent).toHaveLength(0);
    expect((await stepRow(c.id, 0)).status).toBe('SENT');
    const rec = await db.pool.query(`select dry_run from email_messages where case_id = $1`, [c.id]);
    expect(rec.rows).toEqual([{ dry_run: true }]);
    expect((await listCaseActions(db.pool, s.tenantId, c.id)).map((a) => a.action)).toContain('email.dry_run');
  });

  it('utilise la langue du client et un modèle personnalisé du tenant', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    await openCase(deps, s);
    await db.pool.query(`update end_customers set locale = 'en' where tenant_id = $1`, [s.tenantId]);
    await runDueSteps(deps);
    expect(deps.mailer.sent[0]!.subject).toContain('didn’t go through');

    const deps2 = makeDeps(db);
    const s2 = await setupScenario(db, deps2);
    await db.pool.query(
      `insert into email_templates (tenant_id, step_index, locale, subject, body) values ($1, 0, 'fr', 'Sujet perso {{amount}}', 'Salut {{customer_name}} !\n\n{{update_link}}')`,
      [s2.tenantId],
    );
    await openCase(deps2, s2);
    await runDueSteps(deps2);
    expect(deps2.mailer.sent[0]!.subject.replace(/\s/g, ' ')).toBe('Sujet perso 29,00 €');
    expect(deps2.mailer.sent[0]!.text).toContain('Salut Camille Roux !');
  });
});

describe('fiabilité : jamais deux envois', () => {
  it('deux workers en parallèle : un seul email par dossier (FakeMailer strict)', async () => {
    const deps = makeDeps(db);
    const scenarios = [];
    for (let i = 0; i < 8; i++) {
      const s = await setupScenario(db, deps);
      await deliver(deps, s, 'invoice.payment_failed', invoiceObject(s));
      scenarios.push(s);
    }
    await processInbox(deps, { limit: 50 });
    deps.clock.advance({ minutes: 90 });
    const tenantIds = new Set(scenarios.map((s) => s.tenantId));
    const [a, b] = await Promise.all([runDueSteps(deps, { limit: 5 }), runDueSteps(deps, { limit: 5 })]);
    await runDueSteps(deps, { limit: 50 });
    const mine = deps.mailer.sent.filter((m) => m.idempotencyKey.length > 0);
    const keys = mine.map((m) => m.idempotencyKey);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.length).toBe(8);
    // FakeMailer dédoublonne : seul le nombre d'appels à send prouve l'exactly-once
    for (const k of keys) expect(deps.mailer.callCount(k), `appels à send pour ${k}`).toBe(1);
    expect(a.sent + b.sent).toBeLessThanOrEqual(8);
    expect(tenantIds.size).toBe(8);
  });

  it('crash après l’envoi : le renvoi réutilise la clé d’idempotence, pas de doublon', async () => {
    const deps = makeDeps(db);
    const mailer = new CrashAfterSend();
    deps.mailer = mailer;
    const s = await setupScenario(db, deps);
    const c = await openCase(deps, s);

    const first = await runDueSteps(deps);
    expect(first).toMatchObject({ sent: 0, released: 1 });
    expect(mailer.sent).toHaveLength(1); // le fournisseur a bien reçu l'email
    expect((await stepRow(c.id, 0)).status).toBe('SCHEDULED');

    deps.clock.advance({ minutes: 6 });
    const second = await runDueSteps(deps);
    expect(second).toMatchObject({ sent: 1 });
    expect(mailer.sent).toHaveLength(1); // toujours un seul email
    expect(mailer.callCount(`${c.id}:0`)).toBe(2); // 2 appels (renvoi avec la même clé) pour 1 message
    expect(await stepRow(c.id, 0)).toMatchObject({ status: 'SENT', message_id: 'fake_1' });
  });

  it('réservation abandonnée depuis plus de 10 minutes : reprise sans doublon', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    const c = await openCase(deps, s);
    const [reserved] = await reserveDueSteps(db.pool, deps.clock.now(), 5, { tenantId: s.tenantId });
    expect(reserved).toBeDefined(); // un worker « meurt » ici
    expect(await runDueSteps(deps)).toMatchObject({ sent: 0 }); // trop récent : on ne touche pas
    deps.clock.advance({ minutes: 11 });
    expect(await runDueSteps(deps)).toMatchObject({ sent: 1 });
    expect(deps.mailer.sent).toHaveLength(1);
    expect((await stepRow(c.id, 0)).status).toBe('SENT');
  });

  it('un dossier mis en pause après la réservation est relâché, pas envoyé', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    const c = await openCase(deps, s);
    const [reserved] = await reserveDueSteps(db.pool, deps.clock.now(), 5, { tenantId: s.tenantId });
    await db.pool.query(`update recovery_cases set state = 'PAUSED' where id = $1`, [c.id]);
    expect(await sendReservedStep(deps, reserved!)).toBe('released');
    expect(deps.mailer.sent).toHaveLength(0);
    expect(await stepRow(c.id, 0)).toMatchObject({ status: 'SCHEDULED' });
  });

  it('un dossier terminal annule l’étape réservée', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    const c = await openCase(deps, s);
    const [reserved] = await reserveDueSteps(db.pool, deps.clock.now(), 5, { tenantId: s.tenantId });
    await db.pool.query(`update recovery_cases set state = 'RECOVERED' where id = $1`, [c.id]);
    expect(await sendReservedStep(deps, reserved!)).toBe('skipped');
    expect(await stepRow(c.id, 0)).toMatchObject({ status: 'CANCELED' });
  });
});

describe('erreurs d’envoi', () => {
  it('erreur temporaire : nouvel essai à +5 min puis +30 min, puis FAILED avec alerte', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    const c = await openCase(deps, s);

    deps.mailer.failNext(new MailerError('timeout', { permanent: false }));
    expect(await runDueSteps(deps)).toMatchObject({ released: 1 });
    const due1 = new Date((await stepRow(c.id, 0)).due_at).getTime();
    expect(due1 - deps.clock.now().getTime()).toBe(5 * 60_000);

    deps.clock.advance({ minutes: 5 });
    deps.mailer.failNext(new MailerError('timeout', { permanent: false }));
    expect(await runDueSteps(deps)).toMatchObject({ released: 1 });
    const due2 = new Date((await stepRow(c.id, 0)).due_at).getTime();
    expect(due2 - deps.clock.now().getTime()).toBe(30 * 60_000);

    deps.clock.advance({ minutes: 30 });
    deps.mailer.failNext(new MailerError('timeout', { permanent: false }));
    expect(await runDueSteps(deps)).toMatchObject({ failed: 1 });
    expect(await stepRow(c.id, 0)).toMatchObject({ status: 'FAILED' });
    const alerts = await db.pool.query(`select kind from system_alerts where tenant_id = $1`, [s.tenantId]);
    expect(alerts.rows.map((r) => r.kind)).toContain('email_failed');
    expect(deps.mailer.sent).toHaveLength(0);
  });

  it('erreur permanente : FAILED tout de suite, sans nouvel essai', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    const c = await openCase(deps, s);
    deps.mailer.failNext(new MailerError('adresse invalide', { permanent: true }));
    expect(await runDueSteps(deps)).toMatchObject({ failed: 1 });
    expect(await stepRow(c.id, 0)).toMatchObject({ status: 'FAILED', attempts: 1 });
    deps.clock.advance({ hours: 2 });
    expect(await runDueSteps(deps)).toMatchObject({ sent: 0 });
  });

  it('Stripe indisponible à la relecture de la facture : étape relâchée, rien d’envoyé', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    const c = await openCase(deps, s);
    deps.stripe.failNext(new GatewayError('panne', { kind: 'api', retryable: true }));
    expect(await runDueSteps(deps)).toMatchObject({ released: 1 });
    expect(deps.mailer.sent).toHaveLength(0);
    expect((await stepRow(c.id, 0)).status).toBe('SCHEDULED');
  });
});

describe('fin de séquence', () => {
  async function withSteps(deps: TestDeps, s: Scenario, sentDaysAgo: number | null) {
    const c = await openCase(deps, s);
    await db.pool.query(`update scheduled_steps set status = 'SENT', sent_at = $2 where case_id = $1`, [
      c.id,
      sentDaysAgo === null ? null : new Date(deps.clock.now().getTime() - sentDaysAgo * 86400_000),
    ]);
    return c;
  }

  it('dossier sans étape à venir et dernière relance > 3 jours : LOST', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    const c = await withSteps(deps, s, 4);
    expect(await closeExhaustedCases(deps)).toBe(1);
    expect((await getCaseByInvoice(db.pool, s.tenantId, s.invoiceId))!.state).toBe('LOST');
    expect((await listCaseActions(db.pool, s.tenantId, c.id)).map((a) => a.action)).toContain('case.lost');
  });

  it('délai de grâce non écoulé : reste RECOVERING', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    await withSteps(deps, s, 2);
    expect(await closeExhaustedCases(deps)).toBe(0);
    expect((await getCaseByInvoice(db.pool, s.tenantId, s.invoiceId))!.state).toBe('RECOVERING');
  });

  it('une étape encore planifiée empêche la clôture', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    const c = await openCase(deps, s);
    await db.pool.query(`update scheduled_steps set status = 'SENT', sent_at = $2 where case_id = $1 and step_index = 0`, [c.id, new Date('2026-09-01T00:00:00Z')]);
    expect(await closeExhaustedCases(deps)).toBe(0);
    expect((await listStepsForCase(db.pool, s.tenantId, c.id)).some((x) => x.status === 'SCHEDULED')).toBe(true);
  });

  it('un dossier en pause n’est jamais clôturé automatiquement', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    const c = await withSteps(deps, s, 10);
    await db.pool.query(`update recovery_cases set state = 'PAUSED' where id = $1`, [c.id]);
    expect(await closeExhaustedCases(deps)).toBe(0);
  });
});

describe('jamais de rafale', () => {
  it('étapes 0 à 3 toutes échues (panne du worker) : un seul email par passe, les suivants repoussés d’au moins 12 h', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    const c = await openCase(deps, s);
    await db.pool.query(`update scheduled_steps set due_at = $2 where case_id = $1`, [c.id, new Date(deps.clock.now().getTime() - 3600_000)]);

    expect(await runDueSteps(deps)).toMatchObject({ sent: 1 });
    expect(deps.mailer.sent).toHaveLength(1);
    expect(await runDueSteps(deps)).toMatchObject({ sent: 0 }); // l'étape 1 est repoussée, pas envoyée
    expect(await runDueSteps(deps)).toMatchObject({ sent: 0 });
    expect(deps.mailer.sent).toHaveLength(1);

    const step1 = await stepRow(c.id, 1);
    expect(step1.status).toBe('SCHEDULED');
    const sentAt = (await db.pool.query(`select sent_at from email_messages where case_id = $1`, [c.id])).rows[0].sent_at as Date;
    expect(new Date(step1.due_at).getTime()).toBeGreaterThanOrEqual(sentAt.getTime() + 12 * 3600_000);
    expect(step1.attempts).toBe(0); // le report n'est pas une tentative d'envoi
  });

  it('étape réservée alors qu’un email du dossier est parti il y a moins de 12 h : repoussée dans la fenêtre, pas envoyée', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    const c = await openCase(deps, s);
    const sentAt = new Date(deps.clock.now().getTime() - 3600_000);
    await db.pool.query(
      `insert into email_messages (tenant_id, case_id, step_index, idempotency_key, to_email, subject, status, dry_run, sent_at)
       values ($1,$2,0,$3,'x@example.com','s','SENT',false,$4)`,
      [s.tenantId, c.id, `${c.id}:0`, sentAt],
    );
    await db.pool.query(`update scheduled_steps set status = 'SENT', sent_at = $2 where case_id = $1 and step_index = 0`, [c.id, sentAt]);
    await db.pool.query(`update scheduled_steps set due_at = $2 where case_id = $1 and step_index = 1`, [c.id, deps.clock.now()]);
    const [reserved] = await reserveDueSteps(db.pool, deps.clock.now(), 5, { tenantId: s.tenantId });
    expect(reserved!.stepIndex).toBe(1);
    expect(await sendReservedStep(deps, reserved!)).toBe('released');
    expect(deps.mailer.sent).toHaveLength(0);
    const row = await stepRow(c.id, 1);
    expect(row.status).toBe('SCHEDULED');
    expect(new Date(row.due_at).getTime()).toBeGreaterThanOrEqual(sentAt.getTime() + 12 * 3600_000);
  });
});

describe('re-vérification sous verrou avant l’envoi', () => {
  it('dossier clôturé manuellement pendant l’envoi : aucun email, aucun lien de paiement actif', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    const c = await openCase(deps, s);
    const real = deps.stripe.retrieveInvoice.bind(deps.stripe);
    deps.stripe.retrieveInvoice = async (...a: Parameters<typeof real>) => {
      const inv = await real(...a);
      await db.pool.query(`update recovery_cases set state = 'CLOSED_MANUAL' where id = $1`, [c.id]); // le marchand clique « Clôturer »
      return inv;
    };
    expect(await runDueSteps(deps)).toMatchObject({ sent: 0 });
    expect(deps.mailer.sent).toHaveLength(0);
    expect((await stepRow(c.id, 0)).status).not.toBe('SENDING');
    const tokens = await db.pool.query(`select 1 from payment_tokens where case_id = $1 and used_at is null and revoked_at is null`, [c.id]);
    expect(tokens.rowCount).toBe(0);
  });

  it('dossier mis en pause pendant l’envoi : étape relâchée, aucun email', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    const c = await openCase(deps, s);
    const real = deps.stripe.retrieveInvoice.bind(deps.stripe);
    deps.stripe.retrieveInvoice = async (...a: Parameters<typeof real>) => {
      const inv = await real(...a);
      await db.pool.query(`update recovery_cases set state = 'PAUSED' where id = $1`, [c.id]);
      return inv;
    };
    expect(await runDueSteps(deps)).toMatchObject({ sent: 0, released: 1 });
    expect(deps.mailer.sent).toHaveLength(0);
    expect(await stepRow(c.id, 0)).toMatchObject({ status: 'SCHEDULED', attempts: 0 });
  });

  it('désinscription pendant l’envoi : aucun email', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    const c = await openCase(deps, s);
    const real = deps.stripe.retrieveInvoice.bind(deps.stripe);
    deps.stripe.retrieveInvoice = async (...a: Parameters<typeof real>) => {
      const inv = await real(...a);
      const e = await db.pool.query(`select e.email from end_customers e join recovery_cases r on r.end_customer_id = e.id where r.id = $1`, [c.id]);
      await db.pool.query(`insert into suppressions (tenant_id, email, reason) values ($1,$2,'UNSUBSCRIBED')`, [s.tenantId, e.rows[0].email.toLowerCase()]);
      return inv;
    };
    expect(await runDueSteps(deps)).toMatchObject({ sent: 0 });
    expect(deps.mailer.sent).toHaveLength(0);
    expect(await stepRow(c.id, 0)).toMatchObject({ status: 'SKIPPED', skip_reason: 'suppressed' });
  });
});

describe('fin de séquence : séquence vide', () => {
  it('dossier RECOVERING sans aucune étape et ouvert depuis plus de 3 jours : LOST', async () => {
    const deps = makeDeps(db);
    const t = await seedTenant(db.pool);
    const c = await seedCase(db.pool, t.id, { failedAt: new Date(deps.clock.now().getTime() - 4 * 86400_000) });
    expect(await closeExhaustedCases(deps)).toBe(1);
    expect((await db.pool.query(`select state from recovery_cases where id = $1`, [c.id])).rows[0].state).toBe('LOST');
  });

  it('dossier sans étape mais récent : reste RECOVERING', async () => {
    const deps = makeDeps(db);
    const t = await seedTenant(db.pool);
    const c = await seedCase(db.pool, t.id, { failedAt: new Date(deps.clock.now().getTime() - 86400_000) });
    expect(await closeExhaustedCases(deps)).toBe(0);
    expect((await db.pool.query(`select state from recovery_cases where id = $1`, [c.id])).rows[0].state).toBe('RECOVERING');
  });
});

describe('propriété de la réservation', () => {
  it('réservation périmée reprise par un autre worker : l’ancien worker n’envoie rien', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    const c = await openCase(deps, s);
    const [first] = await reserveDueSteps(db.pool, deps.clock.now(), 5, { tenantId: s.tenantId });
    expect(first).toBeDefined(); // worker A réserve puis traîne (lot long)
    deps.clock.advance({ minutes: 11 });
    await recoverStaleReservations(db.pool, deps.clock.now(), 10 * 60_000); // worker B reprend la main
    const [second] = await reserveDueSteps(db.pool, deps.clock.now(), 5, { tenantId: s.tenantId });
    expect(second!.id).toBe(first!.id);

    expect(await sendReservedStep(deps, first!)).toBe('released'); // A a perdu sa réservation
    expect(deps.mailer.sent).toHaveLength(0);
    expect(await stepRow(c.id, 0)).toMatchObject({ status: 'SENDING' }); // l'étape appartient à B
    expect(await sendReservedStep(deps, second!)).toBe('sent');
    expect(deps.mailer.sent).toHaveLength(1);
  });
});

describe('erreur inattendue avant la transaction d’envoi', () => {
  const breakLinks = (deps: TestDeps) => {
    deps.config = { ...deps.config, tokenSecret: undefined as any };
  };

  it('l’étape est remise en file avec délai (tentative comptée), le dossier n’est pas bloqué', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    const c = await openCase(deps, s);
    const good = deps.config;
    breakLinks(deps);
    expect(await runDueSteps(deps)).toMatchObject({ sent: 0, released: 1 });
    const row = await stepRow(c.id, 0);
    expect(row).toMatchObject({ status: 'SCHEDULED', attempts: 1 });
    expect(new Date(row.due_at).getTime()).toBeGreaterThan(deps.clock.now().getTime());
    expect((await listCaseActions(db.pool, s.tenantId, c.id)).map((a) => a.action)).toContain('email.retry_scheduled');

    deps.config = good;
    deps.clock.advance({ minutes: 6 });
    expect(await runDueSteps(deps)).toMatchObject({ sent: 1 });
  });

  it('au-delà de MAX_SEND_ATTEMPTS : FAILED avec alerte', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    const c = await openCase(deps, s);
    breakLinks(deps);
    for (let i = 0; i < 3; i++) {
      await runDueSteps(deps);
      deps.clock.advance({ minutes: 40 });
    }
    expect(await stepRow(c.id, 0)).toMatchObject({ status: 'FAILED', skip_reason: 'send_failed' });
    expect(deps.mailer.sent).toHaveLength(0);
  });

  it('recoverStaleReservations respecte le plafond de tentatives', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    const c = await openCase(deps, s);
    await db.pool.query(`update scheduled_steps set status = 'SENDING', attempts = 3, reserved_at = $2 where case_id = $1 and step_index = 0`, [c.id, new Date(deps.clock.now().getTime() - 20 * 60_000)]);
    await runDueSteps(deps);
    expect(await stepRow(c.id, 0)).toMatchObject({ status: 'FAILED' });
    expect(deps.mailer.sent).toHaveLength(0);
  });
});

describe('sorties de la garde journalisées', () => {
  const actionsOf = async (s: Scenario, caseId: string) => listCaseActions(db.pool, s.tenantId, caseId);

  it('dossier clos : email.canceled avec stepIndex et reason', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    const c = await openCase(deps, s);
    const [reserved] = await reserveDueSteps(db.pool, deps.clock.now(), 5, { tenantId: s.tenantId });
    await db.pool.query(`update recovery_cases set state = 'RECOVERED' where id = $1`, [c.id]);
    await sendReservedStep(deps, reserved!);
    const a = (await actionsOf(s, c.id)).find((x) => x.action === 'email.canceled');
    expect(a?.details).toMatchObject({ stepIndex: 0, reason: 'case_closed' });
  });

  it('désinscrit : email.skipped ; dossier en pause : email.released', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    const c = await openCase(deps, s);
    const [reserved] = await reserveDueSteps(db.pool, deps.clock.now(), 5, { tenantId: s.tenantId });
    await db.pool.query(`update recovery_cases set state = 'PAUSED' where id = $1`, [c.id]);
    await sendReservedStep(deps, reserved!);
    expect((await actionsOf(s, c.id)).find((x) => x.action === 'email.released')?.details).toMatchObject({ stepIndex: 0, reason: 'case_not_recovering' });

    const s2 = await setupScenario(db, deps);
    const c2 = await openCase(deps, s2);
    const e = await db.pool.query(`select e.email from end_customers e join recovery_cases r on r.end_customer_id = e.id where r.id = $1`, [c2.id]);
    await db.pool.query(`insert into suppressions (tenant_id, email, reason) values ($1,$2,'UNSUBSCRIBED')`, [s2.tenantId, e.rows[0].email.toLowerCase()]);
    await runDueSteps(deps);
    expect((await actionsOf(s2, c2.id)).find((x) => x.action === 'email.skipped')?.details).toMatchObject({ stepIndex: 0, reason: 'suppressed' });
  });

  it('connexion révoquée : email.canceled(stripe_revoked)', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    const c = await openCase(deps, s);
    const [reserved] = await reserveDueSteps(db.pool, deps.clock.now(), 5, { tenantId: s.tenantId });
    await db.pool.query(`update stripe_connections set status = 'REVOKED' where tenant_id = $1`, [s.tenantId]);
    await sendReservedStep(deps, reserved!);
    expect((await actionsOf(s, c.id)).find((x) => x.action === 'email.canceled')?.details).toMatchObject({ stepIndex: 0, reason: 'stripe_revoked' });
  });
});

describe('fin de séquence et révocation Stripe', () => {
  it('les relances annulées par une révocation ne font pas passer le dossier en LOST (il reste replanifiable à la reconnexion)', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    const c = await openCase(deps, s);
    await handleDeauthorized(deps, s.account);
    deps.clock.advance({ days: 30 }); // bien après la dernière échéance + délai de grâce
    await closeExhaustedCases(deps); // d'autres dossiers de la base partagée peuvent être clos : on ne regarde que celui-ci
    expect((await getCaseByInvoice(db.pool, s.tenantId, s.invoiceId))!.state).toBe('RECOVERING');
    // les étapes restent annulées pour 'stripe_revoked' : la reconnexion les replanifie (rescheduleRevokedSteps, dossiers RECOVERING)
    expect((await stepRow(c.id, 0)).skip_reason).toBe('stripe_revoked');
  });
});
