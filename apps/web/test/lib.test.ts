import { describe, expect, it } from 'vitest';
import { parseAmountInput } from '../src/lib/amount';
import { parsePeriod, variationNote } from '../src/lib/period';
import { templateDraft } from '../src/lib/drafts';
import { decodeFlash, encodeFlash } from '../src/lib/flash';
import { normalizeCurrency } from '../src/lib/amount';

describe('parseAmountInput', () => {
  it.each([
    ['12,5', 1250],
    ['12.5', 1250],
    [' 1 250,00 ', 125000],
    ['0', 0],
    ['29', 2900],
  ])('%s -> %s centimes', (raw, cents) => {
    expect(parseAmountInput(raw)).toEqual({ ok: true, cents });
  });
  it('vide : pas de filtre', () => {
    expect(parseAmountInput('')).toEqual({ ok: true, cents: undefined });
    expect(parseAmountInput(undefined)).toEqual({ ok: true, cents: undefined });
  });
  it.each(['abc', '12,5,3', '-5', '1e3', 'Infinity'])('%s : valeur refusée', (raw) => {
    expect(parseAmountInput(raw)).toEqual({ ok: false });
  });
});

describe('parsePeriod', () => {
  const now = { y: 2026, m: 10 };
  it('défaut : mois courant', () => {
    expect(parsePeriod({}, now)).toEqual({ year: 2026, month: 10 });
  });
  it('année et mois valides', () => {
    expect(parsePeriod({ year: '2025', month: '3' }, now)).toEqual({ year: 2025, month: 3 });
  });
  it.each(['1999', '2101', '99999', 'abc', '2025.5', ''])('année %s hors bornes ou invalide : année courante', (y) => {
    expect(parsePeriod({ year: y, month: '3' }, now)).toEqual({ year: 2026, month: 3 });
  });
  it('mois invalide : mois courant', () => {
    expect(parsePeriod({ month: '13' }, now).month).toBe(10);
    expect(parsePeriod({ month: '0' }, now).month).toBe(10);
  });
  it('les bornes 2000 et 2100 sont acceptées', () => {
    expect(parsePeriod({ year: '2000' }, now).year).toBe(2000);
    expect(parsePeriod({ year: '2100' }, now).year).toBe(2100);
  });
});

describe('variationNote', () => {
  it('sans variation', () => {
    expect(variationNote(null, false)).toBe('Pas de mois précédent à comparer');
  });
  it('mois terminé : comparaison simple', () => {
    expect(variationNote(0.12, false)).toBe('+12 % par rapport au mois précédent');
  });
  it('mois en cours : précise que le mois n’est pas terminé', () => {
    const n = variationNote(-0.5, true);
    expect(n).toContain('−50 %');
    expect(n).toContain('mois en cours');
    expect(n).toContain('mois précédent complet');
  });
});

describe('templateDraft', () => {
  const t = { stepIndex: 2, subject: 'Objet', body: 'Corps' };
  const flash = (step: number) => ({ path: '/app/emails', draft: { step, locale: 'fr' as const, subject: 'Mon objet', body: 'Mon texte' } });
  it('sans flash : le modèle enregistré', () => {
    expect(templateDraft(null, t)).toEqual({ subject: 'Objet', body: 'Corps' });
  });
  it('brouillon pour cette étape : texte saisi conservé', () => {
    expect(templateDraft(flash(2), t)).toEqual({ subject: 'Mon objet', body: 'Mon texte' });
  });
  it('brouillon d’une autre étape : ignoré', () => {
    expect(templateDraft(flash(1), t)).toEqual({ subject: 'Objet', body: 'Corps' });
  });
});

describe('flash cookie', () => {
  it('aller-retour : erreur et brouillon', () => {
    const f = { path: '/app/emails', error: 'Lien manquant', draft: { step: 1, locale: 'en' as const, subject: 'S', body: 'B é' } };
    expect(decodeFlash(encodeFlash(f), '/app/emails')).toEqual(f);
  });
  it('destiné à une autre page : ignoré', () => {
    expect(decodeFlash(encodeFlash({ path: '/app/emails', error: 'x' }), '/app/settings')).toBeNull();
  });
  it('absent, malformé ou non-objet : null', () => {
    for (const raw of [undefined, null, '', 'zzz', '[]', '"x"', 'null']) {
      expect(decodeFlash(raw, '/app/emails')).toBeNull();
    }
  });
  it('tient dans un cookie (< 4096 o) même avec du texte accentué volumineux', () => {
    const f = { path: '/app/emails', error: 'e'.repeat(1000), draft: { step: 0, locale: 'fr' as const, subject: 'é'.repeat(900), body: 'é'.repeat(5000) } };
    const raw = encodeFlash(f);
    expect(encodeURIComponent(raw).length).toBeLessThan(4000);
    const back = decodeFlash(raw, '/app/emails')!;
    expect(back.error!.length).toBe(300);
    expect(back.draft!.body.length).toBeGreaterThan(0);
  });
});

describe('normalizeCurrency', () => {
  it.each([
    ['usd', 'USD'],
    [' eur ', 'EUR'],
    ['GBP', 'GBP'],
    ['', undefined],
    [undefined, undefined],
    ['us', undefined],
    ['euro', undefined],
    ["E'R", undefined],
    ['€€€', undefined],
  ])('%j -> %j', (raw, want) => {
    expect(normalizeCurrency(raw)).toBe(want);
  });
});
