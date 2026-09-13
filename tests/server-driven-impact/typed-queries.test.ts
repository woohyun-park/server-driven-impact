import { DatabaseSync } from 'node:sqlite';
import {
  createImpact,
  defineQueries,
  q,
  type QueryDefinition,
  type Resources,
  type StandardSchemaV1,
} from '@server-driven-impact/runtime';
import { sqliteAdapter } from '@server-driven-impact/sqlite';
import { afterEach, expect, expectTypeOf, it } from 'vitest';

type Todo = { id: string; account_id: string; status: string };
/** Declared as an interface on purpose: q.select must not require an implicit index signature. */
interface TodoRow {
  id: string;
  status: string;
}
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
  'todos.rows': { input: statusSchema, plan: q.select<TodoRow>('todos') },
  // A bare q.call must resolve to unknown, not to the contextual Plan's type argument.
  'todos.viaCall': { input: statusSchema, plan: q.call('todos.count') },
  'todos.viaTypedCall': { input: statusSchema, plan: q.call<Todo[]>('todos.byStatus') },
  'todos.callInCombine': {
    input: statusSchema,
    plan: q.combine({ rows: q.select<Todo>('todos'), other: q.call('todos.count') }),
  },
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
  // An interface row type must be accepted by q.select and survive to the call site.
  expectTypeOf(engine.query('todos.rows', { status: 'open' }, context)).resolves.toEqualTypeOf<TodoRow[]>();
  // A bare q.call keeps its `unknown` default even under a contextual Plan; an explicit argument wins.
  expectTypeOf(engine.query('todos.viaCall', { status: 'open' }, context)).resolves.toEqualTypeOf<unknown>();
  expectTypeOf(engine.query('todos.viaCall', { status: 'open' }, context)).resolves.not.toBeAny();
  expectTypeOf(engine.query('todos.viaTypedCall', { status: 'open' }, context)).resolves.toEqualTypeOf<Todo[]>();
  // An untyped sibling must not poison the typed members of a combine.
  expectTypeOf(engine.query('todos.callInCombine', { status: 'open' }, context)).resolves.toEqualTypeOf<{
    rows: Todo[];
    other: unknown;
  }>();

  // The non-inferring path through the exported public type must be unknown in and unknown out, never any.
  const plain: Record<string, QueryDefinition> = { 'todos.any': { input: statusSchema, plan: q.count('todos') } };
  const loose = createImpact({ resources, queries: plain, adapter: sqliteAdapter({ database }) });
  expectTypeOf<Awaited<ReturnType<typeof loose.query>>>().toEqualTypeOf<unknown>();
  expectTypeOf<Awaited<ReturnType<typeof loose.query>>>().not.toBeAny();
  expectTypeOf<Parameters<typeof loose.query>[1]>().toEqualTypeOf<unknown>();
  expectTypeOf<Parameters<typeof loose.query>[1]>().not.toBeAny();

  // Input side: both definition styles narrow the `input` argument.
  expectTypeOf<Parameters<typeof engine.query<'todos.byStatus'>>[1]>().toEqualTypeOf<{ status: string }>();
  expectTypeOf<Parameters<typeof engine.query<'todos.legacy'>>[1]>().toEqualTypeOf<{ status: string }>();
  expectTypeOf<Parameters<typeof engine.query<'todos.legacy'>>[1]>().not.toBeAny();

  // The { parse } style narrows its input at compile time even though its parser accepts anything at runtime.
  // @ts-expect-error status must be a string
  await engine.query('todos.legacy', { status: 1 }, context);

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
