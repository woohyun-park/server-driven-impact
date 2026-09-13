import { describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/query-core';
import {
  buildQueryKey,
  cacheContractOpenApiExtension,
  compileCacheInvalidations,
  createCacheContractRegistry,
  defineCacheContract,
  type CacheContract,
  type CacheInvalidationSet,
} from '@server-driven-impact/cache-contract';
import { applyCacheInvalidations } from '@server-driven-impact/tanstack-query';
import type { ImpactSet } from '@server-driven-impact/core';
import { DatabaseSync } from 'node:sqlite';
import { createImpact, defineQueries, q, type Input, type Resources } from '@server-driven-impact/runtime';
import { sqliteAdapter } from '@server-driven-impact/sqlite';

const contract = defineCacheContract({
  id: 'company-api',
  version: 1,
  queries: [
    {
      operationId: 'getA',
      endpoint: 'A.detail',
      kind: 'query',
      input: { id: { type: 'number', required: true, coerce: true } },
      key: { prefix: ['A'], path: ['id'] },
      fallback: ['A'],
    },
    {
      operationId: 'listA',
      endpoint: 'A.list',
      kind: 'query',
      input: { id: { type: 'number', coerce: true }, page: { type: 'number', coerce: true } },
      key: { prefix: ['A', 'list'], params: ['id', 'page'], paramsAnchor: ['id'], omitEmptyParams: true },
      fallback: ['A', 'list'],
    },
  ],
} satisfies CacheContract);

const impact: ImpactSet = {
  protocolVersion: 1,
  targets: [
    { endpoint: 'A.detail', scope: 'caller', selector: { kind: 'inputs', values: [{ id: 1 }] } },
    { endpoint: 'A.list', scope: 'caller', selector: { kind: 'inputs', values: [{ id: 1 }] } },
  ],
};

describe('server-owned cache contracts', () => {
  it('uses one normalization definition for full generated keys and invalidations', () => {
    expect(buildQueryKey(contract, 'getA', { id: '1' })).toEqual(['A', 1]);
    expect(buildQueryKey(contract, 'listA', {})).toEqual(['A', 'list']);
    expect(buildQueryKey(contract, 'listA', { id: '1', page: '2' })).toEqual(['A', 'list', { id: 1, page: 2 }]);
    expect(() => buildQueryKey(contract, 'listA', { page: 2 })).toThrow('CACHE_PARAMS_ANCHOR_REQUIRED');
    expect(() => buildQueryKey(contract, 'listA', { status: 'open' })).toThrow('UNKNOWN_CACHE_INPUT');

    expect(compileCacheInvalidations(contract, impact, 'tenant-a')).toEqual({
      protocolVersion: 1,
      contractId: 'company-api',
      contractVersion: 1,
      scope: 'tenant-a',
      invalidations: [
        { queryKey: ['A', 1], exact: true },
        { queryKey: ['A', 'list'], exact: true },
        { queryKey: ['A', 'list', { id: 1 }], exact: false },
      ],
    });
  });

  it('widens instead of dropping selectors that the key contract cannot prove', () => {
    const result = compileCacheInvalidations(
      contract,
      {
        protocolVersion: 1,
        targets: [{ endpoint: 'A.list', scope: 'caller', selector: { kind: 'inputs', values: [{ status: 'open' }] } }],
      },
      'tenant-a',
    );
    expect(result.invalidations).toEqual([{ queryKey: ['A', 'list'], exact: false }]);
  });

  it('widens when missing-field matches cannot be represented by a partial key', () => {
    const unanchored = defineCacheContract({
      id: 'unanchored',
      version: 1,
      queries: [
        {
          operationId: 'listA',
          endpoint: 'A.list',
          kind: 'query',
          input: { id: { type: 'number' }, page: { type: 'number' } },
          key: { prefix: ['A', 'list'], params: ['id', 'page'], omitEmptyParams: true },
          fallback: ['A', 'list'],
        },
      ],
    });
    expect(
      compileCacheInvalidations(
        unanchored,
        {
          protocolVersion: 1,
          targets: [{ endpoint: 'A.list', scope: 'caller', selector: { kind: 'inputs', values: [{ id: 1 }] } }],
        },
        'tenant-a',
      ).invalidations,
    ).toEqual([{ queryKey: ['A', 'list'], exact: false }]);
  });

  it('rejects unsupported versions and exports data-only OpenAPI metadata', () => {
    const registry = createCacheContractRegistry([contract]);
    expect(registry.resolve({ id: 'company-api', version: 1 })).toBeDefined();
    expect(() => registry.resolve({ id: 'company-api', version: 2 })).toThrow('UNSUPPORTED_CACHE_CONTRACT');
    const extension = cacheContractOpenApiExtension(contract);
    expect(extension).toMatchObject({ contractId: 'company-api', contractVersion: 1 });
    expect(JSON.stringify(extension)).not.toContain('function');
  });

  it('rejects potentially colliding detail and list templates', () => {
    expect(() =>
      defineCacheContract({
        id: 'collision',
        version: 1,
        queries: [
          {
            operationId: 'detail',
            endpoint: 'A.detail',
            kind: 'query',
            input: { id: { type: 'string', required: true } },
            key: { prefix: ['A'], path: ['id'] },
            fallback: ['A'],
          },
          {
            operationId: 'list',
            endpoint: 'A.list',
            kind: 'query',
            input: {},
            key: { prefix: ['A', 'list'] },
            fallback: ['A', 'list'],
          },
        ],
      }),
    ).toThrow('CACHE_KEY_COLLISION');
    expect(() =>
      defineCacheContract({
        id: 'separated',
        version: 1,
        queries: [
          {
            operationId: 'detail',
            endpoint: 'A.detail',
            kind: 'query',
            input: { id: { type: 'string', required: true, exclude: ['list'] } },
            key: { prefix: ['A'], path: ['id'] },
            fallback: ['A'],
          },
          {
            operationId: 'list',
            endpoint: 'A.list',
            kind: 'query',
            input: {},
            key: { prefix: ['A', 'list'] },
            fallback: ['A', 'list'],
          },
        ],
      }),
    ).not.toThrow();
  });

  it('widens the whole endpoint instead of truncating an over-budget response', () => {
    const result = compileCacheInvalidations(
      contract,
      {
        protocolVersion: 1,
        targets: [
          {
            endpoint: 'A.list',
            scope: 'caller',
            selector: { kind: 'inputs', values: Array.from({ length: 600 }, (_, id) => ({ id })) },
          },
        ],
      },
      'tenant-a',
    );
    expect(result.invalidations).toEqual([{ queryKey: ['A', 'list'], exact: false }]);
  });

  it('integrates with the runtime and rejects unsupported versions before mutation', async () => {
    const database = new DatabaseSync(':memory:');
    database.exec('create table A(id integer primary key, tenant text not null)');
    const resources: Resources = {
      A: { schema: 'main', table: 'A', idColumn: 'id', scopeColumn: 'tenant', columns: ['id', 'tenant'] },
    };
    const queries = defineQueries({
      'A.detail': {
        input: {
          parse(value: unknown): Input {
            return value as Input;
          },
        },
        plan: q.select('A', { where: [q.eq('id', q.input('id'))] }),
      },
      'A.list': {
        input: {
          parse(value: unknown): Input {
            return value as Input;
          },
        },
        plan: q.select('A'),
      },
    });
    const engine = createImpact({
      resources,
      queries,
      adapter: sqliteAdapter({ database }),
      cacheContracts: [contract],
    });
    let invoked = false;
    await expect(
      engine.command(
        { scope: 'tenant-a' },
        async () => {
          invoked = true;
        },
        { cacheContract: { id: 'company-api', version: 2 } },
      ),
    ).rejects.toThrow('UNSUPPORTED_CACHE_CONTRACT');
    expect(invoked).toBe(false);
    const result = await engine.command(
      { scope: 'tenant-a' },
      db => db.execute('insert into A(id,tenant) values(?,?)', [1, 'tenant-a']),
      { cacheContract: { id: 'company-api', version: 1 } },
    );
    expect(result.cacheInvalidation.invalidations).toContainEqual({ queryKey: ['A', 1], exact: true });
    database.close();
  });
});

describe('TanStack Query invalidation executor', () => {
  it('invalidates the exact/partial union once and leaves unrelated keys fresh', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const keys = [
      ['A', 1],
      ['A', 2],
      ['A', 'list'],
      ['A', 'list', { id: 1 }],
      ['A', 'list', { id: 1, page: 2 }],
      ['A', 'list', { id: 2 }],
    ] as const;
    for (const key of keys) client.setQueryData(key, 'cached');
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const payload = compileCacheInvalidations(contract, impact, 'tenant-a');

    await applyCacheInvalidations(client, payload, {
      contract: { id: 'company-api', version: 1 },
      scope: 'tenant-a',
      refetchType: 'active',
    });

    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(keys.map(key => client.getQueryState(key)?.isInvalidated)).toEqual([true, false, true, true, true, false]);
  });

  it('rejects stale scope and contract responses before touching the cache', async () => {
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const payload = compileCacheInvalidations(contract, impact, 'old-tenant') as CacheInvalidationSet;
    await expect(
      applyCacheInvalidations(client, payload, {
        contract: { id: 'company-api', version: 1 },
        scope: 'new-tenant',
      }),
    ).rejects.toThrow('CACHE_SCOPE_MISMATCH');
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('rejects malformed network keys before touching the cache', async () => {
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const malformed = {
      protocolVersion: 1,
      contractId: 'company-api',
      contractVersion: 1,
      scope: 'tenant-a',
      invalidations: [{ queryKey: ['A', Number.NaN], exact: false }],
    } as unknown as CacheInvalidationSet;
    await expect(
      applyCacheInvalidations(client, malformed, {
        contract: { id: 'company-api', version: 1 },
        scope: 'tenant-a',
      }),
    ).rejects.toThrow('INVALID_CACHE_INVALIDATION');
    expect(invalidate).not.toHaveBeenCalled();
  });
});
