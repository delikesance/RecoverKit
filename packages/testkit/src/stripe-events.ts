import { createHmac, randomUUID } from 'node:crypto';

export interface StripeEventOptions {
  id?: string;
  account?: string | null;
  created?: Date;
  previousAttributes?: Record<string, unknown>;
}

export function stripeEvent(type: string, object: Record<string, unknown>, o: StripeEventOptions = {}) {
  return {
    id: o.id ?? `evt_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
    object: 'event',
    type,
    account: o.account === undefined ? 'acct_test' : o.account,
    created: Math.floor((o.created ?? new Date('2026-10-01T08:00:00Z')).getTime() / 1000),
    livemode: false,
    data: { object, ...(o.previousAttributes ? { previous_attributes: o.previousAttributes } : {}) },
  };
}

export function signStripePayload(body: string, secret: string, timestamp: Date | number): string {
  const t = typeof timestamp === 'number' ? timestamp : Math.floor(timestamp.getTime() / 1000);
  const sig = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  return `t=${t},v1=${sig}`;
}
