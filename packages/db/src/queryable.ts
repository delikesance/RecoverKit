import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';

/** Pool ou client de transaction : tout ce qui sait exécuter une requête. */
export interface Queryable {
  query<R extends QueryResultRow = any>(text: string, values?: unknown[]): Promise<QueryResult<R>>;
}

/** Exécute `fn` dans une transaction ; rollback si elle lève. */
export async function withTransaction<T>(pool: Pool, fn: (tx: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (e) {
    await client.query('rollback').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}
