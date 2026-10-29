/** Devises que Stripe compte en centièmes alors que la norme ISO 4217 (donc Intl) leur donne 0 décimale. */
const STRIPE_TWO_DECIMAL_EXCEPTIONS = new Set(['ISK', 'UGX']);

/** Décimales des unités mineures telles que Stripe les renvoie (JPY=0, USD=2, KWD=3, ISK/UGX=2). */
export function currencyDigits(currency: string): number {
  if (STRIPE_TWO_DECIMAL_EXCEPTIONS.has(currency)) return 2;
  return new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
}

export class Money {
  private constructor(
    readonly amount: number,
    readonly currency: string,
  ) {}

  static of(amount: number, currency: string): Money {
    if (!Number.isInteger(amount)) {
      throw new Error(`Le montant doit être un entier en unités mineures (reçu ${amount})`);
    }
    if (!/^[A-Z]{3}$/.test(currency)) {
      throw new Error(`Code devise invalide : ${currency}`);
    }
    return new Money(amount, currency);
  }

  static zero(currency: string): Money {
    return Money.of(0, currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.amount + other.amount, this.currency);
  }

  sub(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.amount - other.amount, this.currency);
  }

  isZero(): boolean {
    return this.amount === 0;
  }

  equals(other: Money): boolean {
    return this.amount === other.amount && this.currency === other.currency;
  }

  format(locale: string): string {
    const formatter = new Intl.NumberFormat(locale, { style: 'currency', currency: this.currency });
    return formatter.format(this.amount / 10 ** currencyDigits(this.currency));
  }

  private assertSameCurrency(other: Money): void {
    if (other.currency !== this.currency) {
      throw new Error(`Impossible de mélanger les devises ${this.currency} et ${other.currency}`);
    }
  }
}
