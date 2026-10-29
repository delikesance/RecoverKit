import { beforeEach, describe, expect, it, vi } from 'vitest';

const svc = vi.hoisted(() => ({
  closeExhaustedCases: vi.fn(async () => 'close-exhausted'),
  computeTenantMrr: vi.fn(async () => 'mrr'),
  enforceBilling: vi.fn(async () => 'billing-enforce'),
  notifyFounderAlerts: vi.fn(async () => 'founder-alerts'),
  processInbox: vi.fn(async () => 'inbox'),
  purgeRetention: vi.fn(async () => 'retention'),
  reconcileAll: vi.fn(async () => 'reconcile'),
  runDueSteps: vi.fn(async () => 'send-steps'),
  runPreFinalRetries: vi.fn(async () => 'pre-final-retries'),
  runWeeklyDigests: vi.fn(async () => 'digests'),
}));
const dbMock = vi.hoisted(() => ({ purgeRateLimits: vi.fn(async () => 'rate-limits') }));
vi.mock('@recoverkit/services', () => svc);
vi.mock('@recoverkit/db', () => dbMock);

import { buildTasks } from '../src/tasks';

const now = new Date('2026-10-28T10:00:00Z');
function makeDeps() {
  return {
    pool: { query: vi.fn(async () => ({ rows: [{ tenant_id: 't1' }, { tenant_id: 't2' }] })) },
    clock: { now: () => now },
    log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
  } as any;
}

beforeEach(() => vi.clearAllMocks());

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

  // chaque tâche appelle son service, et lui seul, avec les deps
  const wiring: [string, keyof typeof svc][] = [
    ['inbox', 'processInbox'],
    ['send-steps', 'runDueSteps'],
    ['close-exhausted', 'closeExhaustedCases'],
    ['pre-final-retries', 'runPreFinalRetries'],
    ['reconcile', 'reconcileAll'],
    ['digests', 'runWeeklyDigests'],
    ['founder-alerts', 'notifyFounderAlerts'],
    ['billing-enforce', 'enforceBilling'],
    ['retention', 'purgeRetention'],
  ];
  it.each(wiring)('la tâche %s appelle %s avec les dépendances', async (name, fn) => {
    const deps = makeDeps();
    const task = buildTasks(deps).find((t) => t.name === name)!;
    await task.run();
    expect(svc[fn]).toHaveBeenCalledTimes(1);
    expect(svc[fn]).toHaveBeenCalledWith(deps);
    for (const other of Object.keys(svc) as (keyof typeof svc)[]) {
      if (other !== fn) expect(svc[other], `${name} ne doit pas appeler ${other}`).not.toHaveBeenCalled();
    }
    expect(dbMock.purgeRateLimits).not.toHaveBeenCalled();
  });

  it('rate-limits purge les limites avec le pool et l’horloge', async () => {
    const deps = makeDeps();
    await buildTasks(deps).find((t) => t.name === 'rate-limits')!.run();
    expect(dbMock.purgeRateLimits).toHaveBeenCalledWith(deps.pool, now);
    for (const f of Object.values(svc)) expect(f).not.toHaveBeenCalled();
  });

  it('billing-mrr calcule le MRR de chaque tenant connecté et survit à l’échec de l’un', async () => {
    const deps = makeDeps();
    svc.computeTenantMrr.mockRejectedValueOnce(new Error('boum'));
    await buildTasks(deps).find((t) => t.name === 'billing-mrr')!.run();
    expect(deps.pool.query).toHaveBeenCalledWith(expect.stringContaining("status = 'ACTIVE'"));
    expect(svc.computeTenantMrr.mock.calls.map((c: any[]) => c[1])).toEqual(['t1', 't2']);
    expect(svc.computeTenantMrr).toHaveBeenCalledWith(deps, 't1');
    expect(deps.log.warn).toHaveBeenCalledTimes(1);
  });
});
