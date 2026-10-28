import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';

export const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

const LOCK_KEY = 4_242_001;

/** Applique les migrations SQL numérotées non encore appliquées. Renvoie les noms appliqués. */
export async function migrate(pool: Pool, dir: string = MIGRATIONS_DIR): Promise<string[]> {
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query('select pg_advisory_lock($1)', [LOCK_KEY]);
    await client.query(
      `create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`,
    );
    const done = new Set((await client.query('select name from schema_migrations')).rows.map((r) => r.name as string));
    const files = (await readdir(/* turbopackIgnore: true */ dir)).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(join(dir, file), 'utf8');
      try {
        await client.query('begin');
        await client.query(sql);
        await client.query('insert into schema_migrations (name) values ($1)', [file]);
        await client.query('commit');
      } catch (e) {
        await client.query('rollback');
        throw new Error(`Migration ${file} échouée : ${(e as Error).message}`);
      }
      applied.push(file);
    }
  } finally {
    await client.query('select pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => undefined);
    client.release();
  }
  return applied;
}
