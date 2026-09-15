import type { Pool, PoolClient, QueryResult, QueryConfig, QueryArrayResult, QueryResultRow } from 'pg';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import type { Scalar } from '@server-driven-impact/core';
import type { ImpactAdapter } from '@server-driven-impact/runtime/adapter';
import { postgresAdapter } from '../postgres/index.js';
import { executeDriver, type DriverQueryOptions } from '../postgres/driver-execution.js';
import type { Sql } from '../postgres/sql.js';
import type { IsolationLevel } from '../postgres/preamble.js';
import type { PostgresSetupTransaction } from '../postgres/public-types.js';

const require = createRequire(import.meta.url);
export type PgTransaction = PostgresSetupTransaction;
export type PgRow = Record<string, unknown>;
export type PgExecuteResult = QueryResult<PgRow>;
export type PgQueryConfig = Pick<QueryConfig, 'text' | 'values' | 'name' | 'types'>;
export type PgArrayQueryConfig = PgQueryConfig & { rowMode: 'array' };
export interface PgCommandDb {
  readonly scope: Scalar;
  execute(statement: Sql): Promise<PgExecuteResult>;
  query<R extends any[] = any[]>(config: PgArrayQueryConfig, values?: unknown[]): Promise<QueryArrayResult<R>>;
  query<R extends QueryResultRow = PgRow>(query: string | PgQueryConfig, values?: unknown[]): Promise<QueryResult<R>>;
  copyFrom(statement: Sql, source: AsyncIterable<Uint8Array | string> | Iterable<Uint8Array | string>): Promise<void>;
  copyTo(statement: Sql): AsyncIterable<Uint8Array>;
  cursor(statement: Sql, batchSize?: number): AsyncIterable<PgRow[]>;
  refreshMaterializedView(resource: string, options?: { concurrently?: boolean; withData?: boolean }): Promise<void>;
  savepoint<T>(work: (db: PgCommandDb) => Promise<T>): Promise<T>;
}
export interface PgOptions {
  database: Pool;
  setup?: (tx: PgTransaction, scope: Scalar) => Promise<void>;
  isolationLevel?: IsolationLevel;
}

/** Bridge only the common session operations, preserving node-postgres row codecs and SQLSTATE. */
export function pgDatabase(pool: Pool) {
  function unsafe(client: Pick<PoolClient, 'query'>, text: string, values: readonly unknown[] = []) {
    let execution: Promise<Record<string, unknown>[]> | undefined;
    const run = () =>
      (execution ??= client.query(text, [...values]).then(result => {
        const results = Array.isArray(result) ? result : [result];
        return results.flatMap((value: QueryResult) => value.rows);
      }));
    return {
      // biome-ignore lint/suspicious/noThenProperty: intentional thenable - this object is the lazy pending-query result callers `await` directly, matching the `postgres` driver's tagged-template query API.
      then: (resolve: (rows: Record<string, unknown>[]) => unknown, reject: (error: unknown) => unknown) =>
        run().then(resolve, reject),
      catch: (reject: (error: unknown) => unknown) => run().catch(reject),
      async writable() {
        const copy = require('pg-copy-streams') as typeof import('pg-copy-streams');
        return client.query(copy.from(text));
      },
      async readable() {
        const copy = require('pg-copy-streams') as typeof import('pg-copy-streams');
        return client.query(copy.to(text));
      },
      async *cursor(size: number) {
        const name = `sdi_cursor_${randomUUID().replaceAll('-', '')}`;
        await client.query(`declare ${name} no scroll cursor for ${text}`, [...values]);
        let failed = false;
        try {
          while (true) {
            const result = await client.query(`fetch forward ${size} from ${name}`);
            if (!result.rows.length) return;
            yield result.rows;
          }
        } catch (error) {
          failed = true;
          throw error;
        } finally {
          try {
            await client.query(`close ${name}`);
          } catch (error) {
            // biome-ignore lint/correctness/noUnsafeFinally: intentional - only surface the close error when the cursor loop itself did not already fail, so the original error is never masked.
            if (!failed) throw error;
          }
        }
      },
    };
  }
  async function reserve() {
    const client = await pool.connect();
    let released = false;
    return {
      unsafe: ((text: string, values?: unknown[]) =>
        unsafe(client, text, values)) as unknown as PgTransaction['unsafe'],
      [executeDriver]: (text: string, values: readonly unknown[], options?: DriverQueryOptions) =>
        client.query({
          text,
          values: [...values],
          name: options?.name,
          rowMode: options?.rowMode,
          types: options?.types as QueryConfig['types'],
        } as QueryConfig),
      release() {
        if (!released) {
          released = true;
          client.release();
        }
      },
      discard() {
        if (!released) {
          released = true;
          client.release(true);
        }
      },
    };
  }
  return {
    unsafe: ((text: string, values?: unknown[]) => unsafe(pool, text, values)) as unknown as PgTransaction['unsafe'],
    reserve,
    async begin<T>(mode: string, work: (transaction: PgTransaction) => Promise<T>): Promise<T> {
      const session = await reserve();
      let broken = false;
      try {
        await session.unsafe(`begin ${mode}`);
        const data = await work(session);
        await session.unsafe('commit');
        return data;
      } catch (error) {
        try {
          await session.unsafe('rollback');
        } catch {
          broken = true;
        }
        throw error;
      } finally {
        if (broken) session.discard();
        else session.release();
      }
    },
  };
}

export function pgAdapter(options: PgOptions): ImpactAdapter<PgCommandDb> {
  if ('query' in options || 'command' in options || 'connectionMode' in options)
    throw new Error('POSTGRES_CONNECTION_OPTIONS_REMOVED');
  if (!options.database || typeof options.database.connect !== 'function') throw new Error('PG_POOL_REQUIRED');
  return postgresAdapter({
    ...options,
    database: pgDatabase(options.database) as never,
  }) as unknown as ImpactAdapter<PgCommandDb>;
}
