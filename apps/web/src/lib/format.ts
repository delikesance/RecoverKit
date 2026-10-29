import { Money, partsInZone } from '@recoverkit/core';

export type Tone = 'success' | 'warning' | 'danger' | 'neutral' | 'info';

export function formatMoney(amount: number, currency: string): string {
  return Money.of(amount, currency).format('fr-FR');
}

export function formatPercent(ratio: number | null): string {
  if (ratio === null) return 'Aucun';
  return new Intl.NumberFormat('fr-FR', { style: 'percent', maximumFractionDigits: 0 }).format(ratio);
}

export function formatVariation(ratio: number | null): string | null {
  if (ratio === null) return null;
  const abs = Math.round(Math.abs(ratio) * 100); // demi arrondi loin de zéro : +12,5 → +13 et −12,5 → −13
  if (abs === 0) return '0\u202f%';
  return `${ratio > 0 ? '+' : '−'}${abs}\u202f%`;
}

export function formatShortDate(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', timeZone }).format(date);
}

export function formatDateTime(date: Date, timeZone: string): string {
  const p = partsInZone(date, timeZone);
  const day = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', timeZone }).format(date);
  return `${day}, ${String(p.h).padStart(2, '0')}:${String(p.min).padStart(2, '0')}`;
}

export function monthLabel(year: number, month: number): string {
  return new Intl.DateTimeFormat('fr-FR', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(year, month - 1, 1)));
}

export function relativeFromNow(date: Date, now: Date): string {
  const diffMs = date.getTime() - now.getTime();
  const abs = Math.abs(diffMs);
  const rtf = new Intl.RelativeTimeFormat('fr', { numeric: 'always' });
  const rtfAuto = new Intl.RelativeTimeFormat('fr', { numeric: 'auto' });
  const sign = diffMs < 0 ? -1 : 1;
  if (abs < 60_000) return 'à l’instant';
  if (abs < 3600_000) return rtf.format(sign * Math.round(abs / 60_000), 'minute');
  if (abs < 86400_000) return rtf.format(sign * Math.round(abs / 3600_000), 'hour');
  const days = Math.round(abs / 86400_000);
  return days === 1 ? rtfAuto.format(sign, 'day') : rtf.format(sign * days, 'day');
}

export function stepsLabel(sent: number, total: number): string {
  if (total === 0) return 'Aucune relance prévue';
  if (sent === 0) return 'Aucun email envoyé';
  return `${sent} sur ${total}`;
}

const STATES: Record<string, { label: string; tone: Tone }> = {
  OPEN: { label: 'À vérifier', tone: 'warning' },
  RECOVERING: { label: 'En relance', tone: 'neutral' },
  PAUSED: { label: 'En pause', tone: 'neutral' },
  RECOVERED: { label: 'Récupéré', tone: 'success' },
  CANCELED: { label: 'Annulé', tone: 'neutral' },
  LOST: { label: 'Perdu', tone: 'danger' },
  CLOSED_MANUAL: { label: 'Clôturé', tone: 'neutral' },
};

export type Attribution = 'ASSISTED' | 'NATURAL' | null;

/** « Récupéré » seulement si le ledger l'attribue à une relance : un paiement arrivé avant tout email n'est pas compté. */
export function stateLabel(state: string, attribution?: Attribution): { label: string; tone: Tone } {
  if (state === 'RECOVERED') {
    if (attribution === 'ASSISTED') return STATES.RECOVERED!;
    if (attribution === 'NATURAL') return { label: 'Payé sans relance (non compté)', tone: 'neutral' };
    return { label: 'Payé (non compté)', tone: 'neutral' };
  }
  return STATES[state] ?? { label: state, tone: 'neutral' };
}

/** Pastille « Facture » du détail : reflète l'état réel du dossier (une facture clôturée ou perdue n'est pas « impayée à relancer »). */
export function invoiceChip(state: string): { label: string; tone: Tone } {
  switch (state) {
    case 'RECOVERED':
      return { label: 'Payée', tone: 'success' };
    case 'LOST':
      return { label: 'Impayée, relances terminées', tone: 'danger' };
    case 'CANCELED':
      return { label: 'Annulée', tone: 'neutral' };
    case 'CLOSED_MANUAL':
      return { label: 'Clôturée à la main', tone: 'neutral' };
    default:
      return { label: 'Impayée', tone: 'warning' };
  }
}

/** État d'envoi affiché aux fondateurs : dérivé du mode test ET de l'interrupteur « emails ». */
export function sendMode(t: { dryRun: boolean; emailsEnabled: boolean }): { key: 'live' | 'test' | 'disabled'; label: string; tone: Tone; text: string } {
  if (!t.emailsEnabled) {
    return {
      key: 'disabled',
      label: 'Emails désactivés',
      tone: 'danger',
      text: 'Les emails de relance sont désactivés : aucun email ne part. Les relances dues pendant ce temps sont abandonnées, pas reportées. Réactivez-les dans les réglages.',
    };
  }
  if (t.dryRun) return { key: 'test', label: 'Mode test', tone: 'warning', text: 'Mode test : RecoverKit enregistre ce qui serait envoyé, sans écrire à vos clients ni retenter de paiement.' };
  return { key: 'live', label: 'Relances actives', tone: 'success', text: 'Relances actives : vos clients reçoivent les emails et les paiements sont retentés.' };
}

