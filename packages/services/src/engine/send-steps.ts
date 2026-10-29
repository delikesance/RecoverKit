import { MIN_GAP_MS, Money, nextWindowInstant, validateTemplate, type TemplateValues } from '@recoverkit/core';
import {
  logAction,
  mapCase,
  recoverStaleReservations,
  reserveDueSteps,
  withTransaction,
  type CaseRow,
  type Queryable,
  type StepRow,
} from '@recoverkit/db';
import { buildEmail, type Locale } from '@recoverkit/mail';
import { MailerError } from '@recoverkit/mail';
import type { Deps } from '../deps';
import { ensurePaymentLink } from '../payments/link';
import { buildUnsubscribeUrl } from '../mail/unsubscribe';
import { getSequence } from '../settings/sequence';
import { defaultTemplateFor } from '../settings/templates';
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

/** Sortie de la garde : journalisée (email.skipped / email.canceled / email.released) avec l'index de l'étape et le motif. */
async function logGuardExit(db: Queryable, c: Pick<CaseRow, 'tenantId' | 'id'>, step: StepRow, action: 'email.skipped' | 'email.canceled' | 'email.released', reason: string) {
  await logAction(db, { tenantId: c.tenantId, caseId: c.id, actor: 'system', action, details: { stepIndex: step.stepIndex, reason } });
}

