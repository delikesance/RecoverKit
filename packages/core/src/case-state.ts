export const CASE_STATES = [
  'OPEN',
  'RECOVERING',
  'PAUSED',
  'RECOVERED',
  'CANCELED',
  'LOST',
  'CLOSED_MANUAL',
] as const;
export type CaseState = (typeof CASE_STATES)[number];

export const CASE_EVENTS = [
  'SEQUENCE_SCHEDULED',
  'PAID',
  'INVOICE_VOIDED',
  'SUBSCRIPTION_CANCELED',
  'SEQUENCE_EXHAUSTED',
  'PAUSE',
  'RESUME',
  'CLOSE_MANUAL',
] as const;
export type CaseEvent = (typeof CASE_EVENTS)[number];

const TERMINAL: ReadonlySet<CaseState> = new Set(['RECOVERED', 'CANCELED', 'LOST', 'CLOSED_MANUAL']);

export function isTerminal(state: CaseState): boolean {
  return TERMINAL.has(state);
}

const TRANSITIONS: Partial<Record<CaseState, Partial<Record<CaseEvent, CaseState>>>> = {
  OPEN: {
    SEQUENCE_SCHEDULED: 'RECOVERING',
    PAID: 'RECOVERED',
    INVOICE_VOIDED: 'CANCELED',
    SUBSCRIPTION_CANCELED: 'CANCELED',
    CLOSE_MANUAL: 'CLOSED_MANUAL',
  },
  RECOVERING: {
    PAID: 'RECOVERED',
    INVOICE_VOIDED: 'CANCELED',
    SUBSCRIPTION_CANCELED: 'CANCELED',
    SEQUENCE_EXHAUSTED: 'LOST',
    PAUSE: 'PAUSED',
    CLOSE_MANUAL: 'CLOSED_MANUAL',
  },
  PAUSED: {
    RESUME: 'RECOVERING',
    PAID: 'RECOVERED',
    INVOICE_VOIDED: 'CANCELED',
    SUBSCRIPTION_CANCELED: 'CANCELED',
    CLOSE_MANUAL: 'CLOSED_MANUAL',
  },
};

export class InvalidTransition extends Error {
  constructor(
    readonly from: CaseState,
    readonly event: CaseEvent,
  ) {
    super(`Transition invalide : ${from} + ${event}`);
    this.name = 'InvalidTransition';
  }
}

export function transitionCase(from: CaseState, event: CaseEvent): CaseState {
  const to = TRANSITIONS[from]?.[event];
  if (!to) throw new InvalidTransition(from, event);
  return to;
}

export type PaymentFailedDecision = 'CREATE' | 'INCREMENT' | 'IGNORE';

/** Que faire quand un nouvel invoice.payment_failed arrive pour une facture ? */
export function decidePaymentFailed(existing: CaseState | null): PaymentFailedDecision {
  if (existing === null) return 'CREATE';
  return isTerminal(existing) ? 'IGNORE' : 'INCREMENT';
}