const FAILURES: Record<string, string> = {
  insufficient_funds: 'Fonds insuffisants',
  expired_card: 'Carte expirée',
  incorrect_cvc: 'Code de sécurité incorrect',
  card_declined: 'Carte refusée',
  processing_error: 'Erreur de traitement',
  authentication_required: 'Authentification requise',
};

export function failureLabel(code: string | null): string {
  return (code && FAILURES[code]) || 'Paiement refusé';
}

/** Badge d'une ligne de dossier : met en avant le dernier avis imminent (48 h). */
export function caseBadge(
  c: { state: string; stepsSent: number; stepsTotal: number; nextDueAt: Date | null; attribution?: Attribution },
  now: Date,
): { label: string; tone: Tone } {
  if (c.state === 'RECOVERING' && c.nextDueAt && c.stepsTotal > 0 && c.stepsSent === c.stepsTotal - 1) {
    const ms = c.nextDueAt.getTime() - now.getTime();
    if (ms > 0 && ms <= 48 * 3600_000) {
      const when = ms <= 24 * 3600_000 && c.nextDueAt.getUTCDate() === now.getUTCDate() ? "aujourd'hui" : 'demain';
      return { label: `Dernier avis ${when}`, tone: 'warning' };
    }
  }
  return stateLabel(c.state, c.attribution);
}

export function actionLabel(action: string, d: Record<string, unknown>, attribution?: Attribution): string {
  const step = typeof d.stepIndex === 'number' ? d.stepIndex + 1 : null;
  switch (action) {
    case 'case.opened':
      return 'Échec de paiement détecté';
    case 'case.opened_no_email':
      return 'Échec détecté, mais le client n’a pas d’adresse email';
    case 'case.attempt':
      return 'Nouvel échec de paiement';
    case 'steps.scheduled':
      return 'Relances planifiées';
    case 'email.sent':
      return `Email ${step ?? ''} envoyé`.replace('  ', ' ');
    case 'email.dry_run':
      return `Email ${step ?? ''} simulé (mode test)`.replace('  ', ' ');
    case 'email.failed':
      return `Email ${step ?? ''} non envoyé`.replace('  ', ' ');
    case 'email.bounced':
      return 'Email rebondi';
    case 'email.complained':
      return 'Le client a signalé l’email comme indésirable';
    case 'retry.paid':
      return 'Nouvelle tentative de paiement envoyée';
    case 'retry.failed':
      return `Nouvelle tentative de paiement refusée : ${failureLabel(String(d.errorCode ?? '')).toLowerCase()}`;
    case 'retry.requires_action':
      return 'Le paiement demande une authentification de la banque';
    case 'retry.pre_final':
      return 'Nouvelle tentative avant le dernier avis';
    case 'retry.skipped_dry_run':
      return 'Nouvelle tentative ignorée (mode test)';
    case 'case.recovered':
      if (attribution === 'ASSISTED') return 'Paiement récupéré';
      if (attribution === 'NATURAL') return 'Payé sans relance (non compté)';
      return 'Facture payée (aucun revenu compté)';
    case 'case.canceled':
      return 'Dossier annulé';
    case 'case.lost':
      return 'Dossier perdu : toutes les relances sont passées';
    case 'case.paused':
      return 'Dossier mis en pause';
    case 'case.resumed':
      return 'Relances reprises';
    case 'case.send_now':
      return 'Envoi immédiat demandé';
    case 'case.closed_manual':
      return `Dossier clôturé manuellement${d.reason ? ` : ${String(d.reason)}` : ''}`;
    case 'ledger.recorded':
      return d.attribution === 'NATURAL' ? 'Paiement enregistré, non compté dans le revenu récupéré' : 'Revenu récupéré enregistré';
    case 'case.paid_after_close':
      return `Facture payée après la clôture du dossier (${d.attribution === 'NATURAL' ? 'non comptée' : 'revenu récupéré enregistré'})`;
    case 'email.deferred':
      return `Email ${step ?? ''} repoussé : un autre email est parti il y a moins de 12 h`.replace('  ', ' ');
    case 'email.retry_scheduled':
      return `Email ${step ?? ''} : nouvel essai d’envoi planifié`.replace('  ', ' ');
    case 'steps.rescheduled':
      return 'Relances replanifiées après la reconnexion de Stripe';
    case 'case.failure_ignored':
      return 'Nouvel échec ignoré : le dossier est déjà clos';
    case 'paid.ignored_stale':
      return 'Paiement ignoré : la facture a changé depuis';
    case 'ledger.adjusted':
      return 'Revenu ajusté (remboursement ou litige)';
    default:
      return action;
  }
}
