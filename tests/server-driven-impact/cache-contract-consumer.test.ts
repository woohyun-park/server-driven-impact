import { describe, expect, expectTypeOf, it } from 'vitest';
import { QueryClient, QueryObserver, matchQuery } from '@tanstack/query-core';
import { generateOperationKey } from '@orpc/tanstack-query';
import { matchesInputSelector, ImpactUnavailableError, type ImpactSet } from '@server-driven-impact/core';
import {
  buildQueryKey,
  prepareCacheQuery,
  buildQueryExecutionInput,
  compileCacheInvalidations,
  defineCacheContract,
  validateCacheContractCoverage,
  type CacheContract,
  type CacheDiagnostic,
  type CacheInputField,
} from '@server-driven-impact/cache-contract';
import { applyCacheInvalidations } from '@server-driven-impact/tanstack-query';
import {
  createImpact,
  defineQueries,
  q,
  type CommandOptions,
  type CommandResult,
  type CommandInvalidationResult,
} from '@server-driven-impact/runtime';
import { bindAdapter, type ImpactAdapter } from '@server-driven-impact/runtime/adapter';
import { sqliteAdapter } from '@server-driven-impact/sqlite';
import { DatabaseSync } from 'node:sqlite';
import { consumeCommittedReply } from '../../examples/cache-contract-consumer.ts';

const path = ['data', 'session', 'profile', 'getProfileUserInfo'];
function rpcContract(input: Record<string, CacheInputField> = { userId: { type: 'string', required: true } }) {
  return defineCacheContract({
    id: 'rpc',
    version: 1,
    queries: (['query', 'infinite'] as const).map(kind => ({
      operationId: kind,
      endpoint: 'profile.getProfileUserInfo',
      kind,
      input,
      ...(kind === 'infinite' ? { pageInput: { cursor: { type: 'string' as const, nullable: true } } } : {}),
      key: {
        template: {
          kind: 'array' as const,
          items: [
            { kind: 'literal' as const, value: path },
            {
              kind: 'object' as const,
              fields: { input: { kind: 'inputs' as const }, type: { kind: 'literal' as const, value: kind } },
            },
          ],
        },
      },
      fallback: [path, { type: kind }],
    })),
  });
}
function impact(
  value: Record<string, string | number | boolean | null>,
  endpoint = 'profile.getProfileUserInfo',
): ImpactSet {
  return {
    protocolVersion: 1,
    targets: [{ endpoint, scope: 'caller', selector: { kind: 'inputs', values: [value] } }],
  };
}
const all: ImpactSet = {
  protocolVersion: 1,
  targets: [{ endpoint: 'profile.getProfileUserInfo', scope: 'caller', selector: { kind: 'all' } }],
};
const scope = { contract: { id: 'rpc', version: 1 }, scope: 'tenant' };

