import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import type { SqlDriverAdapter, SqlDriverAdapterFactory, Transaction } from '@prisma/driver-adapter-utils';
import { bindAdapter, type ImpactAdapter } from '@server-driven-impact/runtime/adapter';
import { pgAdapter, type PgCommandDb, type PgOptions } from '../pg/index.js';

export interface PrismaCommandClient {
  $disconnect(): Promise<void>;
}
export interface PrismaOptions<Client extends PrismaCommandClient> extends PgOptions {
  /** Construct your generated Prisma 7.10 client with the supplied public driver adapter. */
  createClient: (adapter: SqlDriverAdapterFactory) => Client;
  schema?: string;
}

/** A scoped pg facade; all execution still crosses SDI's native transaction guard. */
class CommandPool extends pg.Pool {
  constructor(database: PgCommandDb) {
    super({ max: 1 });
    this.query = ((...args: unknown[]) => Reflect.apply(database.query, database, args)) as pg.Pool['query'];
    this.connect = (() => {
      throw new Error('PRISMA_COMMAND_CONNECTION_OWNED_BY_SDI');
    }) as pg.Pool['connect'];
  }
}

function bindClient(database: PgCommandDb, schema?: string) {
  let open = true;
  const operations = new Set<Promise<unknown>>();
  const transactions = new Set<{ cancel(): void; completion: Promise<unknown> }>();
  function assertOpen() {
    if (!open) throw new Error('WRITE_CONTEXT_CLOSED');
  }
  function run<T>(work: () => Promise<T>): Promise<T> {
    assertOpen();
    const operation = work();
    operations.add(operation);
    void operation.then(
      () => operations.delete(operation),
      () => operations.delete(operation),
    );
    return operation;
  }
  function factory(db: PgCommandDb): SqlDriverAdapterFactory {
    return {
      provider: 'postgres',
      adapterName: 'sdi-prisma-pg',
      async connect(): Promise<SqlDriverAdapter> {
        assertOpen();
        const pool = new CommandPool(db);
        // Prisma and this package may resolve different @types/pg minor versions.
        const inner = await new PrismaPg(pool as unknown as ConstructorParameters<typeof PrismaPg>[0], {
          schema,
        }).connect();
        // Prisma uses instanceof Pool. Never let a duplicate pg installation silently create another connection.
        if (!Object.is(inner.underlyingDriver(), pool)) {
          await inner.dispose();
          throw new Error('PRISMA_PG_INSTANCE_MISMATCH');
        }
        return {
          provider: 'postgres',
          adapterName: 'sdi-prisma-pg',
          queryRaw: query => run(() => inner.queryRaw(query)),
          executeRaw: query => run(() => inner.executeRaw(query)),
          executeScript: async () => {
            throw new Error('PRISMA_COMMAND_SCRIPT_UNSUPPORTED');
          },
          getConnectionInfo: () => inner.getConnectionInfo(),
          dispose: () => inner.dispose(),
          async startTransaction(isolationLevel): Promise<Transaction> {
            assertOpen();
            if (isolationLevel) throw new Error('PRISMA_NESTED_ISOLATION_UNSUPPORTED');
            let readyResolve!: (adapter: SqlDriverAdapter) => void;
            let readyReject!: (error: unknown) => void;
            const ready = new Promise<SqlDriverAdapter>((resolve, reject) => {
              readyResolve = resolve;
              readyReject = reject;
            });
            let commit!: () => void;
            let abort!: (reason: unknown) => void;
            const gate = new Promise<void>((resolve, reject) => {
              commit = resolve;
              abort = reject;
            });
            void gate.catch(() => {});
            const rollback = new Error('PRISMA_SAVEPOINT_ROLLBACK');
            const completion = db.savepoint(async child => {
              const adapter = await factory(child).connect();
              readyResolve(adapter);
              try {
                await gate;
              } finally {
                await adapter.dispose();
              }
            });
            const transaction = { cancel: () => abort(rollback), completion };
            transactions.add(transaction);
            void completion.then(
              () => transactions.delete(transaction),
              error => {
                transactions.delete(transaction);
                readyReject(error);
              },
            );
            const adapter = await ready;
            return {
              provider: 'postgres',
              adapterName: 'sdi-prisma-pg',
              // SDI owns SQL transaction control; Prisma must call these hooks without COMMIT SQL.
              options: { usePhantomQuery: true },
              queryRaw: query => adapter.queryRaw(query),
              executeRaw: query => adapter.executeRaw(query),
              async commit() {
                commit();
                await completion;
              },
              async rollback() {
                abort(rollback);
                try {
                  await completion;
                } catch (error) {
                  if (error !== rollback) throw error;
                }
              },
            };
          },
        };
      },
    };
  }
  return {
    factory: factory(database),
    finish() {
      if (operations.size || transactions.size) throw new Error('UNAWAITED_DATABASE_OPERATION');
    },
    async close() {
      open = false;
      const pending = [...transactions];
      for (const transaction of pending) transaction.cancel();
      await Promise.allSettled([...operations, ...pending.map(transaction => transaction.completion)]);
    },
  };
}

/** Prisma supplies its generated models; SDI owns the outer commit and observer drain. */
export function prismaAdapter<Client extends PrismaCommandClient>(
  options: PrismaOptions<Client>,
): ImpactAdapter<Client> {
  if (typeof options.createClient !== 'function') throw new Error('PRISMA_CLIENT_FACTORY_REQUIRED');
  const native = pgAdapter(options);
  return {
    [bindAdapter](resources, manifest) {
      const bound = native[bindAdapter](resources, manifest);
      return {
        ...bound,
        command: (scope, writes, work) =>
          bound.command(scope, writes, async database => {
            const binding = bindClient(database, options.schema);
            let client: Client | undefined;
            try {
              client = options.createClient(binding.factory);
              const result = await work(client);
              binding.finish();
              return result;
            } finally {
              await binding.close();
              await client?.$disconnect();
            }
          }),
      };
    },
  };
}
