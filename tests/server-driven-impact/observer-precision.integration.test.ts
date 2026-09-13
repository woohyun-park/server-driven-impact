import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import postgres from 'postgres';
import { Pool } from 'pg';
import { calculateImpact, LIMITS, matchesInputSelector, WriteSet, type WriteFact } from '@server-driven-impact/core';
import { compileManifest, q, type Resources } from '@server-driven-impact/runtime';
import { bindAdapter } from '@server-driven-impact/runtime/adapter';
import { generateObserverMigration, identifier, postgresAdapter, sql } from '@server-driven-impact/postgres';
import { pgDatabase } from '@server-driven-impact/postgres/pg';
import { sqliteAdapter } from '@server-driven-impact/sqlite';

const adminUrl = process.env.SDI_POSTGRES_ADMIN_URL;
const runtimeUrl = process.env.SDI_POSTGRES_RUNTIME_URL;
const enabled = !!adminUrl && !!runtimeUrl;
if (process.env.SDI_POSTGRES_REQUIRED === '1' && !enabled) throw new Error('POSTGRES_FIXTURES_REQUIRED');
if (enabled && !['127.0.0.1', 'localhost', '::1'].includes(new URL(adminUrl!).hostname))
  throw new Error('LOCAL_FIXTURES_ONLY');
const input = { parse: (value: unknown) => value };
const known = (scope: string, fields: Record<string, string>) => ({ kind: 'known', scope, fields });
const definitions = (schema: string) => {
  const resources: Resources = {
    parents: { schema, table: 'parents', idColumn: 'id', scopeColumn: 'tenant', columns: ['id', 'tenant', 'customer'] },
    children: {
      schema,
      table: 'children',
      idColumn: 'id',
      scopeColumn: 'tenant',
      columns: ['id', 'tenant', 'parent_id'],
    },
    audit: {
      schema,
      table: 'audit',
      idColumn: 'id',
      scopeColumn: 'tenant',
      columns: ['id', 'tenant', 'old_customer', 'new_customer'],
    },
    deferred: {
      schema,
      table: 'deferred',
      idColumn: 'id',
      scopeColumn: 'tenant',
      columns: ['id', 'tenant', 'customer'],
    },
    large: { schema, table: 'large', idColumn: 'id', scopeColumn: 'tenant', columns: ['id', 'tenant', 'customer'] },
    small: { schema, table: 'small', idColumn: 'id', scopeColumn: 'tenant', columns: ['id', 'tenant', 'customer'] },
  };
  const by = (resource: string, column: string, field = column) => ({
    input,
    plan: q.select(resource, { where: [q.eq(column, q.input(field))] }),
  });
  const queries = {
    parent: by('parents', 'customer'),
    child: by('children', 'parent_id'),
    oldAudit: by('audit', 'old_customer'),
    newAudit: by('audit', 'new_customer'),
    deferred: by('deferred', 'customer'),
    largeList: by('large', 'customer'),
    largeDetail: by('large', 'id'),
    small: by('small', 'id'),
  };
  return { resources, manifest: compileManifest(queries, resources) };
};
const rows = (result: unknown): Record<string, unknown>[] =>
  Array.isArray(result) ? result : (result as { rows: Record<string, unknown>[] }).rows;

