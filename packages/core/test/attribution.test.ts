import { describe, expect, it } from 'vitest';
import {
  attribute,
  buildRecoveryEntry,
  buildRefundAdjustment,
  recoveryRate,
  summarizeLedger,
  type EmailRecord,
  type LedgerEntry,
} from '../src/attribution';
import { Money } from '../src/money';

const paidAt = new Date('2026-10-10T12:00:00Z');
const email = (sentAt: string, status: EmailRecord['status'] = 'SENT'): EmailRecord => ({
  sentAt: new Date(sentAt),
  status,
});

describe('attribute', () => {
  it('ASSISTED quand un email envoyé précède le paiement', () => {
    expect(attribute({ paidAt, emails: [email('2026-10-09T09:00:00Z')], linkUsedAt: null })).toBe('ASSISTED');
  });

  it("NATURAL quand aucun email n'a été envoyé avant le paiement", () => {
    expect(attribute({ paidAt, emails: [], linkUsedAt: null })).toBe('NATURAL');
    expect(attribute({ paidAt, emails: [email('2026-10-11T09:00:00Z')], linkUsedAt: null })).toBe('NATURAL');
  });

  it("un email envoyé à la même seconde que le paiement ne compte pas (strictement avant)", () => {
    expect(attribute({ paidAt, emails: [email('2026-10-10T12:00:00Z')], linkUsedAt: null })).toBe('NATURAL');
  });

  it('les emails FAILED, SKIPPED ou DRY_RUN ne comptent pas', () => {
    for (const status of ['FAILED', 'SKIPPED', 'DRY_RUN'] as const) {
      expect(attribute({ paidAt, emails: [email('2026-10-09T09:00:00Z', status)], linkUsedAt: null })).toBe('NATURAL');
    }
  });

  it('ASSISTED quand le lien de paiement a été utilisé (même sans email réussi)', () => {
    expect(attribute({ paidAt, emails: [], linkUsedAt: new Date('2026-10-10T11:59:00Z') })).toBe('ASSISTED');
    expect(attribute({ paidAt, emails: [], linkUsedAt: paidAt })).toBe('ASSISTED');
  });

  it("un lien utilisé après le paiement ne compte pas", () => {
    expect(attribute({ paidAt, emails: [], linkUsedAt: new Date('2026-10-10T12:00:01Z') })).toBe('NATURAL');
  });
});

describe('buildRecoveryEntry', () => {
  it('utilise amount_paid de la facture, jamais le montant dû', () => {
    const entry = buildRecoveryEntry({
      caseId: 'c1',
      invoiceId: 'in_1',
      amountPaid: 7900,
      amountDue: 9900,
      currency: 'EUR',
      paidAt,
      attribution: 'ASSISTED',
    });
    expect(entry.kind).toBe('RECOVERY');
    expect(entry.amount.equals(Money.of(7900, 'EUR'))).toBe(true);
  });

  it("refuse un montant payé nul ou négatif", () => {
    const base = { caseId: 'c1', invoiceId: 'in_1', amountDue: 100, currency: 'EUR', paidAt, attribution: 'ASSISTED' as const };
    expect(() => buildRecoveryEntry({ ...base, amountPaid: 0 })).toThrow(/positif/);
    expect(() => buildRecoveryEntry({ ...base, amountPaid: -5 })).toThrow(/positif/);
  });
});

describe('buildRefundAdjustment', () => {
  it('produit une ligne négative reprenant l’attribution d’origine', () => {
    const original = buildRecoveryEntry({
      caseId: 'c1', invoiceId: 'in_1', amountPaid: 7900, amountDue: 7900, currency: 'EUR', paidAt, attribution: 'ASSISTED',
    });
    const adj = buildRefundAdjustment({ original, refunded: 2000, occurredAt: new Date('2026-10-20T00:00:00Z') });
    expect(adj.kind).toBe('ADJUSTMENT');
    expect(adj.amount.amount).toBe(-2000);
    expect(adj.attribution).toBe('ASSISTED');
    expect(adj.caseId).toBe('c1');
  });

  it('refuse un remboursement supérieur au montant récupéré', () => {
    const original = buildRecoveryEntry({
      caseId: 'c1', invoiceId: 'in_1', amountPaid: 1000, amountDue: 1000, currency: 'EUR', paidAt, attribution: 'ASSISTED',
    });
    expect(() => buildRefundAdjustment({ original, refunded: 1001, occurredAt: paidAt })).toThrow(/supérieur/);
    expect(() => buildRefundAdjustment({ original, refunded: 0, occurredAt: paidAt })).toThrow(/positif/);
  });
});

