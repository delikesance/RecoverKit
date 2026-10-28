export interface CalculatorInput {
  /** Revenu mensuel récurrent, en euros entiers. */
  mrr: number;
  /** Part des paiements qui échouent, en %. */
  failRate: number;
  /** Part des paiements échoués que l'on espère récupérer, en % (hypothèse, pas une promesse). */
  recoveryRate: number;
}

export const CALCULATOR_DEFAULTS: CalculatorInput = { mrr: 20000, failRate: 6, recoveryRate: 50 };

const clamp = (n: number, min: number, max: number) => (Number.isFinite(n) ? Math.min(Math.max(n, min), max) : min);

/** Estimation du revenu récupérable : perte mensuelle, récupérable par mois et par an (euros arrondis). */
export function estimateRecovery(i: CalculatorInput): { lostPerMonth: number; recoveredPerMonth: number; recoveredPerYear: number } {
  const mrr = clamp(i.mrr, 0, Number.MAX_SAFE_INTEGER);
  const lost = (mrr * clamp(i.failRate, 0, 100)) / 100;
  const recovered = (lost * clamp(i.recoveryRate, 0, 100)) / 100;
  const recoveredPerMonth = Math.round(recovered);
  return { lostPerMonth: Math.round(lost), recoveredPerMonth, recoveredPerYear: recoveredPerMonth * 12 };
}
