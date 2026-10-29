/** Montant saisi par l'utilisateur (virgule ou point, espaces tolérés) en centimes ; undefined si le champ est vide. */
export function parseAmountInput(raw: string | undefined): { ok: true; cents: number | undefined } | { ok: false } {
  const s = (raw ?? '').replace(/[\s  ]/g, '').replace(',', '.');
  if (s === '') return { ok: true, cents: undefined };
  if (!/^\d+(\.\d+)?$/.test(s)) return { ok: false };
  const cents = Math.round(Number(s) * 100);
  return Number.isSafeInteger(cents) ? { ok: true, cents } : { ok: false };
}

/** Code devise issu d'un paramètre d'URL : trim + majuscules, ISO 4217 sur 3 lettres, sinon undefined. */
export function normalizeCurrency(raw: string | undefined | null): string | undefined {
  const c = (raw ?? '').trim().toUpperCase();
  return /^[A-Z]{3}$/.test(c) ? c : undefined;
}
