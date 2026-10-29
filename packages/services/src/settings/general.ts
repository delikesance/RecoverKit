import { z } from 'zod';
import { logAction } from '@recoverkit/db';
import type { Deps } from '../deps';
import { loadTenant } from '../recovery/ops';

export interface SettingsInput {
  name?: string;
  timeZone?: string;
  sendStartHour?: number;
  sendEndHour?: number;
  supportEmail?: string | null;
  replyTo?: string | null;
  locale?: 'fr' | 'en';
  emailsEnabled?: boolean;
  digestEnabled?: boolean;
}

function validTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const email = z.string().email();

export async function updateSettings(
  deps: Deps,
  tenantId: string,
  input: SettingsInput,
  actor = 'user',
): Promise<{ status: 'ok' } | { status: 'invalid'; errors: string[] }> {
  const current = await loadTenant(deps.pool, tenantId);
  if (!current) throw new Error('Tenant introuvable');
  const errors: string[] = [];

  if (input.name !== undefined && (input.name.trim().length < 1 || input.name.trim().length > 80)) errors.push('Le nom doit contenir entre 1 et 80 caractères.');
  if (input.timeZone !== undefined && !validTimeZone(input.timeZone)) errors.push('Fuseau horaire inconnu.');
  if (input.locale !== undefined && !['fr', 'en'].includes(input.locale)) errors.push('Langue non prise en charge.');
  for (const [label, v] of [['support', input.supportEmail], ['de réponse', input.replyTo]] as const) {
    if (v && !email.safeParse(v).success) errors.push(`Adresse email ${label} invalide.`);
  }
  const start = input.sendStartHour ?? current.sendStartHour;
  const end = input.sendEndHour ?? current.sendEndHour;
  if (!Number.isInteger(start) || start < 0 || start > 23) errors.push('Heure de début invalide (0 à 23).');
  else if (!Number.isInteger(end) || end < 1 || end > 24) errors.push('Heure de fin invalide (1 à 24).');
  else if (end <= start) errors.push('La fenêtre d’envoi doit se terminer après son début.');
  if (errors.length > 0) return { status: 'invalid', errors };

  await deps.pool.query(
    `update tenants set
       name = coalesce($2, name), time_zone = coalesce($3, time_zone), send_start_hour = $4, send_end_hour = $5,
       support_email = case when $6::boolean then $7 else support_email end,
       reply_to = case when $8::boolean then $9 else reply_to end,
       locale = coalesce($10, locale), emails_enabled = coalesce($11, emails_enabled), digest_enabled = coalesce($12, digest_enabled)
     where id = $1`,
    [
      tenantId, input.name?.trim() ?? null, input.timeZone ?? null, start, end,
      input.supportEmail !== undefined, input.supportEmail ?? null,
      input.replyTo !== undefined, input.replyTo ?? null,
      input.locale ?? null, input.emailsEnabled ?? null, input.digestEnabled ?? null,
    ],
  );
  await logAction(deps.pool, { tenantId, caseId: null, actor, action: 'settings.updated', details: { fields: Object.keys(input) } });
  return { status: 'ok' };
}

async function onboardingJson(deps: Deps, tenantId: string): Promise<Record<string, any>> {
  const res = await deps.pool.query(`select onboarding from tenants where id = $1`, [tenantId]);
  return res.rows[0]?.onboarding ?? {};
}

export async function acknowledgeNativeEmails(deps: Deps, tenantId: string): Promise<void> {
  await deps.pool.query(`update tenants set onboarding = onboarding || '{"nativeEmailsAcknowledged": true}'::jsonb where id = $1`, [tenantId]);
}

export async function confirmDefaultSender(deps: Deps, tenantId: string): Promise<void> {
  await deps.pool.query(`update tenants set onboarding = onboarding || '{"senderConfirmed": true}'::jsonb where id = $1`, [tenantId]);
}

/** Nom donné à la création du compte : il apparaît chez le client final, il doit être remplacé avant l'activation. */
export const DEFAULT_TENANT_NAME = 'Mon entreprise';

export type ActivationMissing = 'stripe_connected' | 'sender_valid' | 'native_emails_acknowledged' | 'test_email_sent' | 'company_name';

export async function setDryRun(
  deps: Deps,
  tenantId: string,
  dryRun: boolean,
  actor: string,
): Promise<{ status: 'ok' } | { status: 'blocked'; missing: ActivationMissing[] }> {
  if (!dryRun) {
    const tenant = await loadTenant(deps.pool, tenantId);
    const conn = await deps.pool.query(`select status from stripe_connections where tenant_id = $1`, [tenantId]);
    const ob = await onboardingJson(deps, tenantId);
    const missing: ActivationMissing[] = [];
    if (conn.rows[0]?.status !== 'ACTIVE') missing.push('stripe_connected');
    if (tenant?.senderEmail && !tenant.senderVerified) missing.push('sender_valid');
    if (!ob.nativeEmailsAcknowledged) missing.push('native_emails_acknowledged');
    if (!ob.testEmailSentAt) missing.push('test_email_sent');
    if (!tenant || tenant.name.trim().toLowerCase() === DEFAULT_TENANT_NAME.toLowerCase()) missing.push('company_name');
    if (missing.length > 0) return { status: 'blocked', missing };
  }
  await deps.pool.query(`update tenants set dry_run = $2 where id = $1`, [tenantId, dryRun]);
  await logAction(deps.pool, { tenantId, caseId: null, actor, action: dryRun ? 'tenant.dry_run' : 'tenant.activated', details: {} });
  return { status: 'ok' };
}

export type OnboardingKey = 'stripe' | 'sender' | 'native_emails' | 'activate';

export async function getOnboardingStatus(
  deps: Deps,
  tenantId: string,
): Promise<{ steps: { key: OnboardingKey; done: boolean }[]; current: OnboardingKey | null; complete: boolean }> {
  const tenant = await loadTenant(deps.pool, tenantId);
  const conn = await deps.pool.query(`select status from stripe_connections where tenant_id = $1`, [tenantId]);
  const ob = await onboardingJson(deps, tenantId);
  const steps: { key: OnboardingKey; done: boolean }[] = [
    { key: 'stripe', done: conn.rows[0]?.status === 'ACTIVE' },
    { key: 'sender', done: !!(tenant?.senderVerified || ob.senderConfirmed) },
    { key: 'native_emails', done: !!ob.nativeEmailsAcknowledged },
    { key: 'activate', done: tenant ? !tenant.dryRun : false },
  ];
  const current = steps.find((s) => !s.done)?.key ?? null;
  return { steps, current, complete: current === null };
}
