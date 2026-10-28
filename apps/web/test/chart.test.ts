import { describe, expect, it } from 'vitest';
import { buildAreaChart } from '../src/lib/chart';

describe('buildAreaChart', () => {
  const series = [
    { date: '2026-10-01', cumulative: 0 },
    { date: '2026-10-02', cumulative: 1000 },
    { date: '2026-10-03', cumulative: 1000 },
    { date: '2026-10-04', cumulative: 2000 },
  ];

  it('produit une ligne de gauche à droite dont l’ordonnée monte avec le cumul', () => {
    const c = buildAreaChart(series, { width: 600, height: 200, padding: 10 });
    const pts = c.points;
    expect(pts).toHaveLength(4);
    expect(pts[0]!.x).toBe(0);
    expect(pts.at(-1)!.x).toBe(600);
    expect(pts[0]!.y).toBeGreaterThan(pts[1]!.y); // plus le cumul est grand, plus y est petit
    expect(pts[1]!.y).toBe(pts[2]!.y); // plateau
    expect(pts[3]!.y).toBe(10); // le maximum touche la marge haute
    expect(pts[0]!.y).toBe(190); // zéro = bas moins la marge
  });

  it('l’aire se referme sur la base', () => {
    const c = buildAreaChart(series, { width: 600, height: 200, padding: 10 });
    expect(c.line.startsWith('M0,190')).toBe(true);
    expect(c.area.endsWith('L600,200 L0,200 Z')).toBe(true);
  });

  it('gère une série vide, un seul point et une série à zéro', () => {
    expect(buildAreaChart([], { width: 600, height: 200 })).toMatchObject({ line: '', area: '', points: [] });
    const one = buildAreaChart([{ date: '2026-10-01', cumulative: 500 }], { width: 600, height: 200, padding: 10 });
    expect(one.points).toHaveLength(1);
    expect(Number.isFinite(one.points[0]!.y)).toBe(true);
    const flat = buildAreaChart(series.map((s) => ({ ...s, cumulative: 0 })), { width: 600, height: 200, padding: 10 });
    expect(flat.points.every((p) => p.y === 190)).toBe(true);
  });

  it('fournit les repères horizontaux et le maximum', () => {
    const c = buildAreaChart(series, { width: 600, height: 200, padding: 10 });
    expect(c.max).toBe(2000);
    expect(c.gridY).toHaveLength(4);
  });
});
