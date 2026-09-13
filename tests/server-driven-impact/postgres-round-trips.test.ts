import { describe, expect, it, vi } from 'vitest';
import { WriteSet } from '@server-driven-impact/core';
import { postgresAdapter } from '@server-driven-impact/postgres';
import { bindAdapter, type QueryManifest, type Resources } from '@server-driven-impact/runtime/adapter';

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
    expect(texts[0]).toContain('$tenant-a$');
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
    expect(calls[0].text).toContain('$null$');
    expect(() => postgresAdapter({ database: database as never, isolationLevel: 'snapshot' as never })).toThrow(
      'INVALID_ISOLATION_LEVEL',
    );
  });
});
