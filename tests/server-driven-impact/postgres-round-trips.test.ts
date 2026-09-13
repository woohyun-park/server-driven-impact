import { describe, expect, it, vi } from 'vitest';
import { WriteSet } from '@server-driven-impact/core';
import { postgresAdapter } from '@server-driven-impact/postgres';
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
  const session = {
    unsafe: vi.fn(async (text: string, values?: readonly unknown[]) => {
      calls.push({ text, values });
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
  it('runs an empty command as preamble, commit, drain, and unlock', async () => {
    const { calls, session, database } = fakeDatabase();
    const data = await bound(database).command('tenant-a', new WriteSet(new Set(['rows'])), async () => 'saved');
    expect(data).toBe('saved');
    const texts = calls.map(call => call.text);
    expect(texts).toHaveLength(4);
    expect(texts[0].split(';\n').map(statement => statement.split(' ')[0])).toEqual([
      'set',
      'select',
      'do',
      'commit',
      'begin',
      'select',
    ]);
    expect(texts[0]).toContain('begin isolation level repeatable read');
    expect(texts[0]).toContain("set_config('sdi.request_token'");
    expect(texts[0]).toMatch(/\$sdi_[0-9a-f]{32}\$tenant-a\$sdi_[0-9a-f]{32}\$/);
    expect(calls[0].values).toBeUndefined();
    expect(texts[1]).toBe('commit');
    expect(texts[2]).toMatch(/^delete from pg_temp\.sdi_observed_facts where token=\$1 returning /);
    expect(texts[3]).toBe('select pg_advisory_unlock_shared($1,$2)');
    const token = /'sdi\.request_token','([0-9a-f-]{36})'/.exec(texts[0])?.[1];
    expect(token).toBeDefined();
    expect(calls[2].values).toEqual([token]);
    expect(session.release).toHaveBeenCalledOnce();
  });

  it('keeps business statements between the preamble and commit', async () => {
    const { calls, database } = fakeDatabase();
    await bound(database).command('tenant-a', new WriteSet(new Set(['rows'])), async db => {
      await db.unsafe('update rows set id=id');
    });
    const texts = calls.map(call => call.text);
    expect(texts).toHaveLength(5);
    expect(texts[1]).toBe('update rows set id=id');
    expect(texts[2]).toBe('commit');
  });

  it('honors a configured isolation level inside the preamble', async () => {
    const { calls, database } = fakeDatabase();
    const adapter = postgresAdapter({ database: database as never, isolationLevel: 'read committed' })[bindAdapter](
      resources,
      manifest,
    );
    await adapter.command(null, new WriteSet(new Set(['rows'])), async () => undefined);
    expect(calls[0].text).toContain('begin isolation level read committed');
    expect(calls[0].text).toMatch(/\$sdi_[0-9a-f]{32}\$null\$sdi_[0-9a-f]{32}\$/);
    expect(() => postgresAdapter({ database: database as never, isolationLevel: 'snapshot' as never })).toThrow(
      'INVALID_ISOLATION_LEVEL',
    );
  });

  it('still unlocks and releases the session when the command preamble itself rejects', async () => {
    const calls: { text: string; values?: readonly unknown[] }[] = [];
    let first = true;
    const session = {
      unsafe: vi.fn(async (text: string, values?: readonly unknown[]) => {
        if (first) {
          first = false;
          throw new Error('PREAMBLE_BOOM');
        }
        calls.push({ text, values });
        return [];
      }),
      release: vi.fn(),
    };
    const database = { begin: async () => undefined, reserve: async () => session };
    await expect(
      bound(database).command('tenant-a', new WriteSet(new Set(['rows'])), async () => undefined),
    ).rejects.toThrow('PREAMBLE_BOOM');
    expect(calls.map(call => call.text)).toContain('select pg_advisory_unlock_shared($1,$2)');
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
      'set local client_min_messages = error;\nselect pg_advisory_lock_shared(5456969,20551);\ncommit;\nbegin isolation level repeatable read read only',
      "select set_config('search_path',$1,true)",
      'select 1',
      'select 1',
      'commit',
      'select pg_advisory_unlock_shared($1,$2)',
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
});
