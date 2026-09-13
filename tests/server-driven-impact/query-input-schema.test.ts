import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { createImpact, defineQueries, q, type Resources, type StandardSchemaV1 } from '@server-driven-impact/runtime';
import { defineCacheContract } from '@server-driven-impact/cache-contract';
import { sqliteAdapter } from '@server-driven-impact/sqlite';

const resources: Resources = {
  todos: { table: 'todos', idColumn: 'id', scopeColumn: 'account_id', columns: ['id', 'account_id', 'status'] },
};
const statusSchema: StandardSchemaV1<{ status: string }, { status: string }> = {
  '~standard': {
    version: 1,
    vendor: 'test',
    validate: value => {
      const status = (value as { status?: unknown } | null)?.status;
      return typeof status === 'string' ? { value: { status } } : { issues: [{ message: 'status must be a string' }] };
    },
  },
};
const asyncSchema: StandardSchemaV1<{ status: string }, { status: string }> = {
  '~standard': { version: 1, vendor: 'test', validate: async value => statusSchema['~standard'].validate(value) },
};
const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function newDatabase(): DatabaseSync {
  const database = new DatabaseSync(':memory:');
  databases.push(database);
  return database;
}

function fixture() {
  const database = newDatabase();
  database.exec(
    'pragma foreign_keys=on; create table todos(id text primary key, account_id text not null, status text not null)',
  );
  database.exec("insert into todos values('t1','a','open'),('t2','a','done')");
  const queries = defineQueries({
    'todos.byStatus': {
      input: statusSchema,
      plan: q.select('todos', {
        columns: ['id'],
        where: [q.eq('status', q.input('status'))],
        order: [{ field: 'id' }],
      }),
    },
    'todos.byStatusAsync': {
      input: asyncSchema,
      plan: q.select('todos', { columns: ['id'], where: [q.eq('status', q.input('status'))] }),
    },
    'todos.viaCall': { input: statusSchema, plan: q.call('todos.byStatus') },
    'todos.legacy': {
      input: { parse: (value: unknown) => value as { status: string } },
      plan: q.call('todos.byStatus'),
    },
  });
  return createImpact({ resources, queries, adapter: sqliteAdapter({ database }) });
}
const context = { scope: 'a' };

