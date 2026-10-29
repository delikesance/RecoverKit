import { describe, expect, it, vi } from 'vitest';
import { FakeClock } from '@recoverkit/core';
import { Scheduler } from '../src/scheduler';

const silent = { warn() {}, error() {}, info() {} };

describe('Scheduler', () => {
  it('exécute chaque tâche à son intervalle, pas avant', async () => {
    const clock = new FakeClock(new Date('2026-10-28T10:00:00Z'));
    const calls: string[] = [];
    const s = new Scheduler(clock, silent as any);
    s.add({ name: 'rapide', everyMs: 5_000, run: async () => void calls.push('rapide') });
    s.add({ name: 'lente', everyMs: 60_000, run: async () => void calls.push('lente') });

    await s.tick(); // première passe : tout est dû
    expect(calls).toEqual(['rapide', 'lente']);
    clock.advance({ seconds: 4 });
    await s.tick();
    expect(calls).toHaveLength(2);
    clock.advance({ seconds: 1 });
    await s.tick();
    expect(calls).toEqual(['rapide', 'lente', 'rapide']);
    clock.advance({ seconds: 55 });
    await s.tick();
    expect(calls.filter((c) => c === 'lente')).toHaveLength(2);
  });

  it('une tâche en erreur n’empêche ni les autres ni sa propre reprise', async () => {
    const clock = new FakeClock(new Date('2026-10-28T10:00:00Z'));
    const calls: string[] = [];
    let boom = true;
    const s = new Scheduler(clock, silent as any);
    s.add({ name: 'fragile', everyMs: 1_000, run: async () => { calls.push('fragile'); if (boom) throw new Error('boum'); } });
    s.add({ name: 'solide', everyMs: 1_000, run: async () => void calls.push('solide') });
    await s.tick();
    expect(calls).toEqual(['fragile', 'solide']);
    boom = false;
    clock.advance({ seconds: 1 });
    await s.tick();
    expect(calls.slice(2)).toEqual(['fragile', 'solide']);
    expect(s.stats('fragile')).toMatchObject({ runs: 2, failures: 1 });
  });

  it('ne relance jamais une tâche encore en cours (pas de chevauchement)', async () => {
    const clock = new FakeClock(new Date('2026-10-28T10:00:00Z'));
    let running = 0;
    let max = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const s = new Scheduler(clock, silent as any);
    s.add({ name: 'longue', everyMs: 1_000, run: async () => { running++; max = Math.max(max, running); await gate; running--; } });
    await s.tick();
    clock.advance({ seconds: 5 });
    await s.tick(); // la première n'est pas finie : on saute
    expect(max).toBe(1);
    release();
    await s.stop();
    expect(s.stats('longue').runs).toBe(1);
  });

  it('une tâche lente ne gèle pas les autres : tick() ne l’attend pas', async () => {
    const clock = new FakeClock(new Date('2026-10-28T10:00:00Z'));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let fast = 0;
    const s = new Scheduler(clock, silent as any);
    s.add({ name: 'lente', everyMs: 60_000, run: () => gate });
    s.add({ name: 'rapide', everyMs: 1_000, run: async () => void fast++ });
    const timeout = new Promise<string>((r) => setTimeout(() => r('bloqué'), 500));
    expect(await Promise.race([s.tick().then(() => 'rendu'), timeout])).toBe('rendu');
    clock.advance({ seconds: 2 });
    await s.tick();
    expect(fast).toBe(2); // la tâche rapide a continué pendant que la lente tourne
    expect(s.stats('lente').runs).toBe(0);
    release();
    await s.stop();
    expect(s.stats('lente').runs).toBe(1);
  });

  it('start/stop : vraie boucle courte, plusieurs exécutions puis plus aucune après l’arrêt', async () => {
    const real = { now: () => new Date() };
    let calls = 0;
    let finished = 0;
    const s = new Scheduler(real, silent as any);
    s.add({ name: 't', everyMs: 5, run: async () => { calls++; await new Promise((r) => setTimeout(r, 10)); finished++; } });
    s.start(2);
    await vi.waitFor(() => expect(s.stats('t').runs).toBeGreaterThanOrEqual(3), { timeout: 2000, interval: 5 });
    await s.stop();
    expect(finished).toBe(calls); // stop() a attendu la tâche en cours
    const runs = s.stats('t').runs;
    await new Promise((r) => setTimeout(r, 60));
    expect(s.stats('t').runs).toBe(runs); // plus aucune exécution après l'arrêt
  });

  it('refuse deux tâches de même nom ou un intervalle invalide', () => {
    const s = new Scheduler(new FakeClock(new Date()), silent as any);
    s.add({ name: 'a', everyMs: 1000, run: async () => {} });
    expect(() => s.add({ name: 'a', everyMs: 1000, run: async () => {} })).toThrow(/déjà/);
    expect(() => s.add({ name: 'b', everyMs: 0, run: async () => {} })).toThrow(/intervalle/i);
  });
});
