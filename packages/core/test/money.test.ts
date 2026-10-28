import { describe, expect, it } from 'vitest';
import { Money } from '../src/money';

describe('Money', () => {
  it('refuse les montants décimaux', () => {
    expect(() => Money.of(10.5, 'EUR')).toThrow(/entier/);
  });

  it('refuse les devises invalides', () => {
    expect(() => Money.of(100, 'eur')).toThrow(/devise/);
    expect(() => Money.of(100, 'EU')).toThrow(/devise/);
  });

  it('additionne et soustrait dans la même devise', () => {
    const a = Money.of(7900, 'EUR');
    const b = Money.of(2900, 'EUR');
    expect(a.add(b).amount).toBe(10800);
    expect(a.sub(b).amount).toBe(5000);
  });

  it('refuse de mélanger les devises', () => {
    expect(() => Money.of(100, 'EUR').add(Money.of(100, 'USD'))).toThrow(/devises/);
    expect(() => Money.of(100, 'EUR').sub(Money.of(100, 'USD'))).toThrow(/devises/);
  });

  it('formate en fr-FR', () => {
    const text = Money.of(128400, 'EUR').format('fr-FR').replace(/\s/g, ' ');
    expect(text).toBe('1 284,00 €');
  });

  it('formate une devise sans décimales (JPY)', () => {
    const text = Money.of(1500, 'JPY').format('fr-FR').replace(/\s/g, ' ');
    expect(text).toContain('1 500');
  });

  it('compare et teste le zéro', () => {
    expect(Money.zero('EUR').isZero()).toBe(true);
    expect(Money.of(1, 'EUR').equals(Money.of(1, 'EUR'))).toBe(true);
    expect(Money.of(1, 'EUR').equals(Money.of(1, 'USD'))).toBe(false);
  });
});
