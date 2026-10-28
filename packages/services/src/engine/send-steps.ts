import { Money, validateTemplate, type TemplateValues } from '@recoverkit/core';
import {
  logAction,
  mapCase,
  recoverStaleReservations,
  reserveDueSteps,
  withTransaction,
  type CaseRow,
  type StepRow,
} from '@recoverkit/db';
import { buildEmail, defaultTemplate, type Locale } from '@recoverkit/mail';
import { MailerError } from '@recoverkit/mail';
import type { Deps } from '../deps';
import { ensurePaymentLink } from '../payments/link';
import { buildUnsubscribeUrl } from '../mail/unsubscribe';
import { closeCase, loadTenant, lockTenant, raiseAlert, type TenantRow } from '../recovery/ops';

const STALE_RESERVATION_MS = 10 * 60_000;
const RETRY_DELAYS_MINUTES = [5, 30];
const MAX_SEND_ATTEMPTS = 3;
export const EXHAUSTED_GRACE_DAYS = 3;

export interface SendStats {
  sent: number;
  skipped: number;
  failed: number;
  released: number;
}

type StepOutcome = 'sent' | 'skipped' | 'failed' | 'released';

async function finishStep(deps: Deps, stepId: string, status: 'SKIPPED' | 'CANCELED' | 'FAILED', reason: string) {
  await deps.pool.query(
    `update scheduled_steps set status = $2, skip_reason = $3 where id = $1 and status = 'SENDING'`,
    [stepId, status, reason],
  );
}

/** Remet l'étape en file : sans compter la tentative (pause) ou avec un délai (erreur temporaire). */
async function release(deps: Deps, step: StepRow, delayMinutes: number | null) {
  const now = deps.clock.now();
  await deps.pool.query(
    `update scheduled_steps
        set status = 'SCHEDULED', reserved_at = null,
            attempts = case when $3::int is null then greatest(attempts - 1, 0) else attempts end,
            due_at = case when $3::int is null then due_at else $2::timestamptz + make_interval(mins => $3::int) end
      where id = $1 and status = 'SENDING'`,
    [step.id, now, delayMinutes],
  );
}

async function temporaryFailure(deps: Deps, step: StepRow, c: CaseRow, reason: string): Promise<StepOutcome> {
  if (step.attempts >= MAX_SEND_ATTEMPTS) {
    await failStep(deps, step, c, reason);
    return 'failed';
  }
  await release(deps, step, RETRY_DELAYS_MINUTES[step.attempts - 1] ?? 30);
  await logAction(deps.pool, { tenantId: c.tenantId, caseId: c.id, actor: 'system', action: 'email.retry_scheduled', details: { stepIndex: step.stepIndex, attempts: step.attempts, reason } });
  return 'released';
}

async function failStep(deps: Deps, step: StepRow, c: CaseRow, reason: string) {
  await finishStep(deps, step.id, 'FAILED', 'send_failed');
  await logAction(deps.pool, { tenantId: c.tenantId, caseId: c.id, actor: 'system', action: 'email.failed', details: { stepIndex: step.stepIndex, reason } });
  await raiseAlert(deps.pool, {
    tenantId: c.tenantId,
    kind: 'email_failed',
    dedupeKey: `email_failed:${c.id}:${step.stepIndex}`,
    message: `L'email ${step.stepIndex + 1} du dossier ${c.stripeInvoiceId} n'a pas pu être envoyé.`,
    details: { reason },
  });
}

function pickLocale(customerLocale: string | null, tenant: TenantRow): Locale {
  return customerLocale === 'fr' || customerLocale === 'en' ? customerLocale : tenant.locale;
}

async function templateFor(deps: Deps, tenantId: string, stepIndex: number, locale: Locale) {
  const res = await deps.pool.query(
    `select subject, body from email_templates where tenant_id = $1 and step_index = $2 and locale = $3`,
    [tenantId, stepIndex, locale],
  );
  const custom = res.rows[0];
  if (custom && validateTemplate(custom).ok) return { subject: custom.subject as string, body: custom.body as string };
  return defaultTemplate(stepIndex, locale);
}

