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

describe('nested q.call and verified string caching', () => {
  const profileResources: Resources = {
    profiles: { schema: 'main', table: 'profiles', idColumn: 'id', scopeColumn: null, columns: ['id', 'username'] },
  };
  const usernameSchema: StandardSchemaV1<{ username: string }, { username: string }> = {
    '~standard': {
      version: 1,
      vendor: 'test',
      validate: value => {
        const username = (value as { username?: unknown } | null)?.username;
        return typeof username === 'string'
          ? { value: { username } }
          : { issues: [{ message: 'username must be a string' }] };
      },
    },
  };
  const loweringSchema: StandardSchemaV1<{ username: string }, { username: string }> = {
    '~standard': {
      version: 1,
      vendor: 'test',
      validate: value => {
        const username = (value as { username?: unknown } | null)?.username;
        return typeof username === 'string'
          ? { value: { username: username.toLowerCase() } }
          : { issues: [{ message: 'username must be a string' }] };
      },
    },
  };
  const operationIds = {
    'profiles.byUsername': 'profileByUsername',
    'profiles.viaCall': 'profileViaCall',
    'profiles.viaMappedCall': 'profileViaMappedCall',
    'profiles.viaBind': 'profileViaBind',
    'profiles.viaMappedAncestor': 'profileViaMappedAncestor',
  } as const;
  type ContractEndpoint = keyof typeof operationIds;
  function nestedContract(endpoints: readonly ContractEndpoint[]) {
    return defineCacheContract({
      id: 'profiles-nested-call',
      version: 1,
      queries: endpoints.map(endpoint => ({
        operationId: operationIds[endpoint],
        endpoint,
        kind: 'query' as const,
        input: { username: { type: 'string' as const, required: true } },
        key: { prefix: ['profiles', endpoint], path: ['username'] },
        fallback: ['profiles', endpoint],
      })),
      // Coverage is mandatory, so an endpoint this scenario does not declare is recorded as one the
      // client never calls rather than left out of the contract.
      excludedEndpoints: (Object.keys(operationIds) as ContractEndpoint[])
        .filter(endpoint => !endpoints.includes(endpoint))
        .map(endpoint => ({ endpoint, reason: 'not-consumed' as const })),
    });
  }
  async function nestedEngine(
    inner: StandardSchemaV1<{ username: string }, { username: string }>,
    declared: readonly ContractEndpoint[],
  ) {
    const database = newDatabase();
    database.exec('pragma foreign_keys=on; create table profiles(id text primary key, username text not null)');
    database.exec("insert into profiles values('1','alice')");
    const queries = defineQueries({
      'profiles.byUsername': {
        input: inner,
        plan: q.select('profiles', { where: [q.eq('username', q.input('username'))] }),
      },
      // No input mapper, so compileManifest keeps the nested binding and the outer endpoint
      // claims a narrow selector on `username`.
      'profiles.viaCall': { input: usernameSchema, plan: q.call('profiles.byUsername') },
      // The direct select keeps this endpoint's own proven binding on `username`, while the mapped
      // call ends the identity chain, so `readsFor` drops the bindings reached through it.
      'profiles.viaMappedCall': {
        input: usernameSchema,
        plan: q.combine({
          direct: q.select('profiles', { where: [q.eq('username', q.input('username'))] }),
          mapped: q.call('profiles.byUsername', value => ({ username: String(value.username) })),
        }),
      },
      // `readsFor`'s bind case widens the child's bindings unconditionally, so the calculator emits a
      // value-independent selector here. The child call is an identity call on purpose: the callee's own
      // contract declarations must not reintroduce a check on a path an ancestor already widened.
      'profiles.viaBind': {
        input: usernameSchema,
        plan: q.bind(q.value({ seed: true }), q.call('profiles.byUsername'), () => ({ username: 'Alice' })),
      },
      // Same widened path, reached through a mapper'd ancestor call instead of a bind.
      'profiles.viaMappedAncestor': {
        input: usernameSchema,
        plan: q.call('profiles.viaCall', value => ({ username: String(value.username) })),
      },
    });
    const engine = createImpact({
      resources: profileResources,
      queries,
      adapter: sqliteAdapter({ database }),
      cacheContracts: [nestedContract(declared)],
    });
    await engine.validate();
    return engine;
  }

  it('rejects a nested schema that transforms a verified string, exactly as the direct call does', async () => {
    const engine = await nestedEngine(loweringSchema, ['profiles.byUsername', 'profiles.viaCall']);
    // Both routes reach the same transforming schema; neither may execute SQL on a value the
    // caller's cache key and the impact selector do not carry.
    await expect(engine.query('profiles.byUsername', { username: 'Alice' }, { scope: null })).rejects.toThrow(
      'QUERY_INPUT_PRESERVATION_VIOLATION:username',
    );
    await expect(engine.query('profiles.viaCall', { username: 'Alice' }, { scope: null })).rejects.toThrow(
      'QUERY_INPUT_PRESERVATION_VIOLATION:username',
    );
  });

  it('rejects a transforming callee the contract never names, because the caller endpoint declared it', async () => {
    // The cache key belongs to the endpoint the client called. A contract that names only that
    // endpoint still requires the value reaching the executed SQL to be the one the client supplied,
    // even though no contract names the callee whose schema rewrites it.
    const engine = await nestedEngine(loweringSchema, ['profiles.viaCall']);
    await expect(engine.query('profiles.viaCall', { username: 'Alice' }, { scope: null })).rejects.toThrow(
      'QUERY_INPUT_PRESERVATION_VIOLATION:username',
    );
  });

  it('allows a transforming callee behind an input mapper, where impact has already widened', async () => {
    // Guards against over-correcting: the mapper ends the identity chain, `readsFor` dropped the
    // bindings reached through it, so the callee's transform cannot desynchronize any selector.
    const engine = await nestedEngine(loweringSchema, ['profiles.viaMappedCall']);
    expect(await engine.query('profiles.viaMappedCall', { username: 'Alice' }, { scope: null })).toEqual({
      direct: [],
      mapped: [{ id: '1', username: 'alice' }],
    });
  });

  it('allows a transforming callee under q.bind even when a contract names that callee', async () => {
    // The reproduced regression: `q.bind` widens its child's bindings unconditionally, so nothing below
    // can desynchronize a selector, yet the callee's own declaration used to resurrect the check. The
    // contract here never touches the outer endpoint, which is in no contract at all.
    const engine = await nestedEngine(loweringSchema, ['profiles.byUsername']);
    expect(await engine.query('profiles.viaBind', { username: 'Alice' }, { scope: null })).toEqual([
      { id: '1', username: 'alice' },
    ]);
  });

  it("allows a transforming callee below a mapper'd ancestor call that a contract names", async () => {
    // Same widened path as the bind, one level deeper: the mapper is on the ancestor call, and the
    // identity call beneath it must not reintroduce the check from its own declaration.
    const engine = await nestedEngine(loweringSchema, ['profiles.byUsername']);
    expect(await engine.query('profiles.viaMappedAncestor', { username: 'Alice' }, { scope: null })).toEqual([
      { id: '1', username: 'alice' },
    ]);
  });

  it('keeps a non-transforming nested schema working and still emits the narrow selector', async () => {
    const engine = await nestedEngine(usernameSchema, ['profiles.byUsername', 'profiles.viaCall']);
    expect(await engine.query('profiles.viaCall', { username: 'alice' }, { scope: null })).toEqual([
      { id: '1', username: 'alice' },
    ]);
    const result = await engine.command({ scope: null }, db =>
      db.execute('insert into profiles values(?,?)', ['2', 'alice']),
    );
    expect(result.impact.targets).toContainEqual({
      endpoint: 'profiles.viaCall',
      scope: 'global',
      selector: { kind: 'inputs', values: [{ username: 'alice' }] },
    });
  });

  it('rejects a nested parsed input that is not a plain object', async () => {
    const database = newDatabase();
    database.exec('pragma foreign_keys=on; create table profiles(id text primary key, username text not null)');
    const arraySchema: StandardSchemaV1<{ username: string }, { username: string }> = {
      '~standard': { version: 1, vendor: 'test', validate: () => ({ value: [] as never }) },
    };
    const queries = defineQueries({
      'profiles.byUsername': {
        input: arraySchema,
        plan: q.select('profiles', { where: [q.eq('username', q.input('username'))] }),
      },
      'profiles.viaCall': { input: usernameSchema, plan: q.call('profiles.byUsername') },
    });
    const engine = createImpact({ resources: profileResources, queries, adapter: sqliteAdapter({ database }) });
    await expect(engine.query('profiles.viaCall', { username: 'alice' }, { scope: null })).rejects.toThrow(
      'INVALID_QUERY_INPUT',
    );
  });
});
