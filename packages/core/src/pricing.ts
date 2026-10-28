export interface Recurring {
  amount: number;
  interval: 'day' | 'week' | 'month' | 'year';
  intervalCount?: number;
}

/** Montant mensuel équivalent, en unités mineures (arrondi à l'entier). */
export function monthlyAmount(r: Recurring): number {
  const count = r.intervalCount && r.intervalCount > 0 ? r.intervalCount : 1;
  const perPeriod = r.amount / count;
  switch (r.interval) {
    case 'month':
      return Math.round(perPeriod);
    case 'year':
      return Math.round(perPeriod / 12);
    case 'week':
      return Math.round((perPeriod * 52) / 12);
    case 'day':
      return Math.round(perPeriod * 30);
  }
}

export interface Tier {
  key: string;
  /** Revenu mensuel récurrent maximal du palier (unités mineures), null = illimité. */
  maxMrr: number | null;
}

/** Plus petit palier couvrant le revenu ; `exceeded` si même le plus grand palier fini est dépassé. */
export function planForMrr<T extends Tier>(tiers: readonly T[], mrr: number): { plan: T | null; exceeded: boolean } {
  if (tiers.length === 0) return { plan: null, exceeded: false };
  const sorted = [...tiers].sort((a, b) => (a.maxMrr ?? Infinity) - (b.maxMrr ?? Infinity));
  const fit = sorted.find((t) => t.maxMrr === null || mrr <= t.maxMrr);
  if (fit) return { plan: fit, exceeded: false };
  return { plan: sorted[sorted.length - 1]!, exceeded: true };
}