/** Traite une étape déjà réservée (SENDING). Aucune étape n'est jamais envoyée deux fois. */
export async function sendReservedStep(deps: Deps, step: StepRow): Promise<StepOutcome> {
  const caseRes = await deps.pool.query(`select * from recovery_cases where id = $1`, [step.caseId]);
  const tenant = await loadTenant(deps.pool, step.tenantId);
  if (!caseRes.rows[0] || !tenant) {
    await finishStep(deps, step.id, 'CANCELED', 'case_missing');
    return 'skipped';
  }
  const c = mapCase(caseRes.rows[0]);

  if (['RECOVERED', 'CANCELED', 'LOST', 'CLOSED_MANUAL'].includes(c.state)) {
    await finishStep(deps, step.id, 'CANCELED', 'case_closed');
    return 'skipped';
  }
  if (c.state !== 'RECOVERING') {
    await release(deps, step, null);
    return 'released';
  }
  const conn = await deps.pool.query(`select status, stripe_account_id from stripe_connections where tenant_id = $1`, [tenant.id]);
  if (conn.rows[0]?.status !== 'ACTIVE') {
    await finishStep(deps, step.id, 'CANCELED', 'stripe_revoked');
    return 'skipped';
  }
  if (!tenant.emailsEnabled) {
    await finishStep(deps, step.id, 'SKIPPED', 'disabled');
    return 'skipped';
  }

  const custRes = await deps.pool.query(`select email, name, locale from end_customers where id = $1`, [c.endCustomerId]);
  const customer = custRes.rows[0] as { email: string | null; name: string | null; locale: string | null } | undefined;
  if (!customer?.email) {
    await finishStep(deps, step.id, 'SKIPPED', 'no_email');
    return 'skipped';
  }
  const email = customer.email.trim().toLowerCase();
  const suppressed = await deps.pool.query(`select 1 from suppressions where tenant_id = $1 and email = $2`, [tenant.id, email]);
  if ((suppressed.rowCount ?? 0) > 0) {
    await finishStep(deps, step.id, 'SKIPPED', 'suppressed');
    return 'skipped';
  }

  // L'état réel chez Stripe fait foi : on n'écrit jamais à un client qui vient de payer.
  let invoice;
  try {
    invoice = await deps.stripe.retrieveInvoice(conn.rows[0].stripe_account_id, c.stripeInvoiceId);
  } catch (e) {
    return temporaryFailure(deps, step, c, `stripe: ${(e as Error).message}`);
  }
  if (invoice.status === 'paid') {
    await finishStep(deps, step.id, 'SKIPPED', 'already_paid');
    return 'skipped';
  }
  if (invoice.status === 'void' || invoice.status === 'uncollectible') {
    await finishStep(deps, step.id, 'SKIPPED', 'invoice_closed');
    return 'skipped';
  }

  const now = deps.clock.now();
  const idempotencyKey = `${c.id}:${step.stepIndex}`;

  if (tenant.dryRun) {
    await withTransaction(deps.pool, async (tx) => {
      await tx.query(
        `insert into email_messages (tenant_id, case_id, step_index, idempotency_key, to_email, subject, status, dry_run, sent_at)
         values ($1,$2,$3,$4,$5,'(dry-run)','SENT',true,$6) on conflict (idempotency_key) do nothing`,
        [tenant.id, c.id, step.stepIndex, idempotencyKey, email, now],
      );
      await tx.query(`update scheduled_steps set status = 'SENT', sent_at = $2 where id = $1 and status = 'SENDING'`, [step.id, now]);
      await logAction(tx, { tenantId: tenant.id, caseId: c.id, actor: 'system', action: 'email.dry_run', details: { stepIndex: step.stepIndex } });
    });
    return 'sent';
  }

  const locale = pickLocale(customer.locale, tenant);
  const link = await ensurePaymentLink(deps, tenant.id, c.id);
  const unsubscribeUrl = buildUnsubscribeUrl(deps, tenant.id, email);
  const values: TemplateValues = {
    customer_name: customer.name ?? (locale === 'fr' ? 'client' : 'customer'),
    amount: Money.of(c.amountDue, c.currency).format(locale === 'fr' ? 'fr-FR' : 'en-US'),
    plan: c.planName ?? (locale === 'fr' ? 'abonnement' : 'subscription'),
    update_link: link,
    tenant_name: tenant.name,
  };
  const built = buildEmail({
    template: await templateFor(deps, tenant.id, step.stepIndex, locale),
    values,
    locale,
    tenantName: tenant.name,
    supportEmail: tenant.supportEmail,
    unsubscribeUrl,
  });
  const from =
    tenant.senderVerified && tenant.senderEmail
      ? { name: tenant.senderName ?? tenant.name, email: tenant.senderEmail }
      : { name: tenant.senderName ?? tenant.name, email: deps.config.defaultFromEmail };

  let messageId: string;
  try {
    ({ messageId } = await deps.mailer.send({
      to: email,
      from,
      replyTo: tenant.replyTo ?? tenant.supportEmail ?? undefined,
      subject: built.subject,
      html: built.html,
      text: built.text,
      idempotencyKey,
      headers: { 'List-Unsubscribe': `<${unsubscribeUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
    }));
  } catch (e) {
    const err = e as Error;
    if (err instanceof MailerError && err.permanent) {
      await failStep(deps, step, c, err.message);
      return 'failed';
    }
    return temporaryFailure(deps, step, c, err.message);
  }

  await withTransaction(deps.pool, async (tx) => {
    await tx.query(
      `insert into email_messages (tenant_id, case_id, step_index, idempotency_key, provider_message_id, to_email, subject, status, dry_run, sent_at)
       values ($1,$2,$3,$4,$5,$6,$7,'SENT',false,$8) on conflict (idempotency_key) do nothing`,
      [tenant.id, c.id, step.stepIndex, idempotencyKey, messageId, email, built.subject, now],
    );
    await tx.query(`update scheduled_steps set status = 'SENT', sent_at = $2, message_id = $3 where id = $1 and status = 'SENDING'`, [step.id, now, messageId]);
    await logAction(tx, { tenantId: tenant.id, caseId: c.id, actor: 'system', action: 'email.sent', details: { stepIndex: step.stepIndex, messageId } });
  });
  return 'sent';
}

/** Une passe du worker d'envoi : reprend les réservations abandonnées, réserve les étapes échues, les traite. */
export async function runDueSteps(deps: Deps, opts: { limit?: number } = {}): Promise<SendStats> {
  const now = deps.clock.now();
  await recoverStaleReservations(deps.pool, now, STALE_RESERVATION_MS);
  const reserved = await reserveDueSteps(deps.pool, now, opts.limit ?? deps.config.stepBatchSize);
  const stats: SendStats = { sent: 0, skipped: 0, failed: 0, released: 0 };
  for (const step of reserved) {
    try {
      stats[await sendReservedStep(deps, step)]++;
    } catch (e) {
      deps.log.error({ stepId: step.id, caseId: step.caseId, err: (e as Error).message }, "erreur inattendue pendant l'envoi d'une étape");
      stats.released++;
    }
  }
  return stats;
}

/** Passe en LOST les dossiers dont toutes les relances sont passées depuis plus de 3 jours. */
export async function closeExhaustedCases(deps: Deps): Promise<number> {
  const threshold = new Date(deps.clock.now().getTime() - EXHAUSTED_GRACE_DAYS * 86400_000);
  const res = await deps.pool.query(
    `select c.* from recovery_cases c
      where c.state = 'RECOVERING'
        and exists (select 1 from scheduled_steps s where s.case_id = c.id)
        and not exists (select 1 from scheduled_steps s where s.case_id = c.id and s.status in ('SCHEDULED','SENDING'))
        and (select max(coalesce(s.sent_at, s.due_at)) from scheduled_steps s where s.case_id = c.id) < $1`,
    [threshold],
  );
  let closed = 0;
  for (const row of res.rows) {
    const c = mapCase(row);
    await withTransaction(deps.pool, async (tx) => {
      await lockTenant(tx, c.tenantId);
      const fresh = await tx.query(`select * from recovery_cases where id = $1 and state = 'RECOVERING'`, [c.id]);
      if (fresh.rowCount !== 1) return;
      await closeCase(deps, tx, mapCase(fresh.rows[0]), 'SEQUENCE_EXHAUSTED', 'sequence_exhausted');
      closed++;
    });
  }
  return closed;
}