describe.skipIf(!enabled)('PostgreSQL collected WriteSet completeness and precision', () => {
  const schema = 'sdi_observed_' + randomUUID().replaceAll('-', '');
  const { resources, manifest } = definitions(schema);
  const admin = enabled ? postgres(adminUrl!, { max: 1, prepare: false, onnotice: () => {} }) : undefined!;
  const pool =
    enabled && process.env.SDI_POSTGRES_DRIVER === 'pg'
      ? new Pool({ connectionString: runtimeUrl, max: 1 })
      : undefined;
  const database = enabled
    ? pool
      ? ({ ...pgDatabase(pool), end: () => pool.end() } as unknown as postgres.Sql)
      : postgres(runtimeUrl!, { max: 1, prepare: false, onnotice: () => {} })
    : undefined!;
  const bound = enabled ? postgresAdapter({ database })[bindAdapter](resources, manifest) : undefined!;
  beforeAll(async () => {
    await admin.unsafe(`create schema "${schema}";
      create table "${schema}".parents(id text primary key,tenant text,customer text);
      create table "${schema}".children(id text primary key,tenant text,parent_id text references "${schema}".parents(id) on update cascade on delete cascade);
      create table "${schema}".audit(id text primary key,tenant text,old_customer text,new_customer text);
      create table "${schema}".deferred(id text primary key,tenant text,customer text);
      create table "${schema}".large(id text primary key,tenant text,customer text);
      create table "${schema}".small(id text primary key,tenant text,customer text);
      create function "${schema}".audit_parent() returns trigger language plpgsql as $$begin
        insert into "${schema}".audit values(new.id,new.tenant,old.customer,new.customer);return new;end$$;
      create trigger audit_parent after update on "${schema}".parents for each row execute function "${schema}".audit_parent();
      create function "${schema}".defer_audit() returns trigger language plpgsql as $$begin
        insert into "${schema}".deferred values(new.id,new.tenant,new.new_customer);return new;end$$;
      create constraint trigger defer_audit after insert on "${schema}".audit deferrable initially deferred for each row execute function "${schema}".defer_audit();
      insert into "${schema}".parents values('before','a','A');
      insert into "${schema}".children values('line','a','before');
      insert into "${schema}".large select 'batch-'||n,'a','A' from generate_series(1,${LIMITS.facts + 25}) n;
      grant usage on schema "${schema}" to routine_runtime;
      grant select,insert,update,delete on all tables in schema "${schema}" to routine_runtime;`);
    await admin.unsafe(generateObserverMigration(resources, manifest, { runtimeRole: 'routine_runtime' }));
    await bound.validate();
  });
  afterAll(async () => {
    await database.end();
    await admin.unsafe(`drop schema if exists "${schema}" cascade`);
    await admin.end();
  });

  it('collects committed direct, cascade, trigger and deferred effects with OLD/NEW and discards rolled-back work', async () => {
    const writes = new WriteSet();
    await bound.command('a', writes, async tx => {
      await expect(
        tx.savepoint(async child => {
          await child.execute(sql`update ${identifier(schema)}.parents set customer='discarded' where id='before'`);
          throw new Error('discard');
        }),
      ).rejects.toThrow('discard');
      await tx.execute(sql`update ${identifier(schema)}.parents set id='after',customer='B' where id='before'`);
      expect(rows(await tx.execute(sql`select count(*)::int as n from ${identifier(schema)}.deferred`))[0].n).toBe(0);
      expect(writes.snapshot()).toEqual([]);
    });
    const facts = writes.snapshot();
    expect([...new Set(facts.map(fact => fact.resource))].sort()).toEqual(['audit', 'children', 'deferred', 'parents']);
    expect(JSON.stringify(facts)).not.toContain('discarded');
    expect(facts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          resource: 'parents',
          before: known('a', { id: 'before', tenant: 'a', customer: 'A' }),
          after: { kind: 'absent' },
        }),
        expect.objectContaining({
          resource: 'parents',
          before: { kind: 'absent' },
          after: known('a', { id: 'after', tenant: 'a', customer: 'B' }),
        }),
        expect.objectContaining({
          resource: 'children',
          before: known('a', { id: 'line', tenant: 'a', parent_id: 'before' }),
          after: known('a', { id: 'line', tenant: 'a', parent_id: 'after' }),
          changedColumns: ['parent_id'],
        }),
        expect.objectContaining({
          resource: 'audit',
          operation: 'insert',
          after: known('a', { id: 'after', tenant: 'a', old_customer: 'A', new_customer: 'B' }),
        }),
        expect.objectContaining({
          resource: 'deferred',
          operation: 'insert',
          after: known('a', { id: 'after', tenant: 'a', customer: 'B' }),
        }),
      ]),
    );
    const rollback = new WriteSet();
    await expect(
      bound.command('a', rollback, async tx => {
        await tx.execute(sql`delete from ${identifier(schema)}.parents where id='after'`);
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect(rollback.snapshot()).toEqual([]);
    expect(await admin.unsafe(`select id from "${schema}".children`)).toMatchObject([{ id: 'line' }]);
  });

  it('preserves common batch OLD/NEW scope and bindings without widening a small independent resource', async () => {
    const writes = new WriteSet();
    await bound.command('a', writes, async tx => {
      await tx.execute(sql`insert into ${identifier(schema)}.small values('precise','a','small')`);
      await tx.execute(sql`update ${identifier(schema)}.large set customer='B' where id like 'batch-%'`);
    });
    const facts = writes.snapshot();
    expect(facts).toHaveLength(2);
    expect(facts.find(fact => fact.resource === 'large')).toEqual({
      resource: 'large',
      operation: 'unknown',
      before: known('a', { tenant: 'a', customer: 'A' }),
      after: known('a', { tenant: 'a', customer: 'B' }),
      changedColumns: null,
    });
    expect(facts.find(fact => fact.resource === 'small')?.after).toEqual(known('a', { id: 'precise', tenant: 'a' }));
    const impact = calculateImpact(facts, { resources, manifest, scope: 'a' });
    expect(impact.targets.find(target => target.endpoint === 'largeList')?.selector).toEqual({
      kind: 'inputs',
      values: [{ customer: 'A' }, { customer: 'B' }],
    });
    expect(impact.targets.find(target => target.endpoint === 'largeDetail')?.selector).toEqual({ kind: 'all' });
    expect(impact.targets.find(target => target.endpoint === 'small')?.selector).toEqual({
      kind: 'inputs',
      values: [{ id: 'precise' }],
    });
    expect(calculateImpact(facts, { resources, manifest, scope: 'other' }).targets).toEqual([]);
  });

  it('widens mixed-scope batches so neither caller loses its actual result change', async () => {
    const writes = new WriteSet();
    await bound.command('a', writes, tx =>
      tx.execute(
        sql`insert into ${identifier(schema)}.large select 'mixed-'||n,case when n%2=0 then 'a' else 'b' end,'shared' from generate_series(1,${LIMITS.facts + 25}) n`,
      ),
    );
    const facts = writes.snapshot();
    expect(facts).toEqual([
      {
        resource: 'large',
        operation: 'unknown',
        before: { kind: 'absent' },
        after: { kind: 'unknown' },
        changedColumns: null,
      },
    ]);
    for (const scope of ['a', 'b']) {
      const actual = await admin.unsafe(
        `select count(*)::int as n from "${schema}".large where tenant=$1 and customer='shared'`,
        [scope],
      );
      expect(actual[0].n).toBeGreaterThan(0);
      const impact = calculateImpact(facts, { resources, manifest, scope });
      expect(
        impact.targets.some(
          target => target.endpoint === 'largeList' && matchesInputSelector({ customer: 'shared' }, target.selector),
        ),
      ).toBe(true);
    }
  });
});

