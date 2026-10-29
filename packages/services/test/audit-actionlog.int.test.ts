import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getCaseByInvoice } from '@recoverkit/db';
import { MailerError } from '@recoverkit/mail';
import { createTestDb, type TestDb } from '@recoverkit/testkit';
import { processInbox } from '../src/webhooks/process';
import { runDueSteps } from '../src/engine/send-steps';
import { closeCaseManually, pauseCase, resumeCase, sendNextNow } from '../src/dashboard/actions';
import { exportTenantData } from '../src/compliance/export';
import { confirmSetup, startSetup } from '../src/payments/pay';
import { makeDeps, type TestDeps } from './helpers';
import { deliver, invoiceObject, setupScenario, type Scenario } from './scenario';

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.dispose();
});

async function openCase(deps: TestDeps, s: Scenario) {
  await deliver(deps, s, 'invoice.payment_failed', invoiceObject(s));
  await processInbox(deps);
  return (await getCaseByInvoice(db.pool, s.tenantId, s.invoiceId))!;
}
const logs = async (tenantId: string, caseId: string | null = null) =>
  (await db.pool.query(`select actor, action, details, case_id from action_log where tenant_id = $1 and ($2::uuid is null or case_id = $2) order by id`, [tenantId, caseId])).rows;

describe('audit : chaque action de relance est journalisée (action_log)', () => {
  it('pause, reprise et clôture manuelle : acteur et motif consignés', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    const c = await openCase(deps, s);
    expect(await pauseCase(deps, s.tenantId, c.id, 'user:u1')).toEqual({ status: 'ok' });
    expect(await resumeCase(deps, s.tenantId, c.id, 'user:u1')).toEqual({ status: 'ok' });
    expect(await closeCaseManually(deps, s.tenantId, c.id, 'user:u2', 'client contacté par téléphone')).toEqual({ status: 'ok' });
    const rows = await logs(s.tenantId, c.id);
    expect(rows.find((r) => r.action === 'case.paused')).toMatchObject({ actor: 'user:u1' });
    expect(rows.find((r) => r.action === 'case.resumed')).toMatchObject({ actor: 'user:u1' });
    expect(rows.find((r) => r.action === 'case.closed_manual')).toMatchObject({ actor: 'user:u2', details: { reason: 'client contacté par téléphone', from: 'RECOVERING' } });
  });

  it('une action refusée (état invalide, motif absent) ne laisse aucune trace de succès', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    const c = await openCase(deps, s);
    const before = (await logs(s.tenantId, c.id)).length;
    expect(await resumeCase(deps, s.tenantId, c.id, 'user:u1')).toEqual({ status: 'invalid_state' });
    expect(await closeCaseManually(deps, s.tenantId, c.id, 'user:u1', ' ')).toEqual({ status: 'reason_required' });
    expect((await logs(s.tenantId, c.id)).length).toBe(before);
  });

  it('« envoyer maintenant » est journalisé avec l’étape', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    const c = await openCase(deps, s);
    expect(await sendNextNow(deps, s.tenantId, c.id, 'user:u3')).toMatchObject({ status: 'queued', stepIndex: 0 });
    expect((await logs(s.tenantId, c.id)).find((r) => r.action === 'case.send_now')).toMatchObject({ actor: 'user:u3', details: { stepIndex: 0 } });
  });

  it('email envoyé, retard puis échec définitif : email.sent / email.retry_scheduled / email.failed', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    const c = await openCase(deps, s);
    deps.clock.advance({ minutes: 90 });
    deps.mailer.failNext(new MailerError('provider 503', { permanent: false }));
    await runDueSteps(deps);
    expect((await logs(s.tenantId, c.id)).map((r) => r.action)).toContain('email.retry_scheduled');
    deps.clock.advance({ hours: 1 });
    deps.mailer.failNext(new MailerError('adresse invalide', { permanent: true }));
    await runDueSteps(deps);
    const failed = (await logs(s.tenantId, c.id)).find((r) => r.action === 'email.failed');
    expect(failed).toMatchObject({ actor: 'system', details: { stepIndex: 0 } });

    const s2 = await setupScenario(db, deps);
    const c2 = await openCase(deps, s2);
    deps.clock.advance({ hours: 3 });
    await runDueSteps(deps);
    const sent = (await logs(s2.tenantId, c2.id)).find((r) => r.action === 'email.sent');
    expect(sent?.details).toMatchObject({ stepIndex: 0, messageId: expect.stringMatching(/^fake_/) });
  });

  it('paiement par carte via le lien : retry.paid (acteur customer) et tentative enregistrée', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    const c = await openCase(deps, s);
    deps.clock.advance({ minutes: 90 });
    await runDueSteps(deps);
    const token = deps.mailer.sent.at(-1)!.text.match(/\/pay\/([\w-]{43})/)![1]!;
    const start = await startSetup(deps, token, { ip: '203.0.115.1' });
    if (start.status !== 'ok') throw new Error('setup');
    deps.stripe.setCardBehavior('pm_log', 'succeed');
    deps.stripe.completeSetupIntent(s.account, start.setupIntentId, 'pm_log');
    expect(await confirmSetup(deps, token, start.setupIntentId, { ip: '203.0.115.1' })).toEqual({ status: 'paid' });
    expect((await logs(s.tenantId, c.id)).find((r) => r.action === 'retry.paid')).toMatchObject({
      actor: 'customer',
      details: { paymentMethodId: 'pm_log', source: 'link' },
    });
    // une carte refusée est journalisée avec son code
    const s2 = await setupScenario(db, deps);
    const c2 = await openCase(deps, s2);
    deps.clock.advance({ minutes: 90 });
    await runDueSteps(deps);
    const token2 = deps.mailer.sent.at(-1)!.text.match(/\/pay\/([\w-]{43})/)![1]!;
    const st2 = await startSetup(deps, token2, { ip: '203.0.115.2' });
    if (st2.status !== 'ok') throw new Error('setup');
    deps.stripe.setCardBehavior('pm_refus', 'decline', 'insufficient_funds');
    deps.stripe.completeSetupIntent(s2.account, st2.setupIntentId, 'pm_refus');
    await confirmSetup(deps, token2, st2.setupIntentId, { ip: '203.0.115.2' });
    expect((await logs(s2.tenantId, c2.id)).find((r) => r.action === 'retry.failed')).toMatchObject({ actor: 'customer', details: { errorCode: 'insufficient_funds' } });
  });

  it('export des données : tenant.exported avec l’acteur', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    await exportTenantData(deps, s.tenantId, { actor: 'user:u9' });
    expect((await logs(s.tenantId)).find((r) => r.action === 'tenant.exported')).toMatchObject({ actor: 'user:u9', case_id: null });
  });

  it('le journal et le ledger sont en ajout seul (UPDATE et DELETE refusés)', async () => {
    const deps = makeDeps(db);
    const s = await setupScenario(db, deps);
    const c = await openCase(deps, s);
    await pauseCase(deps, s.tenantId, c.id, 'user:u1');
    await expect(db.pool.query(`update action_log set actor = 'x' where tenant_id = $1`, [s.tenantId])).rejects.toThrow();
    await expect(db.pool.query(`delete from action_log where tenant_id = $1`, [s.tenantId])).rejects.toThrow();
    await db.pool.query(
      `insert into recovery_ledger (tenant_id, case_id, invoice_id, kind, attribution, amount, currency, occurred_at, rule_version)
       values ($1,$2,$3,'RECOVERY','NATURAL',2900,'EUR',now(),1)`,
      [s.tenantId, c.id, s.invoiceId],
    );
    await expect(db.pool.query(`update recovery_ledger set amount = 1 where tenant_id = $1`, [s.tenantId])).rejects.toThrow();
    await expect(db.pool.query(`delete from recovery_ledger where tenant_id = $1`, [s.tenantId])).rejects.toThrow();
  });
});
