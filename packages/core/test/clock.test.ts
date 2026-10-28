import { describe, expect, it } from 'vitest';
import { FakeClock, SystemClock } from '../src/clock';

describe('Clock', () => {
  it('FakeClock avance et se règle', () => {
    const clock = new FakeClock(new Date('2026-10-01T09:00:00Z'));
    clock.advance({ hours: 2, minutes: 30 });
    expect(clock.now().toISOString()).toBe('2026-10-01T11:30:00.000Z');
    clock.set(new Date('2026-11-01T00:00:00Z'));
    expect(clock.now().toISOString()).toBe('2026-11-01T00:00:00.000Z');
  });

  it('FakeClock renvoie des copies (pas de mutation externe)', () => {
    const clock = new FakeClock(new Date('2026-10-01T09:00:00Z'));
    clock.now().setFullYear(1999);
    expect(clock.now().getUTCFullYear()).toBe(2026);
  });

  it('FakeClock avance par jours', () => {
    const clock = new FakeClock(new Date('2026-10-01T00:00:00Z'));
    clock.advance({ days: 3 });
    expect(clock.now().toISOString()).toBe('2026-10-04T00:00:00.000Z');
  });

  it('SystemClock renvoie une date proche de maintenant', () => {
    const delta = Math.abs(new SystemClock().now().getTime() - Date.now());
    expect(delta).toBeLessThan(1000);
  });
});
