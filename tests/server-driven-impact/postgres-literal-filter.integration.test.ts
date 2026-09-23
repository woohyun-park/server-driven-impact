import { affectedTargets } from './impact-assertions.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { Pool } from 'pg';
import { calculateImpact, WriteSet } from '@server-driven-impact/core';
import { compileManifest, createImpact, q, type Resources } from '@server-driven-impact/runtime';
import { bindAdapter } from '@server-driven-impact/runtime/adapter';
import { generateObserverMigration, identifier, postgresAdapter, sql } from '@server-driven-impact/postgres';
import { pgDatabase } from '@server-driven-impact/postgres/pg';

const adminUrl = process.env.SDI_POSTGRES_ADMIN_URL;
const runtimeUrl = process.env.SDI_POSTGRES_RUNTIME_URL;
const enabled = !!adminUrl && !!runtimeUrl;
if (process.env.SDI_POSTGRES_REQUIRED === '1' && !enabled) throw new Error('POSTGRES_FIXTURES_REQUIRED');
if (enabled && !['127.0.0.1', 'localhost', '::1'].includes(new URL(adminUrl!).hostname))
  throw new Error('LOCAL_FIXTURES_ONLY');
const input = { parse: (value: unknown) => value };

describe.skipIf(!enabled)('PostgreSQL certified literal equality filters', () => {
  const schema = 'sdi_literal_' + randomUUID().replaceAll('-', '');
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
  const resources: Resources = {
    records: {
      schema,
      table: 'records',
      idColumn: 'id',
      scopeColumn: null,
      columns: ['id', 'status', 'customer', 'enabled', 'qty', 'ratio', 'day'],
    },
  };
  const filtered = (column: string, literal: string | number) => ({
    input,
    plan: q.select('records', { columns: ['id'], where: [q.eq(column, q.literal(literal))] }),
  });
  const queries = {
    ready: {
      input,
      plan: q.select('records', {
        columns: ['id'],
        where: [q.eq('status', q.literal('ready')), q.eq('customer', q.input('customer'))],
      }),
    },
    boolean: filtered('enabled', 1),
    integer: filtered('qty', '01'),
    float: filtered('ratio', 0.10000000149011612),
    date: filtered('day', '2026-01-01T00:00:00.000Z'),
  };
  const manifest = compileManifest(queries, resources);
  const adapter = enabled ? postgresAdapter({ database }) : undefined!;
  const bound = enabled ? adapter[bindAdapter](resources, manifest) : undefined!;
  const engine = enabled ? createImpact({ adapter, resources, queries }) : undefined!;
  beforeAll(async () => {
    await admin.unsafe(`create schema "${schema}";
      create table "${schema}".records(id text primary key,status text,customer text,enabled boolean,qty integer,ratio real,day date);
      grant usage on schema "${schema}" to routine_runtime;
      grant select,insert,update,delete on all tables in schema "${schema}" to routine_runtime;`);
    await admin.unsafe(generateObserverMigration(resources, manifest, { runtimeRole: 'routine_runtime' }));
    await engine.validate();
    await bound.validate();
  });
  afterAll(async () => {
    await database.end();
    await admin.unsafe(`drop schema if exists "${schema}" cascade`);
    await admin.end();
  });
  it('prunes unrelated text values but keeps type coercion, float rounding and date normalization safe', async () => {
    const context = { scope: null };
    for (const endpoint of ['boolean', 'integer', 'float', 'date'] as const)
      expect(await engine.query(endpoint, {}, context)).toEqual([]);
    const writes = new WriteSet();
    await bound.command(null, writes, tx =>
      tx.execute(
        sql`insert into ${identifier(schema)}.records values('one','draft','a',true,1,0.100000001,'2026-01-01')`,
      ),
    );
    const facts = writes.snapshot();
    expect(facts).toHaveLength(1);
    if (facts[0].after.kind !== 'known') throw new Error('KNOWN_ROW_EXPECTED');
    expect(facts[0].after.equalityFields).toEqual({ enabled: true, qty: 1, status: 'draft' });
    const impact = calculateImpact(facts, { resources, manifest, scope: null });
    expect(
      affectedTargets(impact)
        .map(target => target.endpoint)
        .sort(),
    ).toEqual(['boolean', 'date', 'float', 'integer']);
    // postgres.js and pg encode a numeric input for a boolean parameter
    // differently. Either execution remains covered by the broad mixed-type fact.
    expect(affectedTargets(impact).some(target => target.endpoint === 'boolean')).toBe(true);
    for (const endpoint of ['integer', 'float', 'date'] as const)
      expect(await engine.query(endpoint, {}, context), endpoint).toEqual([{ id: 'one' }]);
    expect(await engine.query('ready', { customer: 'a' }, context)).toEqual([]);
    const unrelated = await engine.command(context, tx =>
      tx.execute(sql`update ${identifier(schema)}.records set status='archived' where id='one'`),
    );
    expect(affectedTargets(unrelated.impact)).toEqual([]);
    const entered = await engine.command(context, tx =>
      tx.execute(sql`update ${identifier(schema)}.records set status='ready' where id='one'`),
    );
    expect(await engine.query('ready', { customer: 'a' }, context)).toEqual([{ id: 'one' }]);
    expect(affectedTargets(entered.impact)).toEqual([
      { endpoint: 'ready', scope: 'global', selector: { kind: 'inputs', values: [{ customer: 'a' }] } },
    ]);
    const left = await engine.command(context, tx =>
      tx.execute(sql`update ${identifier(schema)}.records set status='draft' where id='one'`),
    );
    expect(await engine.query('ready', { customer: 'a' }, context)).toEqual([]);
    expect(affectedTargets(left.impact)).toEqual(affectedTargets(entered.impact));
  });
});
