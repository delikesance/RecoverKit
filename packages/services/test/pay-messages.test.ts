import { describe, expect, it } from 'vitest';
import { cardErrorMessage, payMessage, type PayMessageKey } from '../src/payments/messages';

const KEYS: PayMessageKey[] = ['form', 'unavailable', 'paid', 'requires_action', 'setup_incomplete', 'error', 'rate_limited', 'dry_run', 'success'];

describe('messages de la page de paiement', () => {
  it.each(KEYS)('%s existe en FR et EN, avec titre et texte', (key) => {
    for (const locale of ['fr', 'en'] as const) {
      const m = payMessage(key, locale);
      expect(m.title.length).toBeGreaterThan(5);
      expect(m.body.length).toBeGreaterThan(10);
    }
    expect(payMessage(key, 'fr').title).not.toBe(payMessage(key, 'en').title);
  });

  it('chaque état a un message distinct (pas d’erreur vague)', () => {
    const titles = KEYS.map((k) => payMessage(k, 'fr').title);
    expect(new Set(titles).size).toBe(titles.length);
  });

  it('les erreurs de carte disent quoi faire, selon le motif', () => {
    const codes = ['insufficient_funds', 'expired_card', 'incorrect_cvc', 'card_declined', 'processing_error'];
    const msgs = codes.map((c) => cardErrorMessage(c, 'fr'));
    expect(new Set(msgs).size).toBe(codes.length);
    expect(cardErrorMessage('expired_card', 'fr').toLowerCase()).toContain('expir');
    expect(cardErrorMessage('insufficient_funds', 'en').toLowerCase()).toContain('funds');
  });

  it('un motif inconnu retombe sur un message générique utile', () => {
    expect(cardErrorMessage('motif_inconnu', 'fr')).toBe(cardErrorMessage('card_declined', 'fr'));
    expect(cardErrorMessage('motif_inconnu', 'fr').toLowerCase()).toContain('autre carte');
  });

  it('les messages n’exposent aucun détail technique', () => {
    for (const k of KEYS) {
      for (const l of ['fr', 'en'] as const) {
        const m = payMessage(k, l);
        expect(`${m.title} ${m.body}`).not.toMatch(/stripe_|acct_|sk_|exception|stack/i);
      }
    }
  });
});
