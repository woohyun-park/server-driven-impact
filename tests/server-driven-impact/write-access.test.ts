import { expect, it, vi } from 'vitest';
import { WriteSet } from '@server-driven-impact/core';
import { createImpact, q } from '@server-driven-impact/runtime';
import { observerFingerprint, postgresAdapter, sql } from '@server-driven-impact/postgres';
import { observerInternals } from '../../packages/sdi-postgres/src/postgres/observer.js';
import { compileManifest } from '@server-driven-impact/runtime';
import type postgres from 'postgres';

const resources = {
  parent: {
    table: 'parent',
    idColumn: 'id',
    scopeColumn: null,
    columns: ['id', 'title', 'secret'],
    selectorColumns: ['id'],
  },
};
function fixture(
  commitError?: Error & { code?: string },
  failures: {
    collection?: Error;
    rollback?: Error;
    driverResult?: unknown;
    observerRows?: unknown[];
    validation?: Error;
    independent?: boolean;
    observerMismatch?: string;
  } = {},
) {
  const observedResources = failures.independent
    ? { ...resources, other: { ...resources.parent, table: 'other' } }
    : resources;
  const queries = {
    list: { input: { parse: (v: unknown) => v }, plan: q.select('parent') },
    ...(failures.independent ? { other: { input: { parse: (v: unknown) => v }, plan: q.select('other') } } : {}),
  };
  const fingerprint = observerFingerprint(observedResources, compileManifest(queries, observedResources));
  const definitionHashes = Object.fromEntries(
    Object.keys(observedResources).flatMap(resource =>
      ['delete', 'insert', 'truncate', 'update'].map(operation => [
        observerInternals.functionName(resource, operation),
        'hash',
      ]),
    ),
  );
  const catalogResult = async (text: string) => {
    if (text.includes('server_version_num')) return [{ version: 180000 }];
    if (text.includes('observer_manifest')) return [{ fingerprint, definition_hashes: definitionHashes }];
    if (text.includes('from pg_trigger'))
      return Object.keys(observedResources).flatMap(resource =>
        ['delete', 'insert', 'truncate', 'update'].map(operation => ({
          schema_name: 'public',
          table_name: resource,
          tgname: `sdi_observe_${operation}`,
          tgenabled: failures.observerMismatch === resource ? 'D' : 'O',
          trigger_type: { insert: 4, delete: 8, update: 16, truncate: 32 }[
            operation as 'insert' | 'delete' | 'update' | 'truncate'
          ],
          function_schema: `sdi_${fingerprint.slice(0, 12)}`,
          function_name: observerInternals.functionName(resource, operation),
          row_level: false,
          before_trigger: false,
          instead_trigger: false,
          tgoldtable: ['delete', 'update'].includes(operation) ? 'sdi_old_rows' : null,
          tgnewtable: ['insert', 'update'].includes(operation) ? 'sdi_new_rows' : null,
          prosecdef: false,
          proconfig: ['search_path=pg_catalog, pg_temp'],
          lanname: 'plpgsql',
          function_hash: 'hash',
        })),
      );
    return [
      {
        oid: '1',
        relkind: 'r',
        relispartition: false,
        relhasrules: false,
        relrowsecurity: false,
        inherited: false,
        pk: ['id'],
        columns: ['id', 'title', 'secret'],
      },
    ];
  };
  let commandReadyToCommit = false;
  const tx = {
    unsafe: vi.fn(async (text: string) => {
      if (text.includes('observer_manifest') && failures.validation) throw failures.validation;
      if (text.includes("set_config('sdi.observation_phase','sealed'")) commandReadyToCommit = true;
      if (text === 'commit' && commandReadyToCommit && commitError) throw commitError;
      if (text === 'rollback' && failures.rollback) throw failures.rollback;
      if (text.includes('delete from pg_temp.') && failures.collection) throw failures.collection;
      if (text.includes('delete from pg_temp.') && failures.observerRows) return failures.observerRows;
      if (text === 'update parent set title=title' && failures.driverResult) return failures.driverResult;
      if (
        text.includes('server_version_num') ||
        text.includes('pg_class') ||
        text.includes('pg_trigger') ||
        text.includes('observer_manifest')
      )
        return catalogResult(text);
      return [];
    }),
  };
  const release = vi.fn(async () => undefined),
    discard = vi.fn(async () => undefined);
  const database = {
    unsafe: vi.fn(catalogResult),
    begin: async (_mode: string, work: (tx: unknown) => Promise<unknown>) => work(tx),
    reserve: async () => ({ ...tx, release, discard }),
  };
  const engine = createImpact({
    adapter: postgresAdapter({ database: database as unknown as postgres.Sql }),
    resources: observedResources,
    queries,
  });
  return { engine, release, discard, tx };
}

