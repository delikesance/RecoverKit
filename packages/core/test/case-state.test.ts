import { describe, expect, it } from 'vitest';
import {
  CASE_STATES,
  CASE_EVENTS,
  InvalidTransition,
  decidePaymentFailed,
  isTerminal,
  transitionCase,
  type CaseEvent,
  type CaseState,
} from '../src/case-state';

describe('transitionCase', () => {
  it.each<[CaseState, CaseEvent, CaseState]>([
    ['OPEN', 'SEQUENCE_SCHEDULED', 'RECOVERING'],
    ['RECOVERING', 'PAID', 'RECOVERED'],
    ['RECOVERING', 'INVOICE_VOIDED', 'CANCELED'],
    ['RECOVERING', 'SUBSCRIPTION_CANCELED', 'CANCELED'],
    ['RECOVERING', 'SEQUENCE_EXHAUSTED', 'LOST'],
    ['RECOVERING', 'PAUSE', 'PAUSED'],
    ['PAUSED', 'RESUME', 'RECOVERING'],
    ['PAUSED', 'PAID', 'RECOVERED'],
    ['PAUSED', 'INVOICE_VOIDED', 'CANCELED'],
    ['PAUSED', 'SUBSCRIPTION_CANCELED', 'CANCELED'],
    ['OPEN', 'PAID', 'RECOVERED'],
    ['OPEN', 'INVOICE_VOIDED', 'CANCELED'],
    ['OPEN', 'SUBSCRIPTION_CANCELED', 'CANCELED'],
    ['OPEN', 'CLOSE_MANUAL', 'CLOSED_MANUAL'],
    ['RECOVERING', 'CLOSE_MANUAL', 'CLOSED_MANUAL'],
    ['PAUSED', 'CLOSE_MANUAL', 'CLOSED_MANUAL'],
  ])('%s + %s → %s', (from, event, to) => {
    expect(transitionCase(from, event)).toBe(to);
  });

  it('les états terminaux sont immuables pour tout événement', () => {
    const terminals = CASE_STATES.filter(isTerminal);
    expect(terminals.sort()).toEqual(['CANCELED', 'CLOSED_MANUAL', 'LOST', 'RECOVERED']);
    for (const state of terminals) {
      for (const event of CASE_EVENTS) {
        expect(() => transitionCase(state, event)).toThrow(InvalidTransition);
      }
    }
  });

  it('refuse les transitions invalides des états actifs', () => {
    expect(() => transitionCase('OPEN', 'PAUSE')).toThrow(InvalidTransition);
    expect(() => transitionCase('OPEN', 'RESUME')).toThrow(InvalidTransition);
    expect(() => transitionCase('RECOVERING', 'RESUME')).toThrow(InvalidTransition);
    expect(() => transitionCase('PAUSED', 'SEQUENCE_EXHAUSTED')).toThrow(InvalidTransition);
    expect(() => transitionCase('RECOVERING', 'SEQUENCE_SCHEDULED')).toThrow(InvalidTransition);
  });

  it("l'erreur décrit la transition refusée", () => {
    try {
      transitionCase('RECOVERED', 'PAID');
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(InvalidTransition);
      expect((e as Error).message).toContain('RECOVERED');
      expect((e as Error).message).toContain('PAID');
    }
  });
});

describe('decidePaymentFailed', () => {
  it('crée un dossier quand la facture est inconnue', () => {
    expect(decidePaymentFailed(null)).toBe('CREATE');
  });

  it("incrémente la tentative quand le dossier est actif", () => {
    for (const state of ['OPEN', 'RECOVERING', 'PAUSED'] as const) {
      expect(decidePaymentFailed(state)).toBe('INCREMENT');
    }
  });

  it('ne rouvre jamais un dossier terminal', () => {
    for (const state of ['RECOVERED', 'CANCELED', 'LOST', 'CLOSED_MANUAL'] as const) {
      expect(decidePaymentFailed(state)).toBe('IGNORE');
    }
  });
});
