'use server';

import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import {
  acknowledgeNativeEmails,
  checkSenderDomain,
  closeCaseManually,
  configureSender,
  confirmDefaultSender,
  deleteTenant,
  disconnectStripe,
  openPortal,
  pauseCase,
  removeSender,
  resetTemplate,
  resumeCase,
  saveSequence,
  saveTemplate,
  sendNextNow,
  sendTestEmail,
  setDryRun,
  startCheckout,
  updateSettings,
  type ActivationMissing,
} from '@recoverkit/services';
import { getDeps } from '@/server/runtime';
import { requireSession } from '@/server/session';

const actor = (userId: string) => `user:${userId}`;
const str = (f: FormData, k: string) => String(f.get(k) ?? '');

function back(path: string, params: Record<string, string>): never {
  const q = new URLSearchParams(params).toString();
  redirect(q ? `${path}?${q}` : path);
}

// ── Dossiers ────────────────────────────────────────────────────────────────

const CASE_NOTICE: Record<string, string> = {
  ok: 'done',
  invalid_state: 'invalid_state',
  not_found: 'not_found',
  queued: 'queued',
  already_due: 'already_due',
  not_active: 'not_active',
  in_progress: 'in_progress',
  no_step: 'no_step',
  too_soon: 'too_soon',
  reason_required: 'reason_required',
};

async function caseAction(caseId: string, fn: (deps: ReturnType<typeof getDeps>, s: Awaited<ReturnType<typeof requireSession>>) => Promise<{ status: string }>, ok: string): Promise<never> {
  const s = await requireSession();
  const r = await fn(getDeps(), s);
  revalidatePath('/app', 'layout');
  back(`/app/cases/${caseId}`, { notice: r.status === 'ok' || r.status === 'queued' ? ok : (CASE_NOTICE[r.status] ?? 'error') });
}

export async function pauseCaseAction(formData: FormData) {
  const id = str(formData, 'caseId');
  await caseAction(id, (d, s) => pauseCase(d, s.tenantId, id, actor(s.userId)), 'paused');
}
export async function resumeCaseAction(formData: FormData) {
  const id = str(formData, 'caseId');
  await caseAction(id, (d, s) => resumeCase(d, s.tenantId, id, actor(s.userId)), 'resumed');
}
export async function sendNowAction(formData: FormData) {
  const id = str(formData, 'caseId');
  await caseAction(id, (d, s) => sendNextNow(d, s.tenantId, id, actor(s.userId)), 'queued');
}
export async function closeCaseAction(formData: FormData) {
  const id = str(formData, 'caseId');
  await caseAction(id, (d, s) => closeCaseManually(d, s.tenantId, id, actor(s.userId), str(formData, 'reason')), 'closed');
}

// ── Séquence et modèles ─────────────────────────────────────────────────────

export async function saveSequenceAction(formData: FormData) {
  const s = await requireSession();
  const steps: { delayMinutes: number; active: boolean }[] = [];
  for (let i = 0; i < 6; i++) {
    const raw = str(formData, `delay_${i}`).trim().replace(',', '.');
    if (raw === '') continue;
    const unit = str(formData, `unit_${i}`) === 'days' ? 1440 : 60;
    steps.push({ delayMinutes: Math.round(Number(raw) * unit), active: formData.get(`active_${i}`) === 'on' });
  }
  const r = await saveSequence(getDeps(), s.tenantId, steps, actor(s.userId));
  if (r.status === 'invalid') back('/app/sequence', { error: r.errors.join(' ') });
  revalidatePath('/app/sequence');
  back('/app/sequence', { notice: 'saved' });
}

export async function saveTemplateAction(formData: FormData) {
  const s = await requireSession();
  const locale = str(formData, 'locale') === 'en' ? 'en' : 'fr';
  const r = await saveTemplate(getDeps(), s.tenantId, { stepIndex: Number(str(formData, 'stepIndex')), locale, subject: str(formData, 'subject'), body: str(formData, 'body') }, actor(s.userId));
  if (r.status === 'invalid') back('/app/emails', { locale, error: r.errors.join(' ') });
  back('/app/emails', { locale, notice: 'saved' });
}

export async function resetTemplateAction(formData: FormData) {
  const s = await requireSession();
  const locale = str(formData, 'locale') === 'en' ? 'en' : 'fr';
  await resetTemplate(getDeps(), s.tenantId, Number(str(formData, 'stepIndex')), locale, actor(s.userId));
  back('/app/emails', { locale, notice: 'reset' });
}