describe('summarizeLedger', () => {
  const mk = (
    caseId: string,
    amount: number,
    at: string,
    attribution: LedgerEntry['attribution'],
    kind: LedgerEntry['kind'] = 'RECOVERY',
    currency = 'EUR',
  ): LedgerEntry => ({
    caseId,
    invoiceId: `in_${caseId}`,
    kind,
    attribution,
    amount: Money.of(amount, currency),
    occurredAt: new Date(at),
  });

  const month = { year: 2026, month: 10, timeZone: 'Europe/Paris' };

  it('somme ASSISTED séparément de NATURAL, par devise, sans conversion', () => {
    const out = summarizeLedger(
      [
        mk('a', 7900, '2026-10-05T10:00:00Z', 'ASSISTED'),
        mk('b', 2900, '2026-10-06T10:00:00Z', 'ASSISTED'),
        mk('c', 3100, '2026-10-07T10:00:00Z', 'NATURAL'),
        mk('d', 5000, '2026-10-08T10:00:00Z', 'ASSISTED', 'RECOVERY', 'USD'),
      ],
      month,
    );
    expect(out.get('EUR')).toMatchObject({ recovered: 10800, natural: 3100, savedCustomers: 2 });
    expect(out.get('USD')).toMatchObject({ recovered: 5000, natural: 0, savedCustomers: 1 });
  });

  it('le revenu récupéré ne contient jamais le NATURAL', () => {
    const out = summarizeLedger([mk('c', 3100, '2026-10-07T10:00:00Z', 'NATURAL')], month);
    expect(out.get('EUR')).toMatchObject({ recovered: 0, natural: 3100, savedCustomers: 0 });
  });

  it('les ajustements réduisent le montant sans changer le nombre de clients', () => {
    const out = summarizeLedger(
      [mk('a', 7900, '2026-10-05T10:00:00Z', 'ASSISTED'), mk('a', -2000, '2026-10-12T10:00:00Z', 'ASSISTED', 'ADJUSTMENT')],
      month,
    );
    expect(out.get('EUR')).toMatchObject({ recovered: 5900, savedCustomers: 1 });
  });

  it('découpe le mois calendaire dans le fuseau du tenant', () => {
    const out = summarizeLedger(
      [
        mk('in', 1000, '2026-09-30T22:30:00Z', 'ASSISTED'), // 1er oct. 00:30 Paris → inclus
        mk('out', 2000, '2026-10-31T23:30:00Z', 'ASSISTED'), // 1er nov. 00:30 Paris → exclu
        mk('prev', 4000, '2026-09-30T21:30:00Z', 'ASSISTED'), // 30 sept. 23:30 Paris → exclu
      ],
      month,
    );
    expect(out.get('EUR')).toMatchObject({ recovered: 1000, savedCustomers: 1 });
  });

  it('renvoie une map vide quand il n’y a aucune donnée', () => {
    expect(summarizeLedger([], month).size).toBe(0);
  });
});

describe('recoveryRate', () => {
  it('= récupérés / (récupérés + perdus), annulés exclus', () => {
    const r = recoveryRate({ recovered: 14, lost: 7, recoveredAmount: 128400, lostAmount: 60000 });
    expect(r.byCount).toBeCloseTo(14 / 21);
    expect(r.byAmount).toBeCloseTo(128400 / 188400);
  });

  it('renvoie null quand il n’y a aucun dossier clos', () => {
    expect(recoveryRate({ recovered: 0, lost: 0, recoveredAmount: 0, lostAmount: 0 })).toEqual({
      byCount: null,
      byAmount: null,
    });
  });
});
