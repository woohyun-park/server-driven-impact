import { describe, expect, it, vi } from 'vitest';
import { WriteSet } from '@server-driven-impact/core';
import { observerFingerprint, postgresAdapter } from '@server-driven-impact/postgres';
import { observerInternals } from '../../packages/sdi-postgres/src/postgres/observer.js';
import { bindAdapter, type QueryManifest, type Resources } from '@server-driven-impact/runtime/adapter';
import type { PostgresQueryPlan } from '@server-driven-impact/runtime';

const resources: Resources = { rows: { table: 'rows', idColumn: 'id', scopeColumn: null, columns: ['id'] } };
const manifest: QueryManifest = {
  reads: { list: [{ resource: 'rows', columns: '*', bindings: [] }] },
};

// biome-ignore lint/suspicious/noExportsInTest: fakeDatabase is reused by task 4's tests appended to this same file.
export function fakeDatabase() {
  const calls: { text: string; values?: readonly unknown[] }[] = [];
  const fingerprint = observerFingerprint(resources, manifest);
  const definitionHashes = Object.fromEntries(
    ['delete', 'insert', 'truncate', 'update'].map(operation => [
      observerInternals.functionName('rows', operation),
      'hash',
    ]),
  );
  const session = {
    unsafe: vi.fn(async (text: string, values?: readonly unknown[]): Promise<unknown> => {
      calls.push({ text, values });
      if (text.includes('server_version_num')) return [{ version: 180000 }];
      if (text.includes('observer_manifest')) return [{ fingerprint, definition_hashes: definitionHashes }];
      if (text.includes('from pg_trigger'))
        return ['delete', 'insert', 'truncate', 'update'].map(operation => ({
          schema_name: 'public',
          table_name: 'rows',
          tgname: `sdi_observe_${operation}`,
          tgenabled: 'O',
          trigger_type: { insert: 4, delete: 8, update: 16, truncate: 32 }[
            operation as 'insert' | 'delete' | 'update' | 'truncate'
          ],
          function_schema: `sdi_${fingerprint.slice(0, 12)}`,
          function_name: observerInternals.functionName('rows', operation),
          row_level: false,
          before_trigger: false,
          instead_trigger: false,
          tgoldtable: ['delete', 'update'].includes(operation) ? 'sdi_old_rows' : null,
          tgnewtable: ['insert', 'update'].includes(operation) ? 'sdi_new_rows' : null,
          prosecdef: false,
          proconfig: ['search_path=pg_catalog, pg_temp'],
          lanname: 'plpgsql',
          function_hash: 'hash',
        }));
      if (text.includes('pg_class'))
        return [
          {
            oid: '1',
            relkind: 'r',
            relispartition: false,
            relhasrules: false,
            relrowsecurity: false,
            inherited: false,
            pk: ['id'],
            columns: ['id'],
            nondeterministic_collations: [],
          },
        ];
      return [];
    }),
    release: vi.fn(),
  };
  const database = { begin: async () => undefined, reserve: async () => session };
  return { calls, session, database };
}
// biome-ignore lint/suspicious/noExportsInTest: bound is reused by task 4's tests appended to this same file.
export function bound(database: unknown) {
  return postgresAdapter({ database: database as never })[bindAdapter](resources, manifest);
}