export async function sendTestEmailAction(formData: FormData) {
  const s = await requireSession();
  const locale = str(formData, 'locale') === 'en' ? 'en' : 'fr';
  const r = await sendTestEmail(getDeps(), s.tenantId, s.email, { stepIndex: Number(str(formData, 'stepIndex')), locale });
  const target = str(formData, 'from') === 'onboarding' ? '/app/onboarding' : '/app/emails';
  back(target, { locale, notice: r.status === 'sent' ? 'test_sent' : 'test_limited' });
}

// ── Réglages ────────────────────────────────────────────────────────────────

export async function updateSettingsAction(formData: FormData) {
  const s = await requireSession();
  const r = await updateSettings(
    getDeps(),
    s.tenantId,
    {
      name: str(formData, 'name'),
      timeZone: str(formData, 'timeZone'),
      sendStartHour: Number(str(formData, 'sendStartHour')),
      sendEndHour: Number(str(formData, 'sendEndHour')),
      supportEmail: str(formData, 'supportEmail').trim() || null,
      replyTo: str(formData, 'replyTo').trim() || null,
      locale: str(formData, 'locale') as 'fr' | 'en',
      emailsEnabled: formData.get('emailsEnabled') === 'on',
      digestEnabled: formData.get('digestEnabled') === 'on',
    },
    actor(s.userId),
  );
  if (r.status === 'invalid') back('/app/settings', { error: r.errors.join(' ') });
  revalidatePath('/app', 'layout');
  back('/app/settings', { notice: 'saved' });
}

export async function configureSenderAction(formData: FormData) {
  const s = await requireSession();
  const r = await configureSender(getDeps(), s.tenantId, { email: str(formData, 'senderEmail'), name: str(formData, 'senderName') });
  back('/app/settings', { notice: r.status === 'pending' ? 'sender_pending' : `sender_${r.status}` });
}

export async function checkSenderAction() {
  const s = await requireSession();
  const r = await checkSenderDomain(getDeps(), s.tenantId, { trigger: true });
  back('/app/settings', { notice: `sender_${r.status}` });
}

export async function removeSenderAction() {
  const s = await requireSession();
  await removeSender(getDeps(), s.tenantId);
  back('/app/settings', { notice: 'sender_removed' });
}

const MISSING_LABEL: Record<ActivationMissing, string> = {
  stripe_connected: 'connexion Stripe',
  sender_valid: 'domaine d’envoi vérifié',
  native_emails_acknowledged: 'désactivation des relances natives de Stripe',
  test_email_sent: 'email de test',
};

export async function setDryRunAction(formData: FormData) {
  const s = await requireSession();
  const live = str(formData, 'mode') === 'live';
  const r = await setDryRun(getDeps(), s.tenantId, !live, actor(s.userId));
  revalidatePath('/app', 'layout');
  const target = str(formData, 'from') === 'onboarding' ? '/app/onboarding' : '/app/settings';
  if (r.status === 'blocked') back(target, { error: `Avant d’activer les relances : ${r.missing.map((m) => MISSING_LABEL[m]).join(', ')}.` });
  back(target, { notice: live ? 'activated' : 'dry_run' });
}

export async function acknowledgeNativeEmailsAction() {
  const s = await requireSession();
  await acknowledgeNativeEmails(getDeps(), s.tenantId);
  back('/app/onboarding', {});
}

export async function confirmSenderAction() {
  const s = await requireSession();
  await confirmDefaultSender(getDeps(), s.tenantId);
  back('/app/onboarding', {});
}

export async function disconnectStripeAction() {
  const s = await requireSession();
  await disconnectStripe(getDeps(), s.tenantId);
  revalidatePath('/app', 'layout');
  back('/app/settings', { notice: 'stripe_disconnected' });
}

export async function deleteAccountAction(formData: FormData) {
  const s = await requireSession();
  const r = await deleteTenant(getDeps(), s.tenantId, { confirmName: str(formData, 'confirmName'), actor: actor(s.userId) });
  if (r.status !== 'deleted') back('/app/settings', { error: 'Le nom saisi ne correspond pas : le compte n’a pas été supprimé.' });
  (await cookies()).delete('rk_session');
  redirect('/?deleted=1');
}

// ── Abonnement ──────────────────────────────────────────────────────────────

export async function startCheckoutAction(formData: FormData) {
  const s = await requireSession();
  const r = await startCheckout(getDeps(), s.tenantId, str(formData, 'plan'));
  if (r.status !== 'ok') back('/app/billing', { error: 'Ce palier n’est pas disponible.' });
  redirect(r.url);
}

export async function openPortalAction() {
  const s = await requireSession();
  const r = await openPortal(getDeps(), s.tenantId);
  if (r.status !== 'ok') back('/app/billing', { error: 'Aucun abonnement à gérer pour l’instant.' });
  redirect(r.url);
}
