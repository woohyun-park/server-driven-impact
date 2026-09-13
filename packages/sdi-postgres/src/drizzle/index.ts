import type { PoolClient } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { DrizzleConfig } from 'drizzle-orm/utils';
import { bindAdapter, type ImpactAdapter } from '@server-driven-impact/runtime/adapter';
import { pgAdapter, type PgCommandDb, type PgOptions } from '../pg/index.js';

export type DrizzleCommandDb<TSchema extends Record<string, unknown> = Record<string, never>> = Omit<
  NodePgDatabase<TSchema>,
  'transaction'
> & {
  /** A nested transaction is an SDI savepoint on the same physical connection. */
  transaction<T>(work: (tx: DrizzleCommandDb<TSchema>) => Promise<T>): Promise<T>;
  savepoint<T>(work: (tx: DrizzleCommandDb<TSchema>) => Promise<T>): Promise<T>;
};
export interface DrizzleOptions<TSchema extends Record<string, unknown> = Record<string, never>> extends PgOptions {
  drizzle?: Pick<DrizzleConfig<TSchema>, 'schema' | 'casing' | 'logger'>;
}

/** Construct the ORM over a guarded driver execution point, preserving its prototypes and lazy builders. */
export function drizzleAdapter<TSchema extends Record<string, unknown> = Record<string, never>>(
  options: DrizzleOptions<TSchema>,
): ImpactAdapter<DrizzleCommandDb<TSchema>> {
  const adapter = pgAdapter(options);
  function client(db: PgCommandDb): DrizzleCommandDb<TSchema> {
    // Drizzle's public client overload requires a full pg client type, but this
    // scoped bridge deliberately exposes only the query method it uses.
    const driver = Object.freeze({ query: db.query.bind(db) });
    const orm = drizzle(driver as unknown as PoolClient, options.drizzle ?? {});
    const savepoint = <T>(work: (tx: DrizzleCommandDb<TSchema>) => Promise<T>, config?: unknown) => {
      if (config !== undefined) return Promise.reject(new Error('NESTED_TRANSACTION_CONFIG_UNSUPPORTED'));
      return db.savepoint(child => work(client(child)));
    };
    Object.defineProperties(orm, {
      transaction: { value: savepoint },
      savepoint: { value: savepoint },
    });
    return orm as unknown as DrizzleCommandDb<TSchema>;
  }
  return Object.freeze({
    [bindAdapter](resources, manifest) {
      const bound = adapter[bindAdapter](resources, manifest);
      return { ...bound, command: (scope, writes, work) => bound.command(scope, writes, db => work(client(db))) };
    },
  } satisfies ImpactAdapter<DrizzleCommandDb<TSchema>>);
}
