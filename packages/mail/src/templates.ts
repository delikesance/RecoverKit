import { renderTemplate, type EmailTemplate, type TemplateValues } from '@recoverkit/core';

export type Locale = 'fr' | 'en';

const FR: EmailTemplate[] = [
  {
    subject: 'Votre paiement de {{amount}} n’a pas abouti',
    body: `Bonjour {{customer_name}},

Nous n’avons pas pu débiter votre carte pour votre abonnement {{plan}} chez {{tenant_name}}.

Mettez-la à jour en une minute pour garder l’accès à votre compte :

{{update_link}}

Nous retenterons le paiement dès que votre carte sera à jour.`,
  },
  {
    subject: 'Rappel : mettez à jour votre carte ({{amount}})',
    body: `Bonjour {{customer_name}},

Votre paiement de {{amount}} pour l’abonnement {{plan}} n’a toujours pas abouti.

Vous pouvez mettre à jour votre carte ici :

{{update_link}}

Si vous l’avez déjà fait, ignorez ce message.`,
  },
  {
    subject: 'Votre accès à {{tenant_name}} sera bientôt suspendu',
    body: `Bonjour {{customer_name}},

Sans mise à jour de votre carte, votre abonnement {{plan}} ({{amount}}) risque d’être suspendu.

Mettez-la à jour maintenant :

{{update_link}}

Besoin d’aide ? Répondez simplement à cet email.`,
  },
  {
    subject: 'Dernier avis avant la suspension de votre abonnement',
    body: `Bonjour {{customer_name}},

C’est notre dernier message : le paiement de {{amount}} pour votre abonnement {{plan}} n’a pas pu être effectué.

Pour conserver votre accès à {{tenant_name}}, mettez votre carte à jour :

{{update_link}}`,
  },
];

const EN: EmailTemplate[] = [
  {
    subject: 'Your payment of {{amount}} didn’t go through',
    body: `Hi {{customer_name}},

We couldn’t charge your card for your {{plan}} subscription to {{tenant_name}}.

Update it in a minute to keep your access:

{{update_link}}

We’ll retry the payment as soon as your card is updated.`,
  },
  {
    subject: 'Reminder: please update your card ({{amount}})',
    body: `Hi {{customer_name}},

Your {{amount}} payment for the {{plan}} subscription still hasn’t gone through.

You can update your card here:

{{update_link}}

If you already did, please ignore this message.`,
  },
  {
    subject: 'Your access to {{tenant_name}} will soon be suspended',
    body: `Hi {{customer_name}},

Without an updated card, your {{plan}} subscription ({{amount}}) may be suspended.

Update it now:

{{update_link}}

Need help? Just reply to this email.`,
  },
  {
    subject: 'Final notice before your subscription is suspended',
    body: `Hi {{customer_name}},

This is our last message: your {{amount}} payment for the {{plan}} subscription couldn’t be processed.

To keep your access to {{tenant_name}}, update your card:

{{update_link}}`,
  },
];

export function defaultTemplate(stepIndex: number, locale: Locale): EmailTemplate {
  const list = locale === 'fr' ? FR : EN;
  return { ...list[Math.min(Math.max(stepIndex, 0), list.length - 1)]! };
}

const FOOTER = {
  fr: {
    sentBy: (tenant: string) => `Cet email vous est envoyé par ${tenant} au sujet de votre abonnement.`,
    contact: 'Une question ? Écrivez à',
    unsubscribe: 'Ne plus recevoir ces relances',
  },
  en: {
    sentBy: (tenant: string) => `This email was sent by ${tenant} about your subscription.`,
    contact: 'Questions? Write to',
    unsubscribe: 'Unsubscribe from these reminders',
  },
};

const BUTTON_LABEL = { fr: 'Mettre à jour ma carte', en: 'Update my card' };

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export interface BuiltEmail {
  subject: string;
  html: string;
  text: string;
}

export function buildEmail(o: {
  template: EmailTemplate;
  values: TemplateValues;
  locale: Locale;
  tenantName: string;
  supportEmail: string | null;
  unsubscribeUrl: string;
  /** Bandeau affiché en tête (ex. « Mode test ») ; absent des emails réels. */
  banner?: string;
}): BuiltEmail {
  const plain = renderTemplate(o.template, o.values);
  const htmlBody = renderTemplate(o.template, o.values, { html: true }).body;
  const f = FOOTER[o.locale];

  const paragraphs = htmlBody.split(/\n{2,}/);
  const rawParagraphs = plain.body.split(/\n{2,}/);
  const htmlParts = paragraphs.map((p, i) => {
    if (rawParagraphs[i]!.trim() === o.values.update_link) {
      return `<p style="margin:24px 0"><a href="${esc(o.values.update_link)}" style="display:inline-block;background:#2557E8;color:#ffffff;text-decoration:none;font-weight:600;padding:14px 24px;border-radius:12px">${BUTTON_LABEL[o.locale]}</a></p>`;
    }
    return `<p style="margin:0 0 16px;line-height:1.6">${p.replace(/\n/g, '<br>')}</p>`;
  });

  const contactHtml = o.supportEmail
    ? `<br>${f.contact} <a href="mailto:${esc(o.supportEmail)}" style="color:#667085">${esc(o.supportEmail)}</a>.`
    : '';
  const html = `<!doctype html><html lang="${o.locale}"><body style="margin:0;background:#F3F5F8;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#101828"><div style="max-width:560px;margin:0 auto;padding:32px 20px"><div style="background:#ffffff;border:1px solid #E4E7EC;border-radius:20px;padding:32px">${o.banner ? `<div style="background:#FEF0C7;color:#93370D;font-weight:600;font-size:13px;border-radius:12px;padding:10px 14px;margin-bottom:20px">${esc(o.banner)}</div>` : ''}<div style="font-weight:700;font-size:18px;margin-bottom:24px">${esc(o.tenantName)}</div>${htmlParts.join('')}</div><p style="color:#667085;font-size:12px;line-height:1.6;margin:20px 8px 0">${esc(f.sentBy(o.tenantName))}${contactHtml}<br><a href="${esc(o.unsubscribeUrl)}" style="color:#667085">${f.unsubscribe}</a></p></div></body></html>`;

  const textFooter = [
    f.sentBy(o.tenantName),
    o.supportEmail ? `${f.contact} ${o.supportEmail}.` : null,
    `${f.unsubscribe} : ${o.unsubscribeUrl}`,
  ]
    .filter(Boolean)
    .join('\n');
  const text = `${o.banner ? `[${o.banner}]\n\n` : ''}${plain.body}\n\n--\n${textFooter}\n`;

  return { subject: plain.subject, html, text };
}
