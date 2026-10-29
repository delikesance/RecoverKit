import { describe, expect, it } from 'vitest';
import {
  actionLabel,
  caseBadge,
  failureLabel,
  formatDateTime,
  formatMoney,
  formatPercent,
  formatShortDate,
  formatVariation,
  invoiceChip,
  monthLabel,
  relativeFromNow,
  sendMode,
  stateLabel,
  stepsLabel,
} from '../src/lib/format';

const norm = (s: string | null) => (s ?? "").replace(/[  ]/g, ' ');
const NOW = new Date('2026-10-28T10:00:00Z');

describe('format', () => {
  it('montants en euros à la française, signe compris', () => {
    expect(norm(formatMoney(128400, 'EUR'))).toBe('1 284,00 €');
    expect(norm(formatMoney(-500, 'EUR'))).toBe('-5,00 €');
    expect(norm(formatMoney(2900, 'USD'))).toContain('29,00');
  });

  it('pourcentages et variations', () => {
    expect(norm(formatPercent(0.68))).toBe('68 %');
    expect(norm(formatPercent(null))).toBe('Aucun');
    expect(norm(formatVariation(0.18))).toBe('+18 %');
    expect(norm(formatVariation(-0.125))).toBe('−13 %');
    expect(norm(formatVariation(0))).toBe('0 %');
    expect(formatVariation(null)).toBeNull();
  });

  it('dates dans le fuseau du tenant', () => {
    expect(formatShortDate(new Date('2026-10-27T23:30:00Z'), 'Europe/Paris')).toBe('28 oct.');
    expect(norm(formatDateTime(new Date('2026-10-29T07:00:00Z'), 'Europe/Paris'))).toBe('29 oct., 08:00');
  });

  it('mois en toutes lettres', () => {
    expect(monthLabel(2026, 10)).toBe('octobre 2026');
    expect(monthLabel(2026, 1)).toBe('janvier 2026');
  });

  it('dates relatives en français', () => {
    expect(relativeFromNow(new Date('2026-10-17T10:00:00Z'), NOW)).toBe('il y a 11 jours');
    expect(relativeFromNow(new Date('2026-10-28T08:00:00Z'), NOW)).toBe('il y a 2 heures');
    expect(relativeFromNow(new Date('2026-10-28T09:30:00Z'), NOW)).toBe('il y a 30 minutes');
    expect(relativeFromNow(new Date('2026-11-01T10:00:00Z'), NOW)).toBe('dans 4 jours');
    expect(relativeFromNow(new Date('2026-10-29T10:00:00Z'), NOW)).toBe('demain');
    expect(relativeFromNow(new Date('2026-10-28T10:00:00Z'), NOW)).toBe('à l’instant');
  });

  it('progression des relances', () => {
    expect(stepsLabel(3, 4)).toBe('3 sur 4');
    expect(stepsLabel(0, 4)).toBe('Aucun email envoyé');
    expect(stepsLabel(0, 0)).toBe('Aucune relance prévue');
  });

  it('états et motifs lisibles', () => {
    expect(stateLabel('RECOVERING')).toEqual({ label: 'En relance', tone: 'neutral' });
    expect(stateLabel('PAUSED')).toEqual({ label: 'En pause', tone: 'neutral' });
    expect(stateLabel('RECOVERED', 'ASSISTED')).toEqual({ label: 'Récupéré', tone: 'success' });
    expect(stateLabel('RECOVERED', 'NATURAL')).toEqual({ label: 'Payé sans relance (non compté)', tone: 'neutral' });
    expect(stateLabel('RECOVERED', null)).toEqual({ label: 'Payé (non compté)', tone: 'neutral' });
    expect(stateLabel('RECOVERED')).toEqual({ label: 'Payé (non compté)', tone: 'neutral' });
    expect(stateLabel('LOST')).toEqual({ label: 'Perdu', tone: 'danger' });
    expect(stateLabel('OPEN')).toEqual({ label: 'À vérifier', tone: 'warning' });
    expect(failureLabel('insufficient_funds')).toBe('Fonds insuffisants');
    expect(failureLabel('expired_card')).toBe('Carte expirée');
    expect(failureLabel('autre_chose')).toBe('Paiement refusé');
    expect(failureLabel(null)).toBe('Paiement refusé');
  });

  it('badge d’un dossier : dernier avis imminent en ambre', () => {
    const base = { state: 'RECOVERING', stepsSent: 3, stepsTotal: 4, nextDueAt: new Date('2026-10-29T07:00:00Z') };
    expect(caseBadge(base, NOW)).toEqual({ label: 'Dernier avis demain', tone: 'warning' });
    expect(caseBadge({ ...base, stepsSent: 1, nextDueAt: new Date('2026-10-29T07:00:00Z') }, NOW)).toEqual({ label: 'En relance', tone: 'neutral' });
    expect(caseBadge({ ...base, nextDueAt: new Date('2026-11-05T07:00:00Z') }, NOW)).toEqual({ label: 'En relance', tone: 'neutral' });
    expect(caseBadge({ ...base, state: 'PAUSED' }, NOW)).toEqual({ label: 'En pause', tone: 'neutral' });
  });

  it('libellés de la chronologie', () => {
    expect(actionLabel('case.opened', {})).toBe('Échec de paiement détecté');
    expect(actionLabel('email.sent', { stepIndex: 2 })).toBe('Email 3 envoyé');
    expect(actionLabel('email.dry_run', { stepIndex: 0 })).toBe('Email 1 simulé (mode test)');
    expect(actionLabel('retry.failed', { errorCode: 'insufficient_funds' })).toBe('Nouvelle tentative de paiement refusée : fonds insuffisants');
    expect(actionLabel('retry.paid', {})).toBe('Nouvelle tentative de paiement envoyée');
    expect(actionLabel('case.recovered', {}, 'ASSISTED')).toBe('Paiement récupéré');
    expect(actionLabel('case.recovered', {}, 'NATURAL')).toBe('Payé sans relance (non compté)');
    expect(actionLabel('case.recovered', {}, null)).toBe('Facture payée (aucun revenu compté)');
    expect(actionLabel('ledger.recorded', { attribution: 'NATURAL' })).toBe('Paiement enregistré, non compté dans le revenu récupéré');
    expect(actionLabel('ledger.recorded', { attribution: 'ASSISTED' })).toBe('Revenu récupéré enregistré');
    expect(actionLabel('case.paid_after_close', { attribution: 'ASSISTED' })).toBe('Facture payée après la clôture du dossier (revenu récupéré enregistré)');
    expect(actionLabel('case.paid_after_close', { attribution: 'NATURAL' })).toBe('Facture payée après la clôture du dossier (non comptée)');
    expect(actionLabel('case.paused', {})).toBe('Dossier mis en pause');
    expect(actionLabel('case.closed_manual', { reason: 'Client contacté' })).toBe('Dossier clôturé manuellement : Client contacté');
    expect(actionLabel('truc.inconnu', {})).toBe('truc.inconnu');
  });
});

