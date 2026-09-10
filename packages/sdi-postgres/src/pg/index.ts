import type { Pool, PoolClient, QueryResult } from 'pg';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import type { Scalar } from '@server-driven-impact/core';
import type { ImpactAdapter } from '@server-driven-impact/runtime/adapter';
import { postgresAdapter } from '../postgres/index.js';
import type { Sql } from '../postgres/sql.js';
import type { PostgresSetupTransaction } from '../postgres/public-types.js';

const require = createRequire(import.meta.url);
export type PgTransaction = PostgresSetupTransaction;
export type PgRow = Record<string, unknown>;
export interface PgCommandDb {
  readonly scope: Scalar;
  execute(statement: Sql): Promise<PgRow[]>;
  copyFrom(statement: Sql, source: AsyncIterable<Uint8Array|string> | Iterable<Uint8Array|string>): Promise<void>;
  copyTo(statement: Sql): AsyncIterable<Uint8Array>;
  cursor(statement: Sql, batchSize?: number): AsyncIterable<PgRow[]>;
  refreshMaterializedView(resource: string, options?: {concurrently?:boolean;withData?:boolean}): Promise<void>;
  savepoint<T>(work: (db: PgCommandDb) => Promise<T>): Promise<T>;
}
export interface PgOptions {
  database: Pool;
  setup?: (tx: PgTransaction, scope: Scalar) => Promise<void>;
  isolationLevel?: 'read uncommitted' | 'read committed' | 'repeatable read' | 'serializable';
  connectionMode?: 'direct' | 'session' | 'transaction';
}

/** Bridge only the common session operations, preserving node-postgres row codecs and SQLSTATE. */
export function pgDatabase(pool: Pool) {
  function unsafe(client: Pick<PoolClient, 'query'>, text: string, values: readonly unknown[] = []) {
    let execution: Promise<Record<string, unknown>[]> | undefined;
    const run = () => execution ??= client.query(text, [...values]).then(result => {
      const results = Array.isArray(result) ? result : [result];
      return results.flatMap((value: QueryResult) => value.rows);
    });
    return {
      then: (resolve: (rows:Record<string,unknown>[])=>unknown, reject: (error:unknown)=>unknown) => run().then(resolve,reject),
      catch: (reject:(error:unknown)=>unknown) => run().catch(reject),
      async writable() {
        const copy = require('pg-copy-streams') as typeof import('pg-copy-streams');
        return client.query(copy.from(text));
      },
      async readable() {
        const copy = require('pg-copy-streams') as typeof import('pg-copy-streams');
        return client.query(copy.to(text));
      },
      async *cursor(size:number) {
        const name = `sdi_cursor_${randomUUID().replaceAll('-','')}`;
        await client.query(`declare ${name} no scroll cursor for ${text}`, [...values]);
        let failed=false;
        try {
          while (true) {
            const result = await client.query(`fetch forward ${size} from ${name}`);
            if (!result.rows.length) return;
            yield result.rows;
          }
        } catch(error) { failed=true;throw error; }
        finally {
          try { await client.query(`close ${name}`); }
          catch(error) { if(!failed)throw error; }
        }
      },
    };
  }
  async function reserve() {
    const client=await pool.connect();
    let released=false;
    return {
      unsafe: ((text:string,values?:unknown[])=>unsafe(client,text,values)) as unknown as PgTransaction['unsafe'],
      release() { if(!released){released=true;client.release();} },
      discard() { if(!released){released=true;client.release(true);} },
    };
  }
  return {
    unsafe: ((text:string,values?:unknown[])=>unsafe(pool,text,values)) as unknown as PgTransaction['unsafe'],
    reserve,
    async begin<T>(mode:string,work:(transaction:PgTransaction)=>Promise<T>):Promise<T> {
      const session=await reserve();
      let broken=false;
      try {
        await session.unsafe(`begin ${mode}`);
        const data=await work(session);
        await session.unsafe('commit');
        return data;
      } catch(error) {
        try { await session.unsafe('rollback'); } catch { broken=true; }
        throw error;
      } finally { if(broken)session.discard();else session.release(); }
    },
  };
}

export function pgAdapter(options: PgOptions): ImpactAdapter<PgCommandDb> {
  if (!options.database || typeof options.database.connect!=='function')throw new Error('PG_POOL_REQUIRED');
  return postgresAdapter({...options, database:pgDatabase(options.database) as never}) as unknown as ImpactAdapter<PgCommandDb>;
}
