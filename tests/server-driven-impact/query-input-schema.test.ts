import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { createImpact, defineQueries, q, type Resources, type StandardSchemaV1 } from '@server-driven-impact/runtime';
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
    await expect(fixture().query('todos.byStatus', { status: 1 }, context)).rejects.toMatchObject({
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
});