describe('libellés des actions ajoutées par le moteur', () => {
  it.each([
    ['email.deferred', { stepIndex: 1 }, 'Email 2 repoussé : un autre email est parti il y a moins de 12 h'],
    ['email.retry_scheduled', { stepIndex: 0 }, 'Email 1 : nouvel essai d’envoi planifié'],
    ['steps.rescheduled', {}, 'Relances replanifiées après la reconnexion de Stripe'],
    ['case.failure_ignored', {}, 'Nouvel échec ignoré : le dossier est déjà clos'],
    ['paid.ignored_stale', {}, 'Paiement ignoré : la facture a changé depuis'],
  ])('%s', (action, d, label) => {
    expect(actionLabel(action, d as Record<string, unknown>)).toBe(label);
  });
});

describe('sendMode', () => {
  it('relances actives seulement si ni le mode test ni la désactivation des emails ne s’appliquent', () => {
    expect(sendMode({ dryRun: false, emailsEnabled: true })).toMatchObject({ key: 'live', label: 'Relances actives', tone: 'success' });
  });
  it('mode test', () => {
    expect(sendMode({ dryRun: true, emailsEnabled: true })).toMatchObject({ key: 'test', label: 'Mode test', tone: 'warning' });
  });
  it('emails désactivés : jamais « Relances actives », libellé honnête sur les relances perdues', () => {
    const m = sendMode({ dryRun: false, emailsEnabled: false });
    expect(m).toMatchObject({ key: 'disabled', label: 'Emails désactivés', tone: 'danger' });
    expect(m.text).toContain('abandonnées, pas reportées');
    expect(m.label).not.toContain('actives');
    expect(sendMode({ dryRun: true, emailsEnabled: false }).key).toBe('disabled');
  });
});

describe('invoiceChip', () => {
  it('reflète l’état réel du dossier', () => {
    expect(invoiceChip('RECOVERED')).toEqual({ label: 'Payée', tone: 'success' });
    expect(invoiceChip('RECOVERING').label).toBe('Impayée');
    expect(invoiceChip('PAUSED').label).toBe('Impayée');
    expect(invoiceChip('LOST').label).toBe('Impayée, relances terminées');
    expect(invoiceChip('CANCELED').label).toBe('Annulée');
    expect(invoiceChip('CLOSED_MANUAL').label).toBe('Clôturée à la main');
  });
});
