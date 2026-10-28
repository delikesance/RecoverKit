import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { migrate } from '@recoverkit/db';

const ADMIN_URL = process.env.TEST_DATABASE_ADMIN_URL ?? 'postgresql://recoverkit:recoverkit@localhost:5432/postgres';

export interface TestDb {
  name: string;
  pool: pg.Pool;
  url: string;
  dispose(): Promise<void>;
}

/** Crée une base PostgreSQL isolée (une par fichier de test), migrations appliquées. */
export async function createTestDb(): Promise<TestDb> {
  const name = `rk_test_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  try {
    await admin.query(`create database ${name}`);
  } finally {
    await admin.end();
  }
  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: url.toString(), max: 10 });
  await migrate(pool);

  return {
    name,
    pool,
    url: url.toString(),
    async dispose() {
      await pool.end();
      const a = new pg.Client({ connectionString: ADMIN_URL });
      await a.connect();
      try {
        await a.query(`drop database if exists ${name} with (force)`);
      } finally {
        await a.end();
      }
    },
  };
}
