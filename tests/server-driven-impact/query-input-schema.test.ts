import { affectedTargets } from './impact-assertions.js';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  compileManifest,
  createImpact,
  defineQueries,
  q,
  type Resources,
  type StandardSchemaV1,
} from '@server-driven-impact/runtime';
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
const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});
function database() {
  const db = new DatabaseSync(':memory:');
  databases.push(db);
  return db;
}
function todoEngine() {
  const db = database();
  db.exec(
    'pragma foreign_keys=on; create table todos(id text primary key, account_id text not null, status text not null)',
  );
  db.exec("insert into todos values('t1','a','open'),('t2','a','done')");
  const queries = defineQueries({
    byStatus: {
      input: statusSchema,
      plan: q.select('todos', { columns: ['id'], where: [q.eq('status', q.input('status'))] }),
    },
    viaCall: { input: { parse: (value: unknown) => value as { status: string } }, plan: q.call('byStatus') },
  });
  return createImpact({ resources, queries, adapter: sqliteAdapter({ database: db }) });
}

describe('Standard Schema query inputs', () => {
  it('validates and executes direct and nested queries', async () => {
    const engine = todoEngine();
    expect(await engine.query('byStatus', { status: 'open' }, { scope: 'a' })).toEqual([{ id: 't1' }]);
    expect(await engine.query('viaCall', { status: 'done' }, { scope: 'a' })).toEqual([{ id: 't2' }]);
  });

  it('rejects issues with the input error code and cause', async () => {
    await expect(
      // @ts-expect-error status must be a string
      todoEngine().query('byStatus', { status: 1 }, { scope: 'a' }),
    ).rejects.toMatchObject({
      message: 'INVALID_QUERY_INPUT:status must be a string',
      cause: [{ message: 'status must be a string' }],
    });
  });

  it('awaits asynchronous schema validation', async () => {
    const db = database();
    db.exec(
      'pragma foreign_keys=on; create table todos(id text primary key, account_id text not null, status text not null)',
    );
    db.exec("insert into todos values('t1','a','open')");
    const asyncSchema: StandardSchemaV1<{ status: string }, { status: string }> = {
      '~standard': { version: 1, vendor: 'test', validate: async value => statusSchema['~standard'].validate(value) },
    };
    const queries = defineQueries({
      byStatus: { input: asyncSchema, plan: q.select('todos', { where: [q.eq('status', q.input('status'))] }) },
    });
    const engine = createImpact({ resources, queries, adapter: sqliteAdapter({ database: db }) });
    await expect(engine.query('byStatus', { status: 'open' }, { scope: 'a' })).resolves.toHaveLength(1);
  });

  it('rejects unsupported definitions', () => {
    expect(() =>
      createImpact({
        resources,
        queries: { broken: { input: {} as never, plan: q.select('todos') } },
        adapter: sqliteAdapter({ database: database() }),
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
        adapter: sqliteAdapter({ database: database() }),
      }),
    ).toThrow('UNSUPPORTED_INPUT_SCHEMA_VERSION');
  });
});

describe('query input relation', () => {
  const profileResources: Resources = {
    profiles: { table: 'profiles', idColumn: 'id', scopeColumn: null, columns: ['id', 'username'] },
  };
  const lowering = {
    parse: (value: unknown) => ({ username: (value as { username: string }).username.trim().toLowerCase() }),
  };
  function setup(inputRelation?: 'preserve' | 'opaque') {
    const db = database();
    db.exec('pragma foreign_keys=on; create table profiles(id text primary key, username text not null)');
    db.exec("insert into profiles values('1','alice')");
    const queries = defineQueries({
      byUsername: {
        input: lowering,
        ...(inputRelation ? { inputRelation } : {}),
        plan: q.select('profiles', { where: [q.eq('username', q.input('username'))] }),
      },
    });
    return {
      queries,
      engine: createImpact({ resources: profileResources, queries, adapter: sqliteAdapter({ database: db }) }),
    };
  }

  it('defaults to preserve and rejects a changed selector input', async () => {
    await expect(setup().engine.query('byUsername', { username: ' Alice ' }, { scope: null })).rejects.toThrow(
      'QUERY_INPUT_PRESERVATION_VIOLATION:username',
    );
  });

  it('captures values before a parser mutates the caller input', async () => {
    const db = database();
    db.exec('pragma foreign_keys=on; create table profiles(id text primary key, username text not null)');
    const mutating = {
      parse(value: unknown) {
        const input = value as { username: string };
        input.username = input.username.toLowerCase();
        return input;
      },
    };
    const queries = defineQueries({
      profile: { input: mutating, plan: q.select('profiles', { where: [q.eq('username', q.input('username'))] }) },
    });
    const engine = createImpact({ resources: profileResources, queries, adapter: sqliteAdapter({ database: db }) });
    await expect(engine.query('profile', { username: 'Alice' }, { scope: null })).rejects.toThrow(
      'QUERY_INPUT_PRESERVATION_VIOLATION:username',
    );
  });

  it('allows server normalization when opaque widens the selector', async () => {
    const { engine, queries } = setup('opaque');
    expect(compileManifest(queries, profileResources).reads.byUsername[0].bindings).toEqual([]);
    expect(await engine.query('byUsername', { username: ' Alice ' }, { scope: null })).toEqual([
      { id: '1', username: 'alice' },
    ]);
    const changed = await engine.command({ scope: null }, db =>
      db.execute('update profiles set username=? where id=?', ['alice-2', '1']),
    );
    expect(affectedTargets(changed.impact)).toEqual([
      { endpoint: 'byUsername', scope: 'global', selector: { kind: 'all' } },
    ]);
  });

  it('propagates preservation through calls and widening through opaque callees', async () => {
    const db = database();
    db.exec('pragma foreign_keys=on; create table profiles(id text primary key, username text not null)');
    db.exec("insert into profiles values('1','alice')");
    const base = {
      inner: { input: lowering, plan: q.select('profiles', { where: [q.eq('username', q.input('username'))] }) },
      outer: { input: { parse: (value: unknown) => value as { username: string } }, plan: q.call('inner') },
    };
    const strictQueries = defineQueries(base);
    const strict = createImpact({
      resources: profileResources,
      queries: strictQueries,
      adapter: sqliteAdapter({ database: db }),
    });
    await expect(strict.query('outer', { username: 'Alice' }, { scope: null })).rejects.toThrow(
      'QUERY_INPUT_PRESERVATION_VIOLATION:username',
    );

    const opaqueQueries = defineQueries({ ...base, inner: { ...base.inner, inputRelation: 'opaque' as const } });
    expect(compileManifest(opaqueQueries, profileResources).reads.outer[0].bindings).toEqual([]);
    const widened = createImpact({
      resources: profileResources,
      queries: opaqueQueries,
      adapter: sqliteAdapter({ database: db }),
    });
    await expect(widened.query('outer', { username: 'Alice' }, { scope: null })).resolves.toEqual([
      { id: '1', username: 'alice' },
    ]);
  });
});