async function finishStep(deps: Deps, step: StepRow, status: 'SKIPPED' | 'CANCELED' | 'FAILED', reason: string, c?: CaseRow) {
  const res = await deps.pool.query(
    `update scheduled_steps set status = $2, skip_reason = $3 where id = $1 and status = 'SENDING'`,
    [step.id, status, reason],
  );
  if (c && status !== 'FAILED' && (res.rowCount ?? 0) > 0) await logGuardExit(deps.pool, c, step, status === 'SKIPPED' ? 'email.skipped' : 'email.canceled', reason);
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

/** Repousse l'étape (sans compter la tentative) dans la fenêtre d'envoi, à au moins MIN_GAP_MS du dernier email. */
async function defer(db: Queryable, tenant: TenantRow, step: StepRow, c: CaseRow, lastSentAt: Date, now: Date) {
  const window = { startHour: tenant.sendStartHour, endHour: tenant.sendEndHour, timeZone: tenant.timeZone };
  const due = nextWindowInstant(new Date(Math.max(now.getTime(), lastSentAt.getTime() + MIN_GAP_MS)), window);
  await db.query(
    `update scheduled_steps set status = 'SCHEDULED', reserved_at = null, attempts = greatest(attempts - 1, 0), due_at = $2
      where id = $1 and status = 'SENDING'`,
    [step.id, due],
  );
  await logAction(db, { tenantId: c.tenantId, caseId: c.id, actor: 'system', action: 'email.deferred', details: { stepIndex: step.stepIndex, dueAt: due.toISOString(), reason: 'min_gap' } });
}

/** Dernier email parti pour le dossier (autre que cette étape) depuis moins de MIN_GAP_MS, sinon null. */
async function recentEmail(db: Queryable, step: StepRow, now: Date): Promise<Date | null> {
  const res = await db.query(
    `select max(sent_at) as at from email_messages where case_id = $1 and step_index <> $2 and sent_at > $3`,
    [step.caseId, step.stepIndex, new Date(now.getTime() - MIN_GAP_MS)],
  );
  return res.rows[0]?.at ? new Date(res.rows[0].at) : null;
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
  await finishStep(deps, step, 'FAILED', 'send_failed');
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
  // même calcul que l'écran des modèles : ce qui est affiché est ce qui part
  const total = Math.max((await getSequence(deps, tenantId))?.steps.length ?? 0, 4);
  const res = await deps.pool.query(
    `select subject, body from email_templates where tenant_id = $1 and step_index = $2 and locale = $3`,
    [tenantId, stepIndex, locale],
  );
  const custom = res.rows[0];
  if (custom && validateTemplate(custom).ok) return { subject: custom.subject as string, body: custom.body as string };
  return defaultTemplateFor(stepIndex, locale, total);
}

/** Traite une étape déjà réservée (SENDING). Aucune étape n'est jamais envoyée deux fois. */
export async function sendReservedStep(deps: Deps, step: StepRow): Promise<StepOutcome> {
  const caseRes = await deps.pool.query(`select * from recovery_cases where id = $1`, [step.caseId]);
  const tenant = await loadTenant(deps.pool, step.tenantId);
  if (!caseRes.rows[0] || !tenant) {
    await finishStep(deps, step, 'CANCELED', 'case_missing');
    return 'skipped';
  }
  const c = mapCase(caseRes.rows[0]);

  if (['RECOVERED', 'CANCELED', 'LOST', 'CLOSED_MANUAL'].includes(c.state)) {
    await finishStep(deps, step, 'CANCELED', 'case_closed', c);
    return 'skipped';
  }
  if (c.state !== 'RECOVERING') {
    await release(deps, step, null);
    await logGuardExit(deps.pool, c, step, 'email.released', 'case_not_recovering');
    return 'released';
  }
  const conn = await deps.pool.query(`select status, stripe_account_id from stripe_connections where tenant_id = $1`, [tenant.id]);
  if (conn.rows[0]?.status !== 'ACTIVE') {
    await finishStep(deps, step, 'CANCELED', 'stripe_revoked', c);
    return 'skipped';
  }
  if (!tenant.emailsEnabled) {
    await finishStep(deps, step, 'SKIPPED', 'disabled', c);
    return 'skipped';
  }

  const custRes = await deps.pool.query(`select email, name, locale from end_customers where id = $1`, [c.endCustomerId]);
  const customer = custRes.rows[0] as { email: string | null; name: string | null; locale: string | null } | undefined;
  if (!customer?.email) {
    await finishStep(deps, step, 'SKIPPED', 'no_email', c);
    return 'skipped';
  }
  const email = customer.email.trim().toLowerCase();
  const suppressed = await deps.pool.query(`select 1 from suppressions where tenant_id = $1 and email = $2`, [tenant.id, email]);
  if ((suppressed.rowCount ?? 0) > 0) {
    await finishStep(deps, step, 'SKIPPED', 'suppressed', c);
    return 'skipped';
  }

  const early = await recentEmail(deps.pool, step, deps.clock.now());
  if (early) {
    await defer(deps.pool, tenant, step, c, early, deps.clock.now());
    return 'released';
  }

  // L'état réel chez Stripe fait foi : on n'écrit jamais à un client qui vient de payer.
  let invoice;
  try {
    invoice = await deps.stripe.retrieveInvoice(conn.rows[0].stripe_account_id, c.stripeInvoiceId);
  } catch (e) {
    return temporaryFailure(deps, step, c, `stripe: ${(e as Error).message}`);
  }
  if (invoice.status === 'paid') {
    await finishStep(deps, step, 'SKIPPED', 'already_paid', c);
    return 'skipped';
  }
  if (invoice.status === 'void' || invoice.status === 'uncollectible') {
    await finishStep(deps, step, 'SKIPPED', 'invoice_closed', c);
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

  // Dernière vérification sous le verrou du tenant, dans la même transaction que l'envoi : une clôture, une pause,
  // une désinscription ou un autre email du dossier survenus depuis les lectures ci-dessus l'emportent.
  type Guarded = { kind: 'sent'; messageId: string } | { kind: StepOutcome } | { kind: 'error'; err: Error };
  const result = await withTransaction(deps.pool, async (tx): Promise<Guarded> => {
    await lockTenant(tx, tenant.id);
    // Cette étape est-elle encore la nôtre ? Un lot long a pu dépasser STALE_RESERVATION_MS : la réservation a alors
    // été reprise (puis peut-être ré-obtenue par un autre worker). Sans cette preuve, on n'envoie rien.
    const owned = await tx.query(
      `select 1 from scheduled_steps where id = $1 and status = 'SENDING' and reserved_at = $2 for update`,
      [step.id, step.reservedAt],
    );
    if (owned.rowCount !== 1) {
      await logGuardExit(tx, c, step, 'email.released', 'reservation_lost');
      return { kind: 'released' };
    }
    const state = (await tx.query(`select state from recovery_cases where id = $1`, [c.id])).rows[0]?.state as string | undefined;
    if (state !== 'RECOVERING') {
      // le lien créé juste avant ne doit pas survivre à une clôture
      await tx.query(`update payment_tokens set revoked_at = $2 where case_id = $1 and used_at is null and revoked_at is null`, [c.id, now]);
      if (!state || ['RECOVERED', 'CANCELED', 'LOST', 'CLOSED_MANUAL'].includes(state)) {
        await tx.query(`update scheduled_steps set status = 'CANCELED', skip_reason = 'case_closed' where id = $1 and status = 'SENDING'`, [step.id]);
        await logGuardExit(tx, c, step, 'email.canceled', 'case_closed');
        return { kind: 'skipped' };
      }
      await tx.query(
        `update scheduled_steps set status = 'SCHEDULED', reserved_at = null, attempts = greatest(attempts - 1, 0) where id = $1 and status = 'SENDING'`,
        [step.id],
      );
      await logGuardExit(tx, c, step, 'email.released', 'case_not_recovering');
      return { kind: 'released' };
    }
    // Le tenant a pu être suspendu, ou la connexion Stripe révoquée, depuis les lectures ci-dessus.
    const live = (await tx.query(
      `select t.status as tenant_status, t.emails_enabled, (select status from stripe_connections where tenant_id = t.id) as conn_status
         from tenants t where t.id = $1`,
      [tenant.id],
    )).rows[0] as { tenant_status: string; emails_enabled: boolean; conn_status: string | null } | undefined;
    const blocked =
      !live || live.tenant_status !== 'ACTIVE'
        ? { status: 'SCHEDULED', reason: null }
        : live.conn_status !== 'ACTIVE'
          ? { status: 'CANCELED', reason: 'stripe_revoked' }
          : !live.emails_enabled
            ? { status: 'SKIPPED', reason: 'disabled' }
            : null;
    if (blocked) {
      await tx.query(`update payment_tokens set revoked_at = $2 where case_id = $1 and used_at is null and revoked_at is null`, [c.id, now]);
      if (blocked.status === 'SCHEDULED') {
        // suspendu : l'étape reste planifiée (sans compter la tentative), elle repartira à la réactivation
        await tx.query(
          `update scheduled_steps set status = 'SCHEDULED', reserved_at = null, attempts = greatest(attempts - 1, 0) where id = $1 and status = 'SENDING'`,
          [step.id],
        );
        await logGuardExit(tx, c, step, 'email.released', 'tenant_suspended');
        return { kind: 'released' };
      }
      await tx.query(`update scheduled_steps set status = $2, skip_reason = $3 where id = $1 and status = 'SENDING'`, [step.id, blocked.status, blocked.reason]);
      await logGuardExit(tx, c, step, blocked.status === 'SKIPPED' ? 'email.skipped' : 'email.canceled', blocked.reason!);
      return { kind: 'skipped' };
    }
    if (((await tx.query(`select 1 from suppressions where tenant_id = $1 and email = $2`, [tenant.id, email])).rowCount ?? 0) > 0) {
      await tx.query(`update scheduled_steps set status = 'SKIPPED', skip_reason = 'suppressed' where id = $1 and status = 'SENDING'`, [step.id]);
      await logGuardExit(tx, c, step, 'email.skipped', 'suppressed');
      return { kind: 'skipped' };
    }
    const recent = await recentEmail(tx, step, now);
    if (recent) {
      await defer(tx, tenant, step, c, recent, now);
      return { kind: 'released' };
    }
    let messageId: string;
    // Compromis accepté : l'appel au fournisseur se fait sous le verrou du tenant, dans la transaction. La clé
    // d'idempotence (dossier:étape) et la garde ci-dessus empêchent tout doublon, même en cas de reprise.
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
      return { kind: 'error', err: e as Error };
    }
    await tx.query(
      `insert into email_messages (tenant_id, case_id, step_index, idempotency_key, provider_message_id, to_email, subject, status, dry_run, sent_at)
       values ($1,$2,$3,$4,$5,$6,$7,'SENT',false,$8) on conflict (idempotency_key) do nothing`,
      [tenant.id, c.id, step.stepIndex, idempotencyKey, messageId, email, built.subject, now],
    );
    await tx.query(`update scheduled_steps set status = 'SENT', sent_at = $2, message_id = $3 where id = $1 and status = 'SENDING'`, [step.id, now, messageId]);
    await logAction(tx, { tenantId: tenant.id, caseId: c.id, actor: 'system', action: 'email.sent', details: { stepIndex: step.stepIndex, messageId } });
    return { kind: 'sent', messageId };
  });

  if (result.kind === 'error') {
    const err = result.err;
    if (err instanceof MailerError && err.permanent) {
      await failStep(deps, step, c, err.message);
      return 'failed';
    }
    return temporaryFailure(deps, step, c, err.message);
  }
  if (result.kind !== 'sent') return result.kind;
  return 'sent';
}

/** Étape passée FAILED par recoverStaleReservations (plafond de tentatives atteint) : journal et alerte, comme failStep. */
async function reportAbandonedStep(deps: Deps, step: StepRow) {
  const inv = (await deps.pool.query(`select stripe_invoice_id from recovery_cases where id = $1`, [step.caseId])).rows[0]?.stripe_invoice_id ?? step.caseId;
  await logAction(deps.pool, { tenantId: step.tenantId, caseId: step.caseId, actor: 'system', action: 'email.failed', details: { stepIndex: step.stepIndex, reason: 'reservation_abandoned' } });
  await raiseAlert(deps.pool, {
    tenantId: step.tenantId,
    kind: 'email_failed',
    dedupeKey: `email_failed:${step.caseId}:${step.stepIndex}`,
    message: `L'email ${step.stepIndex + 1} du dossier ${inv} n'a pas pu être envoyé.`,
    details: { reason: 'reservation_abandoned' },
  });
}

/**
 * Erreur inattendue avant la transaction d'envoi (lien, modèle, client supprimé…) : sans cela l'étape resterait
 * SENDING et bloquerait tout le dossier. Même politique que les erreurs temporaires : délai croissant puis FAILED.
 */
async function handleUnexpectedError(deps: Deps, step: StepRow, err: Error): Promise<StepOutcome> {
  try {
    const row = (await deps.pool.query(`select * from recovery_cases where id = $1`, [step.caseId])).rows[0];
    if (!row) {
      await finishStep(deps, step, 'CANCELED', 'case_missing');
      return 'skipped';
    }
    return await temporaryFailure(deps, step, mapCase(row), `inattendu: ${err.message}`);
  } catch (e) {
    deps.log.error({ stepId: step.id, err: (e as Error).message }, "impossible de remettre en file l'étape après une erreur inattendue");
    return 'released';
  }
}

/** Une passe du worker d'envoi : reprend les réservations abandonnées, réserve les étapes échues, les traite. */
export async function runDueSteps(deps: Deps, opts: { limit?: number } = {}): Promise<SendStats> {
  const now = deps.clock.now();
  const recovered = await recoverStaleReservations(deps.pool, now, STALE_RESERVATION_MS, MAX_SEND_ATTEMPTS);
  for (const r of recovered.filter((x) => x.status === 'FAILED')) await reportAbandonedStep(deps, r);
  const reserved = await reserveDueSteps(deps.pool, now, opts.limit ?? deps.config.stepBatchSize);
  const stats: SendStats = { sent: 0, skipped: 0, failed: 0, released: 0 };
  for (const step of reserved) {
    try {
      stats[await sendReservedStep(deps, step)]++;
    } catch (e) {
      deps.log.error({ stepId: step.id, caseId: step.caseId, err: (e as Error).message }, "erreur inattendue pendant l'envoi d'une étape");
      stats[await handleUnexpectedError(deps, step, e as Error)]++;
    }
  }
  return stats;
}

/** Passe en LOST les dossiers dont toutes les relances sont passées depuis plus de 3 jours (ou sans aucune étape, depuis l'échec). */
export async function closeExhaustedCases(deps: Deps): Promise<number> {
  const threshold = new Date(deps.clock.now().getTime() - EXHAUSTED_GRACE_DAYS * 86400_000);
  const res = await deps.pool.query(
    `select c.* from recovery_cases c
      where c.state = 'RECOVERING'
        and not exists (select 1 from scheduled_steps s where s.case_id = c.id and s.status in ('SCHEDULED','SENDING'))
        -- relances arrêtées par une révocation Stripe : le dossier attend la reconnexion, il n'est pas « épuisé »
        and not exists (select 1 from stripe_connections sc where sc.tenant_id = c.tenant_id and sc.status <> 'ACTIVE')
        and not exists (select 1 from scheduled_steps s where s.case_id = c.id and s.status = 'CANCELED' and s.skip_reason = 'stripe_revoked')
        and coalesce((select max(coalesce(s.sent_at, s.due_at)) from scheduled_steps s where s.case_id = c.id), c.failed_at) < $1`,
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