describe('PostgreSQL adapter round trips', () => {
  it('drains and seals an empty command before commit without post-commit SQL', async () => {
    const { calls, session, database } = fakeDatabase();
    const adapter = bound(database);
    await adapter.validate();
    calls.length = 0;
    session.release.mockClear();
    const data = await adapter.command('tenant-a', new WriteSet(new Set(['rows'])), async () => 'saved');
    expect(data).toEqual({ data: 'saved', assessment: { endpoints: { list: { status: 'verified' } } } });
    const texts = calls.map(call => call.text);
    expect(texts).toHaveLength(5);
    expect(texts[0].split(';\n').map(statement => statement.split(' ')[0])).toEqual([
      'begin',
      'lock',
      'create',
      'select',
    ]);
    expect(texts[0]).toContain('begin isolation level repeatable read');
    expect(texts[0]).toContain("set_config('sdi.request_token'");
    expect(texts[0]).toMatch(/\$sdi_[0-9a-f]{32}\$tenant-a\$sdi_[0-9a-f]{32}\$/);
    expect(calls[0].values).toBeUndefined();
    expect(texts[1]).toBe('set constraints all immediate');
    expect(texts[2]).toMatch(/^delete from pg_temp\.sdi_observed_facts where token=\$1 returning /);
    expect(texts[3]).toBe("select set_config('sdi.observation_phase','sealed',true)");
    expect(texts[4]).toBe('commit');
    const token = /'sdi\.request_token','([0-9a-f-]{36})'/.exec(texts[0])?.[1];
    expect(token).toBeDefined();
    expect(calls[2].values).toEqual([token]);
    expect(session.release).toHaveBeenCalledOnce();
  });

  it('keeps business statements between the preamble and commit', async () => {
    const { calls, database } = fakeDatabase();
    const adapter = bound(database);
    await adapter.validate();
    calls.length = 0;
    await adapter.command('tenant-a', new WriteSet(new Set(['rows'])), async db => {
      await db.unsafe('update rows set id=id');
    });
    const texts = calls.map(call => call.text);
    expect(texts).toHaveLength(6);
    expect(texts[1]).toBe('update rows set id=id');
    expect(texts[2]).toBe('set constraints all immediate');
    expect(texts[5]).toBe('commit');
  });

  it('honors a configured isolation level inside the preamble', async () => {
    const { calls, database } = fakeDatabase();
    const adapter = postgresAdapter({ database: database as never, isolationLevel: 'read committed' })[bindAdapter](
      resources,
      manifest,
    );
    await adapter.validate();
    calls.length = 0;
    await adapter.command(null, new WriteSet(new Set(['rows'])), async () => undefined);
    expect(calls[0].text).toContain('begin isolation level read committed');
    expect(calls[0].text).toMatch(/\$sdi_[0-9a-f]{32}\$null\$sdi_[0-9a-f]{32}\$/);
    expect(() => postgresAdapter({ database: database as never, isolationLevel: 'snapshot' as never })).toThrow(
      'INVALID_ISOLATION_LEVEL',
    );
  });

  it('rolls back and releases when the command preamble rejects', async () => {
    const { calls, session, database } = fakeDatabase();
    const adapter = bound(database);
    await adapter.validate();
    calls.length = 0;
    session.release.mockClear();
    const implementation = session.unsafe.getMockImplementation()!;
    session.unsafe.mockImplementation(async (text: string, values?: readonly unknown[]) => {
      if (text.startsWith('begin isolation level') && !text.includes('read only')) throw new Error('PREAMBLE_BOOM');
      return implementation(text, values);
    });
    await expect(adapter.command('tenant-a', new WriteSet(new Set(['rows'])), async () => undefined)).rejects.toThrow(
      'PREAMBLE_BOOM',
    );
    expect(calls.map(call => call.text)).toEqual(['rollback']);
    expect(session.release).toHaveBeenCalledOnce();
  });

  it('runs a query transaction with one preamble and sets search_path once', async () => {
    const { calls, database } = fakeDatabase();
    const plan: PostgresQueryPlan = {
      kind: 'postgres-query',
      text: 'select 1',
      parameters: [],
      reads: [],
      searchPath: ['public'],
    };
    await bound(database).query('tenant-a', async select => {
      await select(plan, {});
      await select(plan, {});
      return undefined;
    });
    expect(calls.map(call => call.text)).toEqual([
      'begin isolation level repeatable read read only;\nlock table only "sdi_control"."transaction_gate" in access share mode',
      "select set_config('search_path',$1,true)",
      'select 1',
      'select 1',
      'commit',
    ]);
    expect(calls[1].values).toEqual(['"public"']);
  });

  it('re-sends search_path only when a plan uses a different one', async () => {
    const { calls, database } = fakeDatabase();
    const first: PostgresQueryPlan = {
      kind: 'postgres-query',
      text: 'select 1',
      parameters: [],
      reads: [],
      searchPath: ['public'],
    };
    const second: PostgresQueryPlan = {
      kind: 'postgres-query',
      text: 'select 2',
      parameters: [],
      reads: [],
      searchPath: ['app', 'public'],
    };
    await bound(database).query('tenant-a', async select => {
      await select(first, {});
      await select(second, {});
      await select(first, {});
      return undefined;
    });
    expect(
      calls.map(call => call.text).filter(text => text.startsWith("select set_config('search_path'")),
    ).toHaveLength(3);
    expect(
      calls.filter(call => call.text.startsWith("select set_config('search_path'")).map(call => call.values),
    ).toEqual([['"public"'], ['"app","public"'], ['"public"']]);
  });

  it('uses the single transaction database for queries', async () => {
    const query = fakeDatabase();
    const adapter = postgresAdapter({ database: query.database as never })[bindAdapter](resources, manifest);
    await adapter.query('tenant-a', async () => 'read');
    expect(query.calls.map(call => call.text)).toEqual([
      'begin isolation level repeatable read read only;\nlock table only "sdi_control"."transaction_gate" in access share mode',
      'commit',
    ]);
    expect(query.session.release).toHaveBeenCalledOnce();
  });

  it('reports missing or inaccessible control relations with stable errors on both preambles', async () => {
    const query = fakeDatabase();
    query.session.unsafe.mockRejectedValueOnce(Object.assign(new Error('missing relation'), { code: '42P01' }));
    const adapter = postgresAdapter({ database: query.database as never })[bindAdapter](resources, manifest);
    await expect(adapter.query('tenant-a', async () => undefined)).rejects.toThrow('POSTGRES_CONTROL_NOT_INITIALIZED');
    expect(query.calls.map(call => call.text)).toEqual(['rollback']);

    const command = fakeDatabase();
    const commandAdapter = bound(command.database);
    command.session.unsafe.mockRejectedValueOnce(Object.assign(new Error('missing relation'), { code: '42P01' }));
    const work = vi.fn(async () => undefined);
    await expect(commandAdapter.command('tenant-a', new WriteSet(new Set(['rows'])), work)).rejects.toThrow(
      'POSTGRES_CONTROL_NOT_INITIALIZED',
    );
    command.session.unsafe.mockRejectedValueOnce(
      Object.assign(new Error('permission denied for table validation'), { code: '42501' }),
    );
    await expect(commandAdapter.command('tenant-a', new WriteSet(new Set(['rows'])), work)).rejects.toThrow(
      'POSTGRES_CONTROL_ACCESS_DENIED',
    );
    // validate() reads the snapshot after its own preamble; a gate without the table must map the same way.
    const implementation = command.session.unsafe.getMockImplementation()!;
    let denial: Error & { code: string } = Object.assign(new Error('relation does not exist'), { code: '42P01' });
    command.session.unsafe.mockImplementation(async (text: string, values?: readonly unknown[]) => {
      if (text.includes('as sdi_validation') && !text.includes(';\n')) throw denial;
      return implementation(text, values);
    });
    await expect(commandAdapter.validate()).rejects.toThrow('POSTGRES_CONTROL_NOT_INITIALIZED');
    denial = Object.assign(new Error('permission denied for table validation'), { code: '42501' });
    await expect(commandAdapter.validate()).rejects.toThrow('POSTGRES_CONTROL_ACCESS_DENIED');
    command.session.unsafe.mockImplementation(implementation);
    command.session.unsafe.mockRejectedValueOnce(
      Object.assign(new Error('permission denied to create temporary tables'), { code: '42501' }),
    );
    await expect(commandAdapter.command('tenant-a', new WriteSet(new Set(['rows'])), work)).rejects.toThrow(
      'permission denied to create temporary tables',
    );
    expect(work).not.toHaveBeenCalled();
  });

  it('reads a stored snapshot in the preamble and runs no catalog validation on a first command', async () => {
    const { calls, session, database } = fakeDatabase();
    const implementation = session.unsafe.getMockImplementation()!;
    const row = {
      report: { endpoints: { list: { status: 'verified' } } },
      equality_resources: ['rows'],
      catalog_schemas: ['public'],
      validated_at: '2026-09-28T00:00:00+00:00',
    };
    const stored = { now: '2026-09-28T00:00:01+00:00', row, match: true };
    // postgres.js nests multi-statement results; a single-statement read returns plain rows.
    session.unsafe.mockImplementation(async (text: string, values?: readonly unknown[]) => {
      if (!text.includes('as sdi_validation')) return implementation(text, values);
      calls.push({ text, values });
      return text.includes(';\n') ? [[], [{ sdi_validation: stored }]] : [{ sdi_validation: stored }];
    });
    const adapter = bound(database);
    const data = await adapter.command('tenant-a', new WriteSet(new Set(['rows'])), async () => 'saved');
    expect(data).toEqual({ data: 'saved', assessment: row.report });
    expect(calls.map(call => call.text.split(' ')[0])).toEqual(['begin', 'set', 'delete', 'select', 'commit']);
    // Only the first command of a bound adapter runs the catalog gate.
    expect(calls[0].text).toContain('catalog_hash(');
    calls.length = 0;
    await adapter.command('tenant-a', new WriteSet(new Set(['rows'])), async () => 'saved');
    expect(calls[0].text).not.toContain('catalog_hash(');
    expect(session.release).toHaveBeenCalledTimes(2);
    expect(await adapter.validate()).toMatchObject({ source: 'stored', validatedAt: '2026-09-28T00:00:00.000Z' });
  });

  it('shares one live validation between concurrent first commands', async () => {
    const { calls, database } = fakeDatabase();
    const adapter = bound(database);
    await Promise.all(
      [1, 2, 3].map(() => adapter.command('tenant-a', new WriteSet(new Set(['rows'])), async () => 'saved')),
    );
    expect(calls.filter(call => call.text.includes('observer_manifest'))).toHaveLength(1);
  });

  it('falls back to live validation inside the command transaction before setup when no snapshot matches', async () => {
    const { calls, session, database } = fakeDatabase();
    const setup = vi.fn(async () => undefined);
    const adapter = postgresAdapter({ database: database as never, setup })[bindAdapter](resources, manifest);
    setup.mockImplementation(async () => {
      calls.push({ text: 'setup' });
    });
    const implementation = session.unsafe.getMockImplementation()!;
    session.unsafe.mockImplementation(async (text: string, values?: readonly unknown[]) =>
      text.startsWith('select current_user')
        ? [{ current_role: 'runtime', session_role: 'runtime' }]
        : implementation(text, values),
    );
    await adapter.command('tenant-a', new WriteSet(new Set(['rows'])), async () => 'saved');
    const texts = calls.map(call => call.text);
    expect(texts[0]).toContain('as sdi_validation');
    const started = texts.indexOf('savepoint sdi_validation');
    const released = texts.indexOf('release savepoint sdi_validation');
    expect(started).toBeGreaterThan(0);
    expect(texts.slice(started, released).some(text => text.includes('observer_manifest'))).toBe(true);
    expect(texts.indexOf('setup')).toBeGreaterThan(released);
    expect(texts.at(-1)).toBe('commit');
    expect(session.release).toHaveBeenCalledOnce();
    calls.length = 0;
    await adapter.command('tenant-a', new WriteSet(new Set(['rows'])), async () => 'saved');
    expect(calls.some(call => call.text.includes('observer_manifest'))).toBe(false);
  });

  it('records a live validation only when the catalog hash held across it', async () => {
    for (const [hashes, recorded] of [
      [['h1', 'h1'], true],
      [['h1', 'h2'], false],
    ] as const) {
      const { calls, session, database } = fakeDatabase();
      const implementation = session.unsafe.getMockImplementation()!;
      let hashCall = 0;
      session.unsafe.mockImplementation(async (text: string, values?: readonly unknown[]) => {
        if (text.includes('as sdi_catalog_hash')) {
          calls.push({ text, values });
          return [[], [{ sdi_catalog_hash: hashes[hashCall++] }], []];
        }
        if (text.includes('record_validation(')) {
          calls.push({ text, values });
          return [{ recorded: true }];
        }
        return implementation(text, values);
      });
      await bound(database).command('tenant-a', new WriteSet(new Set(['rows'])), async () => 'saved');
      const record = calls.find(call => call.text.includes('record_validation('));
      expect(!!record).toBe(recorded);
      if (record) expect(record.values?.slice(0, 2)).toEqual([observerFingerprint(resources, manifest), 'h1']);
    }
  });

  it('rejects removed split and connection-mode options at activation', () => {
    const first = fakeDatabase();
    expect(() =>
      postgresAdapter({
        database: first.database,
        connectionMode: 'transaction',
      } as never),
    ).toThrow('POSTGRES_CONNECTION_OPTIONS_REMOVED');
    expect(() =>
      postgresAdapter({
        query: { database: first.database, connectionMode: 'transaction' },
      } as never),
    ).toThrow('POSTGRES_CONNECTION_OPTIONS_REMOVED');
  });
});
