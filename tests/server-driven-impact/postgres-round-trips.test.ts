import { describe, expect, it, vi } from 'vitest';
import { WriteSet } from '@server-driven-impact/core';
import { observerFingerprint, postgresAdapter } from '@server-driven-impact/postgres';
import { observerInternals } from '../../packages/sdi-postgres/src/postgres/observer.js';
import { bindAdapter, type QueryManifest, type Resources } from '@server-driven-impact/runtime/adapter';
import type { PostgresQueryPlan } from '@server-driven-impact/runtime';

const resources: Resources = { rows: { table: 'rows', idColumn: 'id', scopeColumn: null, columns: ['id'] } };
const manifest: QueryManifest = {
  protocolVersion: 1,
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
    unsafe: vi.fn(async (text: string, values?: readonly unknown[]) => {
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
    expect(data).toBe('saved');
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

  it('reports a missing transaction gate with a stable error', async () => {
    const query = fakeDatabase();
    query.session.unsafe.mockRejectedValueOnce(Object.assign(new Error('missing relation'), { code: '42P01' }));
    const adapter = postgresAdapter({ database: query.database as never })[bindAdapter](resources, manifest);
    await expect(adapter.query('tenant-a', async () => undefined)).rejects.toThrow(
      'POSTGRES_TRANSACTION_GATE_NOT_INITIALIZED',
    );
    expect(query.calls.map(call => call.text)).toEqual(['rollback']);
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
