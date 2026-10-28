import type { Queryable } from './queryable';

/** Fenêtre fixe : incrément atomique, `allowed` tant que count ≤ limit. */
export async function hitRateLimit(
  db: Queryable,
  key: string,
  opts: { limit: number; windowSeconds: number },
  now: Date,
): Promise<{ allowed: boolean; count: number }> {
  const windowStart = new Date(Math.floor(now.getTime() / (opts.windowSeconds * 1000)) * opts.windowSeconds * 1000);
  const res = await db.query(
    `insert into rate_limits (key, window_start, count) values ($1, $2, 1)
     on conflict (key, window_start) do update set count = rate_limits.count + 1
     returning count`,
    [key, windowStart],
  );
  const count = res.rows[0].count as number;
  return { allowed: count <= opts.limit, count };
}

/** Supprime les fenêtres de plus d'une heure. */
export async function purgeRateLimits(db: Queryable, now: Date): Promise<number> {
  const res = await db.query(`delete from rate_limits where window_start < $1`, [new Date(now.getTime() - 3600_000)]);
  return res.rowCount ?? 0;
}
