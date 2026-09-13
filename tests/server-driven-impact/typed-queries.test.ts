import { DatabaseSync } from 'node:sqlite';
import { createImpact, defineQueries, q, type Resources, type StandardSchemaV1 } from '@server-driven-impact/runtime';
import { sqliteAdapter } from '@server-driven-impact/sqlite';
import { afterEach, expect, expectTypeOf, it } from 'vitest';

type Todo = { id: string; account_id: string; status: string };
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
const legacyInput = { parse: (value: unknown) => value as { status: string } };
const queries = defineQueries({
  'todos.byStatus': {
    input: statusSchema,
    plan: q.select<Todo>('todos', { where: [q.eq('status', q.input('status'))] }),
  },
  'todos.count': { input: statusSchema, plan: q.count('todos', { where: [q.eq('status', q.input('status'))] }) },
  'todos.summary': { input: statusSchema, plan: q.combine({ rows: q.select<Todo>('todos'), total: q.count('todos') }) },
  'todos.ids': { input: statusSchema, plan: q.map(q.select<Todo>('todos'), rows => rows.map(row => row.id)) },
  'todos.either': { input: statusSchema, plan: q.when(() => true, q.count('todos'), q.value('none')) },
  'todos.legacy': { input: legacyInput, plan: q.select('todos') },
});
const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

it('infers query input and output types from definitions', async () => {
  const database = new DatabaseSync(':memory:');
  databases.push(database);
  database.exec(
    'pragma foreign_keys=on; create table todos(id text primary key, account_id text not null, status text not null)',
  );
  const engine = createImpact({ resources, queries, adapter: sqliteAdapter({ database }) });
  const context = { scope: 'a' };

  expectTypeOf(engine.query('todos.byStatus', { status: 'open' }, context)).resolves.toEqualTypeOf<Todo[]>();
  expectTypeOf(engine.query('todos.count', { status: 'open' }, context)).resolves.toEqualTypeOf<number>();
  expectTypeOf(engine.query('todos.summary', { status: 'open' }, context)).resolves.toEqualTypeOf<{
    rows: Todo[];
    total: number;
  }>();
  expectTypeOf(engine.query('todos.ids', { status: 'open' }, context)).resolves.toEqualTypeOf<string[]>();
  expectTypeOf(engine.query('todos.either', { status: 'open' }, context)).resolves.toEqualTypeOf<number | string>();
  expectTypeOf(engine.query('todos.legacy', { status: 'open' }, context)).resolves.toEqualTypeOf<
    Record<string, unknown>[]
  >();
  expectTypeOf(engine.queryUncached('todos.ids', { status: 'open' }, context)).resolves.toEqualTypeOf<{
    data: string[];
    cachePolicy: 'no-store';
  }>();

  await expect(
    // @ts-expect-error status must be a string
    engine.query('todos.byStatus', { status: 1 }, context),
  ).rejects.toThrow('INVALID_QUERY_INPUT');
  await expect(
    // @ts-expect-error unknown endpoint
    engine.query('todos.missing', { status: 'open' }, context),
  ).rejects.toThrow('UNKNOWN_QUERY');

  expect(await engine.query('todos.ids', { status: 'open' }, context)).toEqual([]);
  expect(await engine.query('todos.count', { status: 'open' }, context)).toBe(0);
});