it('SQLite collector overflow is resource-local and savepoint rollback cannot poison retained facts', async () => {
  const database = new DatabaseSync(':memory:');
  try {
    database.exec(
      'create table large(id text primary key,tenant text,customer text);create table small(id text primary key,tenant text,customer text);',
    );
    const full = definitions('main');
    const resources = { large: full.resources.large, small: full.resources.small };
    const manifest = compileManifest(
      {
        large: { input, plan: q.select('large', { where: [q.eq('customer', q.input('customer'))] }) },
        small: { input, plan: q.select('small', { where: [q.eq('id', q.input('id'))] }) },
      },
      resources,
    );
    const bound = sqliteAdapter({ database })[bindAdapter](resources, manifest);
    const writes = new WriteSet();
    await bound.command('a', writes, async tx => {
      await expect(
        tx.savepoint(async child => {
          await child.execute(
            `with recursive n(x) as (values(1) union all select x+1 from n where x<${LIMITS.facts + 25}) insert into large select 'discard-'||x,'a','discarded' from n`,
          );
          throw new Error('discard');
        }),
      ).rejects.toThrow('discard');
      await tx.execute("insert into small values('precise','a','kept')");
      await tx.execute(
        `with recursive n(x) as (values(1) union all select x+1 from n where x<${LIMITS.facts + 25}) insert into large select 'kept-'||x,'a','kept' from n`,
      );
    });
    const facts: WriteFact[] = writes.snapshot();
    expect(facts).toHaveLength(2);
    expect(facts.find(fact => fact.resource === 'large')).toEqual({
      resource: 'large',
      operation: 'unknown',
      before: { kind: 'unknown' },
      after: { kind: 'unknown' },
      changedColumns: null,
    });
    expect(facts.find(fact => fact.resource === 'small')?.after).toEqual(known('a', { id: 'precise', tenant: 'a' }));
    expect(database.prepare("select count(*) as n from large where customer='discarded'").get()?.n).toBe(0);
    expect(database.prepare('select count(*) as n from large').get()?.n).toBe(LIMITS.facts + 25);
    const impact = calculateImpact(facts, { resources, manifest, scope: 'a' });
    expect(impact.targets.find(target => target.endpoint === 'large')?.selector).toEqual({ kind: 'all' });
    expect(impact.targets.find(target => target.endpoint === 'small')?.selector).toEqual({
      kind: 'inputs',
      values: [{ id: 'precise' }],
    });
  } finally {
    database.close();
  }
});
