import { describe, expect, it } from 'vitest';
import { monthlyAmount, planForMrr } from '../src/pricing';

describe('monthlyAmount', () => {
  it('ramène chaque période à un mois', () => {
    expect(monthlyAmount({ amount: 2900, interval: 'month', intervalCount: 1 })).toBe(2900);
    expect(monthlyAmount({ amount: 29000, interval: 'year', intervalCount: 1 })).toBe(2417); // 29000 / 12 arrondi
    expect(monthlyAmount({ amount: 8700, interval: 'month', intervalCount: 3 })).toBe(2900);
    expect(monthlyAmount({ amount: 700, interval: 'week', intervalCount: 1 })).toBe(3033); // 700 × 52 / 12
    expect(monthlyAmount({ amount: 100, interval: 'day', intervalCount: 1 })).toBe(3000);
  });
  it('retombe sur 1 quand le nombre d’intervalles est absent', () => {
    expect(monthlyAmount({ amount: 2900, interval: 'month' })).toBe(2900);
  });
  it('renvoie 0 pour un montant nul', () => {
    expect(monthlyAmount({ amount: 0, interval: 'month', intervalCount: 1 })).toBe(0);
  });
});

const tiers = [
  { key: 'scale', maxMrr: null },
  { key: 'start', maxMrr: 500_000 },
  { key: 'growth', maxMrr: 2_000_000 },
];

describe('planForMrr', () => {
  it('choisit le plus petit palier qui couvre le revenu', () => {
    expect(planForMrr(tiers, 100_000)).toEqual({ plan: tiers[1], exceeded: false });
    expect(planForMrr(tiers, 500_000)).toEqual({ plan: tiers[1], exceeded: false });
    expect(planForMrr(tiers, 500_001)).toEqual({ plan: tiers[2], exceeded: false });
    expect(planForMrr(tiers, 50_000_000)).toEqual({ plan: tiers[0], exceeded: false });
  });
  it('indique un dépassement quand aucun palier n’est assez grand', () => {
    const finite = [{ key: 'a', maxMrr: 1000 }, { key: 'b', maxMrr: 2000 }];
    expect(planForMrr(finite, 5000)).toEqual({ plan: finite[1], exceeded: true });
  });
  it('renvoie null sans palier', () => {
    expect(planForMrr([], 100)).toEqual({ plan: null, exceeded: false });
  });
});
