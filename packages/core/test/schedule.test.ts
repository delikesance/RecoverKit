import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SEQUENCE,
  DEFAULT_WINDOW,
  nextWindowInstant,
  scheduleSteps,
  type SequenceStep,
} from '../src/schedule';

const PARIS = { ...DEFAULT_WINDOW, timeZone: 'Europe/Paris' };
const iso = (d: Date) => d.toISOString();

describe('séquence par défaut', () => {
  it('suit la décision D3 : 1 h, 3 j, 7 j, 12 j, toutes actives', () => {
    expect(DEFAULT_SEQUENCE.map((s) => s.delayMinutes)).toEqual([60, 3 * 1440, 7 * 1440, 12 * 1440]);
    expect(DEFAULT_SEQUENCE.every((s) => s.active)).toBe(true);
    expect(DEFAULT_WINDOW).toMatchObject({ startHour: 9, endHour: 19 });
  });
});

describe('nextWindowInstant', () => {
  it("laisse intact un instant déjà dans la fenêtre", () => {
    const d = new Date('2026-10-01T09:00:00Z'); // 11:00 Paris (UTC+2)
    expect(iso(nextWindowInstant(d, PARIS))).toBe(iso(d));
  });

  it('reporte à 9 h le jour même avant la fenêtre', () => {
    const d = new Date('2026-10-01T04:00:00Z'); // 06:00 Paris
    expect(iso(nextWindowInstant(d, PARIS))).toBe('2026-10-01T07:00:00.000Z'); // 09:00 Paris
  });

  it('reporte à 9 h le lendemain après la fenêtre', () => {
    const d = new Date('2026-10-01T18:30:00Z'); // 20:30 Paris
    expect(iso(nextWindowInstant(d, PARIS))).toBe('2026-10-02T07:00:00.000Z');
  });

  it("19 h pile est hors fenêtre (borne exclusive)", () => {
    const d = new Date('2026-10-01T17:00:00Z'); // 19:00 Paris
    expect(iso(nextWindowInstant(d, PARIS))).toBe('2026-10-02T07:00:00.000Z');
  });

  it("9 h pile est dans la fenêtre (borne inclusive)", () => {
    const d = new Date('2026-10-01T07:00:00Z');
    expect(iso(nextWindowInstant(d, PARIS))).toBe(iso(d));
  });

  it("gère le passage à l'heure d'hiver (26 oct. 2026, UTC+1)", () => {
    const d = new Date('2026-10-26T05:00:00Z'); // 06:00 Paris
    expect(iso(nextWindowInstant(d, PARIS))).toBe('2026-10-26T08:00:00.000Z');
  });

  it("gère le passage à l'heure d'été (29 mars 2026)", () => {
    const d = new Date('2026-03-29T22:00:00Z'); // 00:00 le 30 mars Paris (UTC+2)
    expect(iso(nextWindowInstant(d, PARIS))).toBe('2026-03-30T07:00:00.000Z');
  });

  it('respecte un autre fuseau (America/New_York)', () => {
    const ny = { startHour: 9, endHour: 19, timeZone: 'America/New_York' };
    const d = new Date('2026-10-01T10:00:00Z'); // 06:00 New York (UTC-4)
    expect(iso(nextWindowInstant(d, ny))).toBe('2026-10-01T13:00:00.000Z');
  });
});

describe('scheduleSteps', () => {
  const failedAt = new Date('2026-10-01T08:00:00Z'); // 10:00 Paris

  it('calcule les échéances brutes ajustées à la fenêtre', () => {
    const out = scheduleSteps({ failedAt, now: failedAt, steps: DEFAULT_SEQUENCE, window: PARIS });
    expect(out.map((s) => s.stepIndex)).toEqual([0, 1, 2, 3]);
    expect(iso(out[0]!.dueAt)).toBe('2026-10-01T09:00:00.000Z'); // 11:00 Paris
    expect(iso(out[1]!.dueAt)).toBe('2026-10-04T08:00:00.000Z');
    expect(iso(out[2]!.dueAt)).toBe('2026-10-08T08:00:00.000Z');
    expect(iso(out[3]!.dueAt)).toBe('2026-10-13T08:00:00.000Z');
  });

  it("n'envoie rien quand la séquence est vide ou entièrement inactive", () => {
    expect(scheduleSteps({ failedAt, now: failedAt, steps: [], window: PARIS })).toEqual([]);
    const inactive: SequenceStep[] = DEFAULT_SEQUENCE.map((s) => ({ ...s, active: false }));
    expect(scheduleSteps({ failedAt, now: failedAt, steps: inactive, window: PARIS })).toEqual([]);
  });

  it('ignore les étapes inactives mais conserve les index', () => {
    const steps = DEFAULT_SEQUENCE.map((s, i) => (i === 1 ? { ...s, active: false } : s));
    const out = scheduleSteps({ failedAt, now: failedAt, steps, window: PARIS });
    expect(out.map((s) => s.stepIndex)).toEqual([0, 2, 3]);
  });

  it('rattrape un échec ancien sans rafale (≥ 12 h entre deux emails)', () => {
    const old = new Date('2026-10-01T08:00:00Z');
    const now = new Date('2026-10-11T08:00:00Z'); // +10 jours, 10:00 Paris
    const out = scheduleSteps({ failedAt: old, now, steps: DEFAULT_SEQUENCE, window: PARIS });
    expect(out).toHaveLength(4);
    expect(iso(out[0]!.dueAt)).toBe('2026-10-11T08:00:00.000Z'); // tout de suite
    for (let i = 1; i < out.length; i++) {
      const gap = out[i]!.dueAt.getTime() - out[i - 1]!.dueAt.getTime();
      expect(gap).toBeGreaterThanOrEqual(12 * 3600 * 1000);
    }
    for (const s of out) expect(s.dueAt.getTime()).toBeGreaterThanOrEqual(now.getTime());
  });

  it("trie les étapes par délai même si elles sont fournies dans le désordre", () => {
    const shuffled = [DEFAULT_SEQUENCE[2]!, DEFAULT_SEQUENCE[0]!, DEFAULT_SEQUENCE[1]!];
    const out = scheduleSteps({ failedAt, now: failedAt, steps: shuffled, window: PARIS });
    const times = out.map((s) => s.dueAt.getTime());
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });
});
