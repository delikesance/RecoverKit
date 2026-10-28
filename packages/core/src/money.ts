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
    const digits = formatter.resolvedOptions().maximumFractionDigits ?? 2;
    return formatter.format(this.amount / 10 ** digits);
  }

  private assertSameCurrency(other: Money): void {
    if (other.currency !== this.currency) {
      throw new Error(`Impossible de mélanger les devises ${this.currency} et ${other.currency}`);
    }
  }
}