describe('Standard Schema query inputs', () => {
  it('validates with a synchronous standard schema', async () => {
    expect(await fixture().query('todos.byStatus', { status: 'open' }, context)).toEqual([{ id: 't1' }]);
  });
  it('rejects issues with the input error code and keeps issues as the cause', async () => {
    await expect(
      // @ts-expect-error status must be a string
      fixture().query('todos.byStatus', { status: 1 }, context),
    ).rejects.toMatchObject({
      message: 'INVALID_QUERY_INPUT:status must be a string',
      cause: [{ message: 'status must be a string' }],
    });
  });
  it('awaits asynchronous validation', async () => {
    expect(await fixture().query('todos.byStatusAsync', { status: 'done' }, context)).toEqual([{ id: 't2' }]);
  });
  it('parses through q.call for both schema styles', async () => {
    const engine = fixture();
    expect(await engine.query('todos.viaCall', { status: 'open' }, context)).toEqual([{ id: 't1' }]);
    expect(await engine.query('todos.legacy', { status: 'done' }, context)).toEqual([{ id: 't2' }]);
  });
  it('still rejects definitions without a parser or standard schema', () => {
    expect(() =>
      createImpact({
        resources,
        queries: { broken: { input: {} as never, plan: q.select('todos') } },
        adapter: sqliteAdapter({ database: newDatabase() }),
      }),
    ).toThrow('INVALID_QUERY_DEFINITION');
    expect(() =>
      createImpact({
        resources,
        queries: {
          broken: {
            input: { '~standard': { version: 2, vendor: 'x', validate: () => ({ value: {} }) } } as never,
            plan: q.select('todos'),
          },
        },
        adapter: sqliteAdapter({ database: newDatabase() }),
      }),
    ).toThrow('UNSUPPORTED_INPUT_SCHEMA_VERSION');
  });
  it('awaits a non-native thenable returned by validate, not only real Promises, through q.call', async () => {
    const database = newDatabase();
    database.exec(
      'pragma foreign_keys=on; create table todos(id text primary key, account_id text not null, status text not null)',
    );
    database.exec("insert into todos values('t1','a','open'),('t2','a','done')");
    // A spec-compliant `validate` may return anything thenable, not only a native Promise
    // (a wrapper, a polyfill, a cross-realm value). `then` is intentionally NOT a real Promise.
    const thenableSchema: StandardSchemaV1<{ status: string }, { status: string }> = {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate: value =>
          ({
            // biome-ignore lint/suspicious/noThenProperty: the regression under test is specifically a thenable that is not a native Promise.
            then(resolve: (result: { value: { status: string } }) => void) {
              resolve({ value: value as { status: string } });
            },
          }) as never,
      },
    };
    const queries = defineQueries({
      // Never queried directly: only reachable through q.call, which has no plain-object
      // guard of its own and would otherwise hand the unresolved thenable straight through.
      'todos.thenableInner': {
        input: thenableSchema,
        plan: q.select('todos', { columns: ['id'], where: [q.eq('status', q.input('status'))] }),
      },
      'todos.viaThenableCall': { input: statusSchema, plan: q.call('todos.thenableInner') },
    });
    const engine = createImpact({ resources, queries, adapter: sqliteAdapter({ database }) });
    expect(await engine.query('todos.viaThenableCall', { status: 'open' }, context)).toEqual([{ id: 't1' }]);
  });
  it('rejects a standard schema success value that is not a plain object with the bare input code', async () => {
    const stringValueSchema: StandardSchemaV1<{ status: string }, string> = {
      '~standard': { version: 1, vendor: 'test', validate: () => ({ value: 'not-an-object' }) },
    };
    const queries = defineQueries({
      'todos.byStatus': { input: stringValueSchema, plan: q.select('todos', { columns: ['id'] }) },
    });
    const engine = createImpact({ resources, queries, adapter: sqliteAdapter({ database: newDatabase() }) });
    await expect(engine.query('todos.byStatus', { status: 'open' }, context)).rejects.toMatchObject({
      message: 'INVALID_QUERY_INPUT',
    });
  });
});

describe('Standard Schema inputs and verified string caching', () => {
  function profileContract() {
    return defineCacheContract({
      id: 'profiles-standard-schema',
      version: 1,
      queries: [
        {
          operationId: 'profileByUsername',
          endpoint: 'profiles.byUsername',
          kind: 'query' as const,
          input: { username: { type: 'string' as const, required: true } },
          key: { prefix: ['profiles', 'byUsername'], path: ['username'] },
          fallback: ['profiles', 'byUsername'],
        },
      ],
    });
  }
  it('rejects a Standard Schema that transforms a verified string before querying', async () => {
    const database = newDatabase();
    database.exec('pragma foreign_keys=on; create table profiles(id text primary key, username text not null)');
    database.exec("insert into profiles values('1','Alice')");
    // Mirrors the existing `{ parse }` transformer test in cache-contract-consumer.test.ts
    // ("rejects a parser that changes a verified string before querying"), but through a
    // Standard Schema instead of the legacy parser shape.
    const trimmingSchema: StandardSchemaV1<{ username: string }, { username: string }> = {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate: value => {
          const username = (value as { username?: unknown } | null)?.username;
          return typeof username === 'string'
            ? { value: { username: username.trim().toLowerCase() } }
            : { issues: [{ message: 'username must be a string' }] };
        },
      },
    };
    const queries = defineQueries({
      'profiles.byUsername': {
        input: trimmingSchema,
        plan: q.select('profiles', { where: [q.eq('username', q.input('username'))] }),
      },
    });
    const engine = createImpact({
      resources: {
        profiles: { schema: 'main', table: 'profiles', idColumn: 'id', scopeColumn: null, columns: ['id', 'username'] },
      },
      queries,
      adapter: sqliteAdapter({ database }),
      cacheContracts: [profileContract()],
    });
    await engine.validate();
    await expect(engine.query('profiles.byUsername', { username: 'Alice' }, { scope: null })).rejects.toThrow(
      'QUERY_INPUT_PRESERVATION_VIOLATION:username',
    );
  });
});