describe('generic nested cache contracts', () => {
  it('generates actual oRPC query/infinite keys without an oRPC runtime dependency', () => {
    const contract = rpcContract();
    for (const kind of ['query', 'infinite'] as const) {
      expect(buildQueryKey(contract, kind, { userId: 'user-a' })).toEqual(
        generateOperationKey(path, { input: { userId: 'user-a' }, type: kind }),
      );
    }
    expect(() =>
      defineCacheContract({
        ...contract,
        queries: contract.queries.map(query => ({ ...query, key: contract.queries[0].key, fallback: [path] })),
      }),
    ).toThrow('CACHE_KEY_COLLISION');
  });
  it('retains structured values and normalizes ordered vs set inputs explicitly', () => {
    const input: Record<string, CacheInputField> = {
      missionIds: { type: 'array', items: { type: 'string' }, required: true },
      targetUserIds: { type: 'array', items: { type: 'string' }, order: 'set', required: true },
      filters: {
        type: 'object',
        properties: {
          uid: { type: 'object', properties: { in: { type: 'array', items: { type: 'string' } } } },
          isActive: { type: 'boolean' },
        },
        required: true,
      },
      optional: { type: 'string', nullable: true },
    };
    const contract = rpcContract(input);
    const raw = {
      missionIds: ['b', 'a', 'b'],
      targetUserIds: ['b', 'a', 'b'],
      filters: { uid: { in: ['user-a'] }, isActive: true },
    };
    const prepared = prepareCacheQuery(contract, 'query', raw);
    expect(prepared.input).toEqual({ ...raw, targetUserIds: ['a', 'b'] });
    expect(prepared.queryKey).toEqual(generateOperationKey(path, { input: prepared.input, type: 'query' }));
    expect(buildQueryKey(contract, 'query', { ...raw, optional: null })).not.toEqual(prepared.queryKey);
    expect(buildQueryKey(contract, 'query', { ...raw, missionIds: ['a', 'b', 'b'] })).not.toEqual(prepared.queryKey);
    expect(() => buildQueryKey(contract, 'query', { ...raw, filters: { unknown: 1 } })).toThrow('UNKNOWN_CACHE_INPUT');
    expect(() => buildQueryKey(contract, 'query', { ...raw, missionIds: [undefined] })).toThrow(
      'CACHE_ARRAY_ITEM_REQUIRED',
    );
  });
  it('separates infinite identity from execution-only page inputs', () => {
    const contract = rpcContract();
    const key = buildQueryKey(contract, 'infinite', { userId: 'user-a' });
    expect(buildQueryExecutionInput(contract, 'infinite', { userId: 'user-a' }, { cursor: 'page-2' })).toEqual({
      userId: 'user-a',
      cursor: 'page-2',
    });
    expect(buildQueryKey(contract, 'infinite', { userId: 'user-a' })).toEqual(key);
    expect(() => buildQueryKey(contract, 'infinite', { userId: 'user-a', cursor: 'page-2' })).toThrow(
      'UNKNOWN_CACHE_INPUT',
    );
    expect(() => buildQueryExecutionInput(contract, 'query', { userId: 'user-a' }, {})).toThrow(
      'CACHE_PAGE_INPUT_REQUIRES_INFINITE',
    );
    const diagnostics: CacheDiagnostic[] = [];
    compileCacheInvalidations(contract, impact({ cursor: 'page-2' }), 'tenant', {
      explain: value => diagnostics.push(value),
    });
    expect(diagnostics.some(value => value.reason === 'page-input')).toBe(true);
  });
  it('supports endpoint/domain prefixes and preserves query/infinite isolation', async () => {
    const contract = rpcContract({ userId: { type: 'number', required: true } });
    const client = new QueryClient();
    const keys = [
      buildQueryKey(contract, 'query', { userId: 1 }),
      buildQueryKey(contract, 'query', { userId: 2 }),
      buildQueryKey(contract, 'infinite', { userId: 1 }),
    ];
    for (const key of keys) client.setQueryData(key, 'cached');
    const result = compileCacheInvalidations(contract, impact({ userId: 1 }), 'tenant');
    expect(result.invalidations).toEqual(keys.filter((_, i) => i !== 1).map(queryKey => ({ queryKey, exact: true })));
    await applyCacheInvalidations(client, result, scope);
    expect(keys.map(key => client.getQueryState(key)?.isInvalidated)).toEqual([true, false, true]);
    await applyCacheInvalidations(client, compileCacheInvalidations(contract, all, 'tenant'), scope);
    expect(client.getQueryState(keys[1])?.isInvalidated).toBe(true);
    const domain = defineCacheContract({
      ...contract,
      queries: contract.queries.map(query => ({ ...query, fallback: [['data', 'session', 'profile']] })),
    });
    expect(compileCacheInvalidations(domain, all, 'tenant').invalidations).toEqual([
      { queryKey: [['data', 'session', 'profile']], exact: false },
    ]);
    expect(() =>
      defineCacheContract({ ...contract, queries: [{ ...contract.queries[0], fallback: [['unrelated']] }] }),
    ).toThrow('CACHE_FALLBACK_NOT_PROVEN');
    client.clear();
  });
  it('requires explicit coverage and reports unknown impact endpoints', () => {
    const contract = rpcContract();
    const endpoints = [
      { endpoint: 'profile.getProfileUserInfo', cache: 'cacheable' as const },
      { endpoint: 'clock', cache: 'no-store' as const },
      { endpoint: 'admin', cache: 'cacheable' as const },
    ];
    expect(() => validateCacheContractCoverage(contract, endpoints)).toThrow('CACHE_ENDPOINT_UNCOVERED:clock');
    const covered = defineCacheContract({
      ...contract,
      excludedEndpoints: [
        { endpoint: 'clock', reason: 'no-store' },
        { endpoint: 'admin', reason: 'not-consumed' },
      ],
    });
    expect(() => validateCacheContractCoverage(covered, endpoints)).not.toThrow();
    expect(compileCacheInvalidations(covered, impact({}, 'clock'), 'tenant').invalidations).toEqual([]);
    expect(() => compileCacheInvalidations(covered, impact({}, 'typo'), 'tenant')).toThrow(
      'CACHE_ENDPOINT_UNCOVERED:typo',
    );
    expect(() =>
      validateCacheContractCoverage(contract, [{ endpoint: 'profile.getProfileUserInfo', cache: 'no-store' }]),
    ).toThrow('CACHE_ENDPOINT_REQUIRES_NO_STORE');
  });
  it('explains widening without exposing values and respects the response budget', () => {
    const diagnostics: CacheDiagnostic[] = [];
    const contract = rpcContract({ userId: { type: 'string' } });
    const result = compileCacheInvalidations(contract, impact({ userId: 'private-user-id' }), 'tenant', {
      explain: value => diagnostics.push(value),
    });
    expect(diagnostics.every(value => value.reason === 'missing-field')).toBe(true);
    expect(JSON.stringify(diagnostics)).not.toContain('private-user-id');
    expect(result.invalidations.every(value => !value.exact)).toBe(true);
    const numeric = rpcContract({ userId: { type: 'number', required: true } });
    const many: ImpactSet = {
      protocolVersion: 1,
      targets: [
        {
          endpoint: 'profile.getProfileUserInfo',
          scope: 'caller',
          selector: { kind: 'inputs', values: [{ userId: 1 }, { userId: 2 }] },
        },
      ],
    };
    diagnostics.length = 0;
    expect(
      compileCacheInvalidations(numeric, many, 'tenant', {
        maxInvalidations: 2,
        explain: value => diagnostics.push(value),
      }).invalidations,
    ).toHaveLength(2);
    expect(diagnostics.some(value => value.reason === 'budget')).toBe(true);
    expect(() => compileCacheInvalidations(numeric, all, 'tenant', { maxBytes: 1 })).toThrow(
      'CACHE_INVALIDATION_LIMIT',
    );
  });
  it('never excludes a protocol-1 matching input across omission, defaults and scalar coercion', () => {
    const fixtures: { field: CacheInputField; values: unknown[]; selectors: (string | number | boolean | null)[] }[] = [
      {
        field: { type: 'string', required: true },
        values: ['x', 'X', 'x ', '1', '01', 'true'],
        selectors: ['x', 'X', 'x ', 1, true],
      },
      { field: { type: 'number', required: true }, values: [0, 1, 2], selectors: [1, '01', '1 ', true, null] },
      { field: { type: 'boolean', required: true }, values: [true, false], selectors: [true, 'TRUE', 'false', 1] },
      { field: { type: 'number', default: 9 }, values: [undefined, 1, 9], selectors: [1, '1'] },
      { field: { type: 'string', nullable: true }, values: [undefined, null, 'x'], selectors: [null, 'x'] },
      {
        field: { type: 'string', required: true, enum: ['a', 'A', 'b'] },
        values: ['a', 'A', 'b'],
        selectors: ['a', 'b'],
      },
    ];
    for (const fixture of fixtures) {
      const contract = rpcContract({ userId: fixture.field });
      for (const expected of fixture.selectors) {
        const source = impact({ userId: expected });
        const result = compileCacheInvalidations(contract, source, 'tenant');
        for (const value of fixture.values) {
          const input = value === undefined ? {} : { userId: value };
          if (!matchesInputSelector(input, source.targets[0].selector)) continue;
          const client = new QueryClient();
          const key = buildQueryKey(contract, 'query', input);
          client.setQueryData(key, 1);
          const query = client.getQueryCache().find({ queryKey: key })!;
          expect(
            result.invalidations.some(filter => matchQuery(filter, query)),
            JSON.stringify({ fixture, expected, input }),
          ).toBe(true);
          client.clear();
        }
      }
    }
  });
  it('does not overlook optional secondary params even with an anchor', () => {
    const contract = defineCacheContract({
      id: 'flat',
      version: 1,
      queries: [
        {
          operationId: 'list',
          endpoint: 'profile.getProfileUserInfo',
          kind: 'query',
          input: { id: { type: 'number' }, page: { type: 'number' } },
          key: { prefix: ['list'], params: ['id', 'page'], paramsAnchor: ['id'], omitEmptyParams: true },
          fallback: ['list'],
        },
      ],
    });
    expect(compileCacheInvalidations(contract, impact({ id: 1, page: 2 }), 'tenant').invalidations).toEqual([
      { queryKey: ['list'], exact: false },
    ]);
  });
});

