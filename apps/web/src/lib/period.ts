import { formatVariation } from './format';

/** Mois affiché : année bornée 2000 à 2100 (comme l'export CSV), repli sur le mois courant. */
export function parsePeriod(sp: { year?: string; month?: string }, now: { y: number; m: number }): { year: number; month: number } {
  const y = Number(sp.year);
  const m = Number(sp.month);
  return {
    year: sp.year && Number.isInteger(y) && y >= 2000 && y <= 2100 ? y : now.y,
    month: sp.month && Number.isInteger(m) && m >= 1 && m <= 12 ? m : now.m,
  };
}

/** Note sous le revenu récupéré : un mois en cours n'est pas comparable à un mois complet. */
export function variationNote(variation: number | null, monthInProgress: boolean): string {
  const v = formatVariation(variation);
  if (!v) return 'Pas de mois précédent à comparer';
  return monthInProgress ? `${v} (mois en cours, comparé au mois précédent complet)` : `${v} par rapport au mois précédent`;
}
