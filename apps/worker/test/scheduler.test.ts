import { describe, expect, it } from 'vitest';
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
    const first = s.tick();
    clock.advance({ seconds: 5 });
    await s.tick(); // la première n'est pas finie : on saute
    expect(max).toBe(1);
    release();
    await first;
    expect(s.stats('longue').runs).toBe(1);
  });

  it('start/stop : boucle de tick et arrêt propre en attendant les tâches en cours', async () => {
    const clock = new FakeClock(new Date('2026-10-28T10:00:00Z'));
    let done = false;
    const s = new Scheduler(clock, silent as any);
    s.add({ name: 't', everyMs: 1, run: async () => { await new Promise((r) => setTimeout(r, 20)); done = true; } });
    s.start(5);
    await new Promise((r) => setTimeout(r, 15));
    await s.stop();
    expect(done).toBe(true);
    const runs = s.stats('t').runs;
    await new Promise((r) => setTimeout(r, 30));
    expect(s.stats('t').runs).toBe(runs); // plus aucune exécution après l'arrêt
  });

  it('refuse deux tâches de même nom ou un intervalle invalide', () => {
    const s = new Scheduler(new FakeClock(new Date()), silent as any);
    s.add({ name: 'a', everyMs: 1000, run: async () => {} });
    expect(() => s.add({ name: 'a', everyMs: 1000, run: async () => {} })).toThrow(/déjà/);
    expect(() => s.add({ name: 'b', everyMs: 0, run: async () => {} })).toThrow(/intervalle/i);
  });
});