it('rejects removed CRUD policy and routine options instead of silently ignoring them', () => {
  const database = { begin: () => undefined } as unknown as postgres.Sql;
  expect(() => postgresAdapter({ database, writeAccess: {} } as never)).toThrow(
    'POSTGRES_LEGACY_COMMAND_OPTIONS_REMOVED',
  );
  expect(() => postgresAdapter({ database, routines: {} } as never)).toThrow('POSTGRES_LEGACY_COMMAND_OPTIONS_REMOVED');
});

it('exposes one flat native PostgreSQL command surface', async () => {
  await fixture().engine.command({ scope: 'u' }, async db => {
    expect(Object.keys(db).sort()).toEqual([
      'copyFrom',
      'copyTo',
      'cursor',
      'execute',
      'query',
      'refreshMaterializedView',
      'savepoint',
      'scope',
      'unsafe',
    ]);
    expect(db).not.toHaveProperty('insert');
    expect(db).not.toHaveProperty('postgres');
  });
});

it('reports validation failure and still invokes the command callback', async () => {
  const work = vi.fn(async () => undefined);
  await expect(
    fixture(undefined, { validation: new Error('OBSERVER_MANIFEST_MISMATCH') }).engine.command({ scope: 'u' }, work),
  ).resolves.toMatchObject({
    commitState: 'committed',
    impact: { endpoints: { list: { status: 'unavailable', codes: ['OBSERVER_UNVERIFIED'] } } },
  });
  expect(work).toHaveBeenCalledOnce();
});

it('distinguishes server commit rejection from an unknown network outcome', async () => {
  const network = Object.assign(new Error('connection lost'), { code: 'ECONNRESET' });
  await expect(fixture(network).engine.command({ scope: 'u' }, async () => 1)).rejects.toMatchObject({
    code: 'COMMIT_STATE_UNKNOWN',
    commitState: 'unknown',
  });
  const resolution = Object.assign(new Error('resolution unknown'), { code: '08007' });
  await expect(fixture(resolution).engine.command({ scope: 'u' }, async () => 1)).rejects.toMatchObject({
    code: 'COMMIT_STATE_UNKNOWN',
    commitState: 'unknown',
  });
  const deferred = Object.assign(new Error('deferred constraint'), { code: '23505' });
  await expect(fixture(deferred).engine.command({ scope: 'u' }, async () => 1)).rejects.toBe(deferred);
});

it('rolls back when observation collection fails before commit', async () => {
  const driverResult = Object.assign([] as unknown[], { count: 1, command: 'UPDATE' });
  const { engine, discard, release } = fixture(undefined, {
    collection: new Error('collector unavailable'),
    driverResult,
  });
  const work = vi.fn(db => db.execute(sql`update parent set title=title`));
  let unavailable: unknown;
  try {
    await engine.command({ scope: 'u' }, work);
  } catch (error) {
    unavailable = error;
  }
  expect(unavailable).toMatchObject({ message: 'collector unavailable' });
  expect(work).toHaveBeenCalledTimes(1);
  expect(discard).not.toHaveBeenCalled();
  expect(release).toHaveBeenCalledTimes(2);
});

it('returns committed data with unavailable endpoints when impact conversion fails after commit', async () => {
  const { engine, discard, release } = fixture(undefined, { observerRows: [{}] });
  await expect(engine.command({ scope: 'u' }, async () => 'saved')).resolves.toMatchObject({
    impact: { endpoints: { list: { status: 'unavailable', codes: ['OBSERVATION_FAILED'] } } },
    commitState: 'committed',
    data: 'saved',
  });
  expect(discard).not.toHaveBeenCalled();
  expect(release).toHaveBeenCalledTimes(2);
});

it('discards a connection after rollback failure and preserves the original command failure', async () => {
  const { engine, discard, release } = fixture(undefined, { rollback: new Error('rollback failed') });
  await expect(
    engine.command({ scope: 'u' }, async () => {
      throw new Error('business failed');
    }),
  ).rejects.toThrow('business failed');
  expect(discard).toHaveBeenCalledOnce();
  expect(release).toHaveBeenCalledOnce();
});

