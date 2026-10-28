import { describe, expect, it } from 'vitest';
import { buildTasks } from '../src/tasks';

describe('buildTasks', () => {
  it('déclare toutes les tâches d’exploitation avec des intervalles raisonnables', () => {
    const tasks = buildTasks({} as any);
    const names = tasks.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'inbox', 'send-steps', 'close-exhausted', 'pre-final-retries', 'reconcile', 'digests',
        'founder-alerts', 'billing-enforce', 'billing-mrr', 'retention', 'rate-limits',
      ]),
    );
    expect(new Set(names).size).toBe(names.length);
    const byName = Object.fromEntries(tasks.map((t) => [t.name, t.everyMs]));
    expect(byName.inbox).toBeLessThanOrEqual(10_000); // les webhooks sont traités vite
    expect(byName['send-steps']).toBeLessThanOrEqual(60_000);
    expect(byName.reconcile).toBeGreaterThanOrEqual(6 * 3600_000); // quotidien, pas en continu
  });
});
