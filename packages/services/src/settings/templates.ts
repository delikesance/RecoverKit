import { randomUUID } from 'node:crypto';
import { Money, validateTemplate, type EmailTemplate, type TemplateValues } from '@recoverkit/core';
import { hitRateLimit, logAction } from '@recoverkit/db';
import { buildEmail, defaultTemplate, type BuiltEmail, type Locale } from '@recoverkit/mail';
import type { Deps } from '../deps';
import { loadTenant } from '../recovery/ops';
import { getSequence } from './sequence';

export interface TemplateView extends EmailTemplate {
  stepIndex: number;
  isCustom: boolean;
}

const MIDDLE: Record<Locale, EmailTemplate[]> = {
  fr: [
    {
      subject: 'Votre abonnement {{plan}} est toujours en attente de paiement',
      body: `Bonjour {{customer_name}},

Le paiement de {{amount}} pour votre abonnement {{plan}} chez {{tenant_name}} n’a toujours pas pu être effectué.

Mettez votre carte à jour pour éviter toute interruption :

{{update_link}}

Besoin d’aide ? Répondez simplement à cet email.`,
    },
    {
      subject: 'Nouveau rappel : votre paiement de {{amount}} est en attente',
      body: `Bonjour {{customer_name}},

Nous vous relançons car votre paiement de {{amount}} pour l’abonnement {{plan}} n’est pas encore réglé.

Quelques instants suffisent pour mettre votre carte à jour :

{{update_link}}

Si c’est déjà fait, ignorez ce message.`,
    },
  ],
  en: [
    {
      subject: 'Your {{plan}} subscription is still awaiting payment',
      body: `Hi {{customer_name}},

Your {{amount}} payment for the {{plan}} subscription to {{tenant_name}} still hasn’t gone through.

Update your card to avoid any interruption:

{{update_link}}

Need help? Just reply to this email.`,
    },
    {
      subject: 'Another reminder: your {{amount}} payment is pending',
      body: `Hi {{customer_name}},

We’re following up because your {{amount}} payment for the {{plan}} subscription hasn’t been settled yet.

It only takes a moment to update your card:

{{update_link}}

If you already did, please ignore this message.`,
    },
  ],
};

/**
 * Modèle par défaut d'une étape : « dernier avis » seulement pour la dernière étape d'une séquence
 * de plus de 4 étapes ; les étapes intermédiaires au-delà de la 3e ont leur propre texte.
 */
export function defaultTemplateFor(stepIndex: number, locale: Locale, totalSteps: number): EmailTemplate {
  if (totalSteps <= 4 || stepIndex <= 2) return defaultTemplate(stepIndex, locale);
  if (stepIndex >= totalSteps - 1) return defaultTemplate(3, locale);
  const middle = MIDDLE[locale];
  return { ...middle[(stepIndex - 3) % middle.length]! };
}

export async function getTemplates(deps: Deps, tenantId: string, locale: Locale): Promise<TemplateView[]> {
  const seq = await getSequence(deps, tenantId);
  const count = Math.max(seq?.steps.length ?? 0, 4);
  const custom = await deps.pool.query(`select step_index, subject, body from email_templates where tenant_id = $1 and locale = $2`, [tenantId, locale]);
  const byStep = new Map<number, EmailTemplate>(custom.rows.map((r) => [r.step_index, { subject: r.subject, body: r.body }]));
  return Array.from({ length: count }, (_, i) => {
    const c = byStep.get(i);
    return { stepIndex: i, isCustom: !!c, ...(c ?? defaultTemplateFor(i, locale, count)) };
  });
}