it('reuses failed validation until explicit recovery and preserves the exact driver result after observation failure', async () => {
  const driverResult = Object.assign([], { count: 1, command: 'UPDATE' });
  const failures = {
    validation: new Error('OBSERVER_MANIFEST_MISMATCH') as Error | undefined,
    observerRows: [{}],
    driverResult,
  };
  const { engine, tx } = fixture(undefined, failures);
  const work = vi.fn(db => db.execute(sql`update parent set title=title`));
  const first = await engine.command({ scope: null }, work);
  expect(first.data).toBe(driverResult);
  expect(first.impact.endpoints.list).toEqual({
    status: 'unavailable',
    codes: ['OBSERVATION_FAILED', 'OBSERVER_UNVERIFIED'],
  });
  failures.validation = undefined;
  const validations = () => tx.unsafe.mock.calls.filter(([text]) => text.includes('observer_manifest')).length;
  expect(validations()).toBe(1);
  await engine.command({ scope: null }, work);
  expect(validations()).toBe(1);
  failures.observerRows = [];
  expect((await engine.validate()).endpoints.list.status).toBe('verified');
  expect((await engine.command({ scope: null }, work)).impact.endpoints.list).toEqual({
    status: 'verified',
    targets: [],
  });
  expect(work).toHaveBeenCalledTimes(3);
});

it('pins an in-flight command snapshot while revalidation changes subsequent commands', async () => {
  const failures = { validation: undefined as Error | undefined };
  const { engine } = fixture(undefined, failures);
  let resume!: () => void;
  let entered!: () => void;
  const ready = new Promise<void>(resolve => {
    entered = resolve;
  });
  const gate = new Promise<void>(resolve => {
    resume = resolve;
  });
  const pending = engine.command({ scope: null }, async () => {
    entered();
    await gate;
    return 'saved';
  });
  await ready;
  failures.validation = new Error('OBSERVER_MANIFEST_MISMATCH');
  await engine.validate();
  resume();
  expect((await pending).impact.endpoints.list.status).toBe('verified');
  expect((await engine.command({ scope: null }, async () => 'later')).impact.endpoints.list.status).toBe('unavailable');
});

it('last-started validation wins even if an older validation finishes later', async () => {
  const { engine, tx } = fixture();
  const original = tx.unsafe.getMockImplementation()!;
  let resume!: () => void;
  let entered!: () => void;
  const ready = new Promise<void>(resolve => {
    entered = resolve;
  });
  const gate = new Promise<void>(resolve => {
    resume = resolve;
  });
  let first = true;
  tx.unsafe.mockImplementation(async text => {
    if (text.includes('observer_manifest') && first) {
      first = false;
      entered();
      await gate;
      throw new Error('OBSERVER_MANIFEST_MISMATCH');
    }
    return original(text);
  });
  const old = engine.validate();
  await ready;
  expect((await engine.validate()).endpoints.list.status).toBe('verified');
  resume();
  expect((await old).endpoints.list.status).toBe('unavailable');
  expect((await engine.command({ scope: null }, async () => 'saved')).impact.endpoints.list.status).toBe('verified');
});

it('isolates observer mismatch and malformed known-resource observations after complete dependency validation', async () => {
  const { engine } = fixture(undefined, { independent: true, observerMismatch: 'parent' });
  expect((await engine.validate()).endpoints).toEqual({
    list: { status: 'unavailable', codes: ['OBSERVER_UNVERIFIED'] },
    other: { status: 'verified' },
  });
  const saved = await engine.command({ scope: null }, async () => 'saved');
  expect(saved.data).toBe('saved');
  expect(saved.impact.endpoints.other).toEqual({ status: 'verified', targets: [] });
  const observed = fixture(undefined, {
    independent: true,
    observerRows: [
      { resource: 'parent', operation: 'invalid' },
      {
        resource: 'other',
        operation: 'insert',
        before_state: { kind: 'absent' },
        after_state: { kind: 'known', scope: null, fields: { id: 'a' } },
      },
    ],
  });
  const result = await observed.engine.command({ scope: null }, async () => 'saved');
  expect(result.impact.endpoints.list).toEqual({ status: 'unavailable', codes: ['OBSERVATION_FAILED'] });
  expect(result.impact.endpoints.other).toEqual({
    status: 'verified',
    targets: [{ scope: 'global', selector: { kind: 'all' } }],
  });
  const unknown = await fixture(undefined, { independent: true, observerRows: [null] }).engine.command(
    { scope: null },
    async () => 'saved',
  );
  expect(Object.values(unknown.impact.endpoints).every(value => value.status === 'unavailable')).toBe(true);
});

it('preserves committed runtime data when calculation fails without rerunning the callback', async () => {
  const data = { id: 'saved' };
  const work = vi.fn(async () => data);
  const snapshot = vi.spyOn(WriteSet.prototype, 'snapshot').mockImplementation(() => {
    throw new Error('private calculation detail');
  });
  try {
    const result = await fixture().engine.command({ scope: null }, work);
    expect(result.data).toBe(data);
    expect(result.commitState).toBe('committed');
    expect(result.impact.endpoints.list).toEqual({ status: 'unavailable', codes: ['CALCULATION_FAILED'] });
    expect(work).toHaveBeenCalledOnce();
  } finally {
    snapshot.mockRestore();
  }
});
