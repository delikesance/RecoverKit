export interface ChartPoint {
  x: number;
  y: number;
}

export interface AreaChart {
  points: ChartPoint[];
  line: string;
  area: string;
  max: number;
  gridY: number[];
}

/** Courbe cumulée en SVG : x réparti sur la largeur, y inversé, marge haute et basse. */
export function buildAreaChart(
  series: readonly { date: string; cumulative: number }[],
  o: { width: number; height: number; padding?: number },
): AreaChart {
  const pad = o.padding ?? 12;
  const max = series.reduce((m, s) => Math.max(m, s.cumulative), 0);
  const top = pad;
  const bottom = o.height - pad;
  const gridY = [0, 1, 2, 3].map((i) => Math.round(top + ((bottom - top) * i) / 3));
  if (series.length === 0) return { points: [], line: '', area: '', max, gridY };

  const stepX = series.length > 1 ? o.width / (series.length - 1) : 0;
  const points = series.map((s, i) => ({
    x: Math.round(i * stepX * 100) / 100,
    y: max === 0 ? bottom : Math.round((bottom - ((bottom - top) * s.cumulative) / max) * 100) / 100,
  }));
  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ');
  const area = `${line} L${points.at(-1)!.x},${o.height} L${points[0]!.x},${o.height} Z`;
  return { points, line, area, max, gridY };
}