describe('verified string cache precision', () => {
  function profileContract() {
    return defineCacheContract({
      id: 'profiles',
      version: 2,
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
  function profileEngine(
    database: DatabaseSync,
    options: { explain?: (value: CacheDiagnostic) => void; contract?: CacheContract } = {},
  ) {
    const queries = defineQueries({
      'profiles.byUsername': {
        input: { parse: (value: unknown) => value },
        plan: q.select('profiles', { where: [q.eq('username', q.input('username'))] }),
      },
    });
    return createImpact({
      resources: {
        profiles: {
          schema: 'main',
          table: 'profiles',
          idColumn: 'id',
          scopeColumn: null,
          columns: ['id', 'username', 'birthday'],
        },
      },
      queries,
      adapter: sqliteAdapter({ database }),
      cacheContracts: [options.contract ?? profileContract()],
      cacheInvalidationOptions: options.explain ? { explain: options.explain } : {},
    });
  }

  it('invalidates only OLD and NEW keys after SQLite verifies direct TEXT/BINARY equality', async () => {
    const database = new DatabaseSync(':memory:');
    database.exec(
      'pragma foreign_keys=on; create table profiles(id text primary key,username text not null,birthday text not null)',
    );
    const engine = profileEngine(database);
    await engine.validate();
    await engine.command(
      { scope: null },
      db => db.execute('insert into profiles values(?,?,?)', ['1', '홍길동', '2000-01-01']),
      { cacheContract: { id: 'profiles', version: 2 } },
    );
    const birthday = await engine.command(
      { scope: null },
      db => db.execute('update profiles set birthday=? where id=?', ['2001-01-01', '1']),
      { cacheContract: { id: 'profiles', version: 2 } },
    );
    expect(birthday.cacheInvalidation.invalidations).toEqual([
      { queryKey: ['profiles', 'byUsername', '홍길동'], exact: true },
    ]);
    const renamed = await engine.command(
      { scope: null },
      db => db.execute('update profiles set username=? where id=?', ['홍길순', '1']),
      { cacheContract: { id: 'profiles', version: 2 } },
    );
    expect(renamed.cacheInvalidation.invalidations).toEqual([
      { queryKey: ['profiles', 'byUsername', '홍길동'], exact: true },
      { queryKey: ['profiles', 'byUsername', '홍길순'], exact: true },
    ]);
    database.close();
  });

  it('keeps case, spaces, numeric-looking strings and Unicode forms distinct under BINARY equality', async () => {
    const database = new DatabaseSync(':memory:');
    database.exec(
      'pragma foreign_keys=on; create table profiles(id text primary key,username text not null,birthday text not null)',
    );
    const values = ['Alice', 'alice', 'Alice ', '1', '01', 'é', 'e\u0301'];
    const statement = database.prepare('insert into profiles values(?,?,?)');
    values.forEach((username, index) => statement.run(String(index), username, '2000-01-01'));
    const engine = profileEngine(database);
    await engine.validate();
    for (const username of values) {
      const rows = (await engine.query('profiles.byUsername', { username }, { scope: null })) as { username: string }[];
      expect(rows.map(row => row.username)).toEqual([username]);
    }
    const result = await engine.command(
      { scope: null },
      db => db.execute('update profiles set birthday=? where id=?', ['2001-01-01', '0']),
      { cacheContract: { id: 'profiles', version: 2 } },
    );
    expect(result.cacheInvalidation.invalidations).toEqual([
      { queryKey: ['profiles', 'byUsername', 'Alice'], exact: true },
    ]);
    database.close();
  });

  it('keeps endpoint fallback before validation and for non-BINARY comparison', async () => {
    for (const fixture of [
      {
        schema: 'create table profiles(id text primary key,username text not null,birthday text not null)',
        validate: false,
      },
      {
        schema:
          'create table profiles(id text primary key,username text collate nocase not null,birthday text not null)',
        validate: true,
      },
    ] as const) {
      const diagnostics: CacheDiagnostic[] = [];
      const database = new DatabaseSync(':memory:');
      database.exec('pragma foreign_keys=on; ' + fixture.schema);
      const engine = profileEngine(database, { explain: value => diagnostics.push(value) });
      if (fixture.validate) await engine.validate();
      const result = await engine.command(
        { scope: null },
        db => db.execute('insert into profiles values(?,?,?)', ['1', 'Alice', '2000-01-01']),
        { cacheContract: { id: 'profiles', version: 2 } },
      );
      expect(result.cacheInvalidation.invalidations).toEqual([{ queryKey: ['profiles', 'byUsername'], exact: false }]);
      expect(diagnostics.some(value => value.reason === 'comparison-unproven')).toBe(true);
      database.close();
    }
  });

  it('rejects a parser that changes a verified string before querying', async () => {
    const database = new DatabaseSync(':memory:');
    database.exec(
      'pragma foreign_keys=on; create table profiles(id text primary key,username text not null,birthday text not null)',
    );
    const queries = defineQueries({
      'profiles.byUsername': {
        input: {
          parse: (value: unknown) => ({ username: String((value as { username: unknown }).username).toLowerCase() }),
        },
        plan: q.select('profiles', { where: [q.eq('username', q.input('username'))] }),
      },
    });
    const engine = createImpact({
      resources: {
        profiles: {
          schema: 'main',
          table: 'profiles',
          idColumn: 'id',
          scopeColumn: null,
          columns: ['id', 'username', 'birthday'],
        },
      },
      queries,
      adapter: sqliteAdapter({ database }),
      cacheContracts: [profileContract()],
    });
    await engine.validate();
    await expect(engine.query('profiles.byUsername', { username: 'Alice' }, { scope: null })).rejects.toThrow(
      'QUERY_INPUT_PRESERVATION_VIOLATION:username',
    );
    database.close();
  });
});

describe('post-commit runtime contract', () => {
  function engine(fail: 'impact' | 'cache' | undefined, onCommit: () => void = () => {}) {
    const adapter: ImpactAdapter<null> = {
      [bindAdapter]: () => ({
        validate: async () => {},
        query: async (_scope, work) => work(async () => []),
        command: async (_scope, writes, work) => {
          const data = await work(null);
          onCommit();
          if (fail === 'impact')
            writes.snapshot = () => {
              throw new Error('CALCULATION_FAILED');
            };
          return data;
        },
      }),
    };
    return createImpact({
      resources: { items: { schema: 'main', table: 'items', idColumn: 'id', scopeColumn: null, columns: ['id'] } },
      queries: {
        'profile.getProfileUserInfo': { input: { parse: (value: unknown) => value }, plan: q.select('items') },
      },
      adapter,
      cacheContracts: [rpcContract()],
      cacheInvalidationOptions: fail === 'cache' ? { maxBytes: 1 } : {},
    });
  }
  it.each(['impact', 'cache'] as const)(
    'preserves business data after %s failure without re-executing work',
    async fail => {
      let commits = 0,
        calls = 0;
      const runtime = engine(fail, () => commits++);
      const businessData = { ok: true, id: 'created' };
      const error = await runtime
        .command(
          { scope: 'tenant' },
          async () => {
            calls++;
            return businessData;
          },
          { cacheContract: scope.contract },
        )
        .catch(error => error);
      expect(error).toBeInstanceOf(ImpactUnavailableError);
      expect(error.data).toBe(businessData);
      expect(error.commitState).toBe('committed');
      expect(error.phase).toBe(fail === 'impact' ? 'impact-calculation' : 'cache-invalidation');
      expect(error.impact).toEqual(fail === 'impact' ? undefined : { protocolVersion: 1, targets: [] });
      expect([calls, commits]).toEqual([1, 1]);
    },
  );
  it('snapshots scope and version before awaiting command work', async () => {
    const reference = { id: 'rpc', version: 1 },
      context = { scope: 'tenant' };
    const options = { cacheContract: reference };
    const result = await engine(undefined).command(
      context,
      async () => {
        reference.version = 2;
        context.scope = 'different';
        options.cacheContract = { id: 'different', version: 3 };
        return 42;
      },
      options,
    );
    expect(result.cacheInvalidation).toMatchObject({ contractVersion: 1, scope: 'tenant' });
  });
  it('keeps the logical result and skips compilation without a cache option', async () => {
    // This budget would make any cache output fail, including an empty impact.
    const runtime = engine('cache');
    const work = async () => ({ id: 1 });
    const logical = await runtime.command({ scope: 'tenant' }, work);
    const emptyOptions = await runtime.command({ scope: 'tenant' }, work, {});
    const undefinedOption = await runtime.command({ scope: 'tenant' }, work, { cacheContract: undefined });
    expectTypeOf(logical).toEqualTypeOf<CommandResult<{ id: number }>>();
    expectTypeOf(emptyOptions).toEqualTypeOf<CommandResult<{ id: number }>>();
    expectTypeOf(undefinedOption).toEqualTypeOf<CommandResult<{ id: number }>>();
    expect(logical).toEqual({ data: { id: 1 }, impact: { protocolVersion: 1, targets: [] } });
    expect(emptyOptions).toEqual(logical);
    expect(undefinedOption).toEqual(logical);
    expect(runtime).not.toHaveProperty('commandWithInvalidations');
  });
  it('infers cache output for explicit options and a union for dynamic options', async () => {
    let commits = 0;
    const runtime = engine(undefined, () => commits++);
    const work = async () => ({ id: 1 });
    const cached = await runtime.command({ scope: 'tenant' }, work, { cacheContract: scope.contract });
    expectTypeOf(cached).toEqualTypeOf<CommandInvalidationResult<{ id: number }>>();
    expect(cached.cacheInvalidation).toMatchObject({ contractId: 'rpc', contractVersion: 1, scope: 'tenant' });
    expect(commits).toBe(1);
    const invoke = (options?: CommandOptions) => runtime.command({ scope: 'tenant' }, work, options);
    expectTypeOf<Awaited<ReturnType<typeof invoke>>>().toEqualTypeOf<
      CommandResult<{ id: number }> | CommandInvalidationResult<{ id: number }>
    >();
    expect(await invoke(undefined)).not.toHaveProperty('cacheInvalidation');
    expect(await invoke({ cacheContract: scope.contract })).toHaveProperty('cacheInvalidation');
  });
  it('retains impact failure classification in the two-argument command', async () => {
    const data = { saved: true };
    const error = await engine('impact')
      .command({ scope: 'tenant' }, async () => data)
      .catch(error => error);
    expect(error).toBeInstanceOf(ImpactUnavailableError);
    expect(error.data).toBe(data);
    expect(error).toMatchObject({ commitState: 'committed', phase: 'impact-calculation' });
  });
});

describe('executor lifecycle boundaries', () => {
  it('waits for application callbacks and does not apply responses to a retired session', async () => {
    const client = new QueryClient();
    const key = buildQueryKey(rpcContract(), 'query', { userId: 'user-a' });
    client.setQueryData(key, 'cached');
    let release!: () => void;
    let callbackStarted!: () => void;
    const started = new Promise<void>(resolve => {
      callbackStarted = resolve;
    });
    let current = true;
    const result = consumeCommittedReply({
      response: Promise.resolve({
        commitState: 'committed',
        data: 'saved',
        cacheInvalidation: compileCacheInvalidations(rpcContract(), all, 'tenant'),
      }),
      queryClient: client,
      ...scope,
      isCurrentSession: () => current,
      afterCommit: async () => {
        callbackStarted();
        await new Promise<void>(resolve => {
          release = resolve;
        });
      },
    });
    await started;
    expect(client.getQueryState(key)?.isInvalidated).toBe(false);
    current = false;
    release();
    expect(await result).toEqual({ status: 'retired-session' });
    expect(client.getQueryState(key)?.isInvalidated).toBe(false);
    client.clear();
  });
  it('continues cache synchronization after a failed post-commit callback', async () => {
    const client = new QueryClient();
    const key = buildQueryKey(rpcContract(), 'query', { userId: 'user-a' });
    client.setQueryData(key, 'cached');
    const failure = new Error('CALLBACK_FAILED');
    const result = await consumeCommittedReply({
      response: Promise.resolve({
        commitState: 'committed',
        data: 'saved',
        cacheInvalidation: compileCacheInvalidations(rpcContract(), all, 'tenant'),
      }),
      queryClient: client,
      ...scope,
      isCurrentSession: () => true,
      afterCommit: async () => {
        throw failure;
      },
    });
    expect(result).toEqual({ status: 'committed', data: 'saved', followUpErrors: [failure] });
    expect(client.getQueryState(key)?.isInvalidated).toBe(true);
    client.clear();
  });
  it.each([false, true])('initial fetch overlap: cancelInFlight=%s', async cancelInFlight => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const key = buildQueryKey(rpcContract(), 'query', { userId: 'user-a' });
    let resolveOld!: (value: string) => void;
    let calls = 0;
    const observer = new QueryObserver(client, {
      queryKey: key,
      queryFn: () =>
        ++calls === 1
          ? new Promise<string>(resolve => {
              resolveOld = resolve;
            })
          : Promise.resolve('fresh'),
    });
    const unsubscribe = observer.subscribe(() => {});
    const pending = applyCacheInvalidations(client, compileCacheInvalidations(rpcContract(), all, 'tenant'), {
      ...scope,
      cancelInFlight,
    });
    resolveOld('old');
    await pending;
    expect(client.getQueryData(key)).toBe(cancelInFlight ? 'fresh' : 'old');
    expect(calls).toBe(cancelInFlight ? 2 : 1);
    unsubscribe();
    client.clear();
  });
  it('propagates refetch failure without representing a failed server commit', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const key = buildQueryKey(rpcContract(), 'query', { userId: 'user-a' });
    client.setQueryData(key, 'cached');
    const observer = new QueryObserver(client, {
      queryKey: key,
      staleTime: Infinity,
      queryFn: async () => {
        throw new Error('READ_OFFLINE');
      },
    });
    const unsubscribe = observer.subscribe(() => {});
    const committedResponse = {
      data: { saved: true },
      cacheInvalidation: compileCacheInvalidations(rpcContract(), all, 'tenant'),
    };
    await expect(applyCacheInvalidations(client, committedResponse.cacheInvalidation, scope)).rejects.toThrow(
      'READ_OFFLINE',
    );
    expect(committedResponse.data).toEqual({ saved: true });
    expect(client.getQueryData(key)).toBe('cached');
    unsubscribe();
    client.clear();
  });
});
