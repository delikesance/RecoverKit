import { describe, expect, it } from 'vitest';
import { CALCULATOR_DEFAULTS, estimateRecovery } from '../src/calculator';

describe('estimateRecovery', () => {
  it('calcule la perte, le récupérable mensuel et annuel', () => {
    expect(estimateRecovery({ mrr: 20000, failRate: 6, recoveryRate: 50 })).toEqual({ lostPerMonth: 1200, recoveredPerMonth: 600, recoveredPerYear: 7200 });
  });

  it('arrondit à l’euro', () => {
    expect(estimateRecovery({ mrr: 12345, failRate: 7, recoveryRate: 55 })).toEqual({ lostPerMonth: 864, recoveredPerMonth: 475, recoveredPerYear: 5700 });
  });

  it('renvoie zéro sans revenu, sans échec ou sans récupération', () => {
    expect(estimateRecovery({ mrr: 0, failRate: 6, recoveryRate: 50 }).recoveredPerYear).toBe(0);
    expect(estimateRecovery({ mrr: 20000, failRate: 0, recoveryRate: 50 }).recoveredPerYear).toBe(0);
    expect(estimateRecovery({ mrr: 20000, failRate: 6, recoveryRate: 0 }).recoveredPerYear).toBe(0);
  });

  it('borne les entrées : jamais négatif, pourcentages entre 0 et 100', () => {
    expect(estimateRecovery({ mrr: -500, failRate: 6, recoveryRate: 50 }).lostPerMonth).toBe(0);
    expect(estimateRecovery({ mrr: 1000, failRate: 250, recoveryRate: 150 })).toEqual({ lostPerMonth: 1000, recoveredPerMonth: 1000, recoveredPerYear: 12000 });
    expect(estimateRecovery({ mrr: 1000, failRate: -5, recoveryRate: 50 }).lostPerMonth).toBe(0);
    expect(estimateRecovery({ mrr: Number.NaN, failRate: 6, recoveryRate: 50 }).lostPerMonth).toBe(0);
  });

  it('expose des valeurs par défaut prudentes et cohérentes avec les curseurs', () => {
    expect(CALCULATOR_DEFAULTS).toEqual({ mrr: 20000, failRate: 6, recoveryRate: 50 });
  });
});