export async function saveTemplate(
  deps: Deps,
  tenantId: string,
  t: { stepIndex: number; locale: Locale; subject: string; body: string },
  actor = 'user',
): Promise<{ status: 'ok' } | { status: 'invalid'; errors: string[] }> {
  const check = validateTemplate({ subject: t.subject, body: t.body });
  const errors = [...check.errors];
  if (!Number.isInteger(t.stepIndex) || t.stepIndex < 0 || t.stepIndex > 5) errors.push('Numéro d’étape invalide.');
  if (errors.length > 0) return { status: 'invalid', errors };
  await deps.pool.query(
    `insert into email_templates (tenant_id, step_index, locale, subject, body, updated_at) values ($1,$2,$3,$4,$5,$6)
     on conflict (tenant_id, step_index, locale) do update set subject = excluded.subject, body = excluded.body, updated_at = excluded.updated_at`,
    [tenantId, t.stepIndex, t.locale, t.subject, t.body, deps.clock.now()],
  );
  await logAction(deps.pool, { tenantId, caseId: null, actor, action: 'template.saved', details: { stepIndex: t.stepIndex, locale: t.locale } });
  return { status: 'ok' };
}

export async function resetTemplate(deps: Deps, tenantId: string, stepIndex: number, locale: Locale, actor = 'user'): Promise<void> {
  await deps.pool.query(`delete from email_templates where tenant_id = $1 and step_index = $2 and locale = $3`, [tenantId, stepIndex, locale]);
  await logAction(deps.pool, { tenantId, caseId: null, actor, action: 'template.reset', details: { stepIndex, locale } });
}

function sampleValues(locale: Locale, tenantName: string, link: string): TemplateValues {
  return {
    customer_name: 'Camille',
    amount: Money.of(2900, 'EUR').format(locale === 'fr' ? 'fr-FR' : 'en-US'),
    plan: 'Pro',
    update_link: link,
    tenant_name: tenantName,
  };
}

/** Aperçu avec des données d'exemple (aucun envoi). */
export function previewTemplate(template: EmailTemplate, locale: Locale, tenantName: string): BuiltEmail {
  return buildEmail({
    template,
    values: sampleValues(locale, tenantName, 'https://example.com/pay/apercu'),
    locale,
    tenantName,
    supportEmail: null,
    unsubscribeUrl: 'https://example.com/unsubscribe',
  });
}

/** Envoie un email de test au fondateur (5 par heure et par tenant). */
export async function sendTestEmail(
  deps: Deps,
  tenantId: string,
  to: string,
  o: { stepIndex: number; locale: Locale },
): Promise<{ status: 'sent' } | { status: 'rate_limited' }> {
  const now = deps.clock.now();
  const limit = await hitRateLimit(deps.pool, `testmail:${tenantId}`, { limit: 5, windowSeconds: 3600 }, now);
  if (!limit.allowed) return { status: 'rate_limited' };
  const tenant = await loadTenant(deps.pool, tenantId);
  if (!tenant) throw new Error('Tenant introuvable');

  const template = (await getTemplates(deps, tenantId, o.locale))[o.stepIndex] ?? defaultTemplate(o.stepIndex, o.locale);
  const built = buildEmail({
    template: { subject: template.subject, body: template.body },
    values: sampleValues(o.locale, tenant.name, `${deps.config.appUrl}/pay/apercu`),
    locale: o.locale,
    tenantName: tenant.name,
    supportEmail: tenant.supportEmail,
    unsubscribeUrl: `${deps.config.appUrl}/unsubscribe`,
    banner: o.locale === 'fr' ? 'Mode test : cet email n’est envoyé qu’à vous, le lien n’est pas actif.' : 'Test mode: this email was sent only to you, the link is not active.',
  });
  await deps.mailer.send({
    to: to.trim().toLowerCase(),
    from:
      tenant.senderVerified && tenant.senderEmail
        ? { name: tenant.senderName ?? tenant.name, email: tenant.senderEmail }
        : { name: tenant.senderName ?? tenant.name, email: deps.config.defaultFromEmail },
    replyTo: tenant.replyTo ?? tenant.supportEmail ?? undefined,
    subject: `[Test] ${built.subject}`,
    html: built.html,
    text: built.text,
    idempotencyKey: `test:${tenantId}:${randomUUID()}`,
  });
  await deps.pool.query(`update tenants set onboarding = onboarding || jsonb_build_object('testEmailSentAt', $2::text) where id = $1`, [tenantId, now.toISOString()]);
  return { status: 'sent' };
}
