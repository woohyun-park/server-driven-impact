import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { canonical, matchesInputSelector } from '@server-driven-impact/core';
import { createImpact, type ImpactAdapter } from '@server-driven-impact/runtime';
import { generateObserverMigration, postgresAdapter, type PostgresCommandDb, Sql, sql, identifier } from '@server-driven-impact/postgres';
import { compileManifest } from '@server-driven-impact/runtime';
import { sqliteAdapter, type SqliteCommandDb } from '@server-driven-impact/sqlite';
import { ordersDomain } from '../../examples/orders-impact/domain.js';

const adminUrl = process.env.SDI_POSTGRES_ADMIN_URL;
const runtimeUrl = process.env.SDI_POSTGRES_RUNTIME_URL;
const pgEnabled = Boolean(adminUrl && runtimeUrl);
if (process.env.SDI_POSTGRES_REQUIRED === '1' && !pgEnabled) throw new Error('POSTGRES_FIXTURES_REQUIRED');
if (pgEnabled && !['127.0.0.1','localhost','::1'].includes(new URL(adminUrl!).hostname)) throw new Error('LOCAL_FIXTURES_ONLY');
type TestDb = PostgresCommandDb | SqliteCommandDb;
const relation = (resource: string) => resource === 'items' ? 'order_items' : resource;
async function insert(dialect: 'sqlite'|'postgres', schema: string, db: TestDb, resource: string, rows: Record<string, unknown>[], returnRows = false) {
  if (!rows.length) return {count: 0, rows: []};
  const names = Object.keys(rows[0]);
  if (dialect === 'sqlite') {
    const values = rows.flatMap(row => names.map(name => row[name] as null|string|number));
    const tuples = rows.map(() => `(${names.map(() => '?').join(',')})`).join(',');
    const result = await (db as SqliteCommandDb).execute(`insert into ${relation(resource)}(${names.join(',')}) values ${tuples} returning *`, values);
    return {count: result.length, rows: returnRows ? result : []};
  }
  const table = sql`${identifier(schema)}.${identifier(relation(resource))}`;
  const columns = names.map(name => `"${name}"`).join(',');
  const parameters = rows.flatMap(row => names.map(name => row[name]));
  const tuples = rows.map((_, row) => `(${names.map((__, column) => `$${row*names.length+column+1}`).join(',')})`).join(',');
  const result = await (db as PostgresCommandDb).execute(new Sql(`insert into ${table.text}(${columns}) values ${tuples} returning *`, parameters));
  return {count: result.length, rows: returnRows ? result : []};
}
async function update(dialect: 'sqlite'|'postgres', schema: string, db: TestDb, resource: string, set: Record<string, unknown>, where: Record<string, unknown>, returnRows = false) {
  const setEntries=Object.entries(set),whereEntries=Object.entries(where),values=[...setEntries,...whereEntries].map(([,value])=>value as null|string|number);
  const marker = (index: number) => dialect === 'sqlite' ? '?' : `$${index}`;
  const assignments=setEntries.map(([name],index)=>`"${name}"=${marker(index+1)}`).join(',');
  const predicate=whereEntries.length?whereEntries.map(([name,value],index)=>value===null?`"${name}" is null`:`"${name}"=${marker(setEntries.length+index+1)}`).join(' and '):'true';
  const bindings=values.filter((_,index)=>index<setEntries.length||whereEntries[index-setEntries.length]?.[1]!==null);
  const table=dialect==='sqlite' ? relation(resource) : `"${schema}"."${relation(resource)}"`;
  const statement=`update ${table} set ${assignments} where ${predicate} returning *`;
  const rows=dialect==='sqlite'
    ? await (db as SqliteCommandDb).execute(statement,bindings)
    : await (db as PostgresCommandDb).execute(new Sql(statement,bindings));
  return {count:rows.length,rows:returnRows?rows:[]};
}
async function remove(dialect: 'sqlite'|'postgres', schema: string, db: TestDb, resource: string, where: Record<string, unknown>) {
  const entries=Object.entries(where),table=dialect==='sqlite' ? relation(resource) : `"${schema}"."${relation(resource)}"`;
  const statement=`delete from ${table} where ${entries.map(([name],index)=>`"${name}"=${dialect==='sqlite'?'?':`$${index+1}`}`).join(' and ')} returning *`;
  const values=entries.map(([,value])=>value as null|string|number);
  const rows=dialect==='sqlite' ? await (db as SqliteCommandDb).execute(statement,values) : await (db as PostgresCommandDb).execute(new Sql(statement,values));
  return {count:rows.length,rows:[]};
}
async function selectPriority(dialect: 'sqlite'|'postgres', db: TestDb, schema: string) {
  if (dialect === 'sqlite') return (db as SqliteCommandDb).execute('select id from orders where priority>=?', [1]);
  return (db as PostgresCommandDb).execute(sql`select id from ${identifier(schema)}.${identifier('orders')} where priority>=${1}`);
}
for (const dialect of ['sqlite', 'postgres'] as const) describe.skipIf(dialect === 'postgres' && !pgEnabled)(`${dialect}: common API conformance`, () => {
  const schema = dialect === 'sqlite' ? 'main' : 'sdi_common_' + randomUUID().replaceAll('-', '');
  const definitions = ordersDomain(schema);
  const context = { scope: 'a' };
  let engine: ReturnType<typeof createImpact<TestDb, typeof definitions.queries>>;
  let cleanup: () => Promise<void>;
  let reset: () => Promise<void>;
  beforeAll(async () => {
    let adapter: ImpactAdapter<TestDb>;
    if (dialect === 'sqlite') {
      const database = new DatabaseSync(':memory:');
      database.exec(`create table orders(id text primary key,tenant_id text not null,customer_id text,status text not null,priority integer not null,note text);
        create table order_items(id text primary key,tenant_id text not null,order_id text references orders(id) on delete cascade,amount integer not null);`);
      adapter = sqliteAdapter({ database }) as ImpactAdapter<TestDb>;
      cleanup = async () => database.close();
      reset = async () => database.exec('delete from order_items; delete from orders');
    } else {
      const admin = postgres(adminUrl!, { max: 1, onnotice: () => {} });
      const database = postgres(runtimeUrl!, { max: 2 });
      cleanup = async () => { await database.end(); await admin.unsafe(`drop schema if exists "${schema}" cascade`); await admin.end(); };
      await admin.unsafe(`create schema "${schema}";
        create table "${schema}".orders(id text primary key,tenant_id text not null,customer_id text,status text not null,priority integer not null,note text);
        create table "${schema}".order_items(id text primary key,tenant_id text not null,order_id text references "${schema}".orders(id) on delete cascade,amount integer not null);
        grant usage on schema "${schema}" to routine_runtime;
        grant select,insert,update,delete on all tables in schema "${schema}" to routine_runtime;`);
      await admin.unsafe(generateObserverMigration(definitions.resources,compileManifest(definitions.queries,definitions.resources),{runtimeRole:'routine_runtime'}));
      reset = async () => { await admin.unsafe(`truncate "${schema}".order_items, "${schema}".orders`); };
      adapter = postgresAdapter({ database }) as ImpactAdapter<TestDb>;
    }
    engine = createImpact({ adapter, ...definitions });
    await engine.validate();
  });
  beforeEach(async () => { await reset(); });
  afterAll(async () => { await cleanup?.(); });
  const order = (id: string) => ({ id, tenant_id: 'a', customer_id: 'first', status: 'ready', priority: 1, note: null });
  it('new membership, OLD/NEW filters, no-match/no-change, nullable filters and supported predicates', async () => {
    const inserted = await engine.command(context, db => insert(dialect, schema, db, 'orders', [order('one')], true));
    expect(inserted.data.rows).toMatchObject([{ id: 'one' }]);
    expect(inserted.impact.targets.find(t => t.endpoint === 'orders.list')?.selector).toEqual({ kind: 'inputs', values: [{ customer: 'first' }] });
    const moved = await engine.command(context, db => update(dialect, schema, db, 'orders', { customer_id: null }, { id: 'one' }, true));
    expect(moved.data.rows).toMatchObject([{ customer_id: null }]);
    expect(moved.impact.targets.find(t => t.endpoint === 'orders.list')?.selector).toEqual({ kind: 'inputs', values: [{ customer: 'first' }, { customer: null }] });
    expect((await engine.command(context, db => update(dialect, schema, db, 'orders', { customer_id: 'second' }, { customer_id: null }))).data.count).toBe(1);
    for (const id of ['one', 'missing']) expect((await engine.command(context, db => update(dialect, schema, db, 'orders', { status: 'ready' }, { id }))).impact.targets).toEqual([]);
    expect(await engine.command(context, db => selectPriority(dialect, db, schema))).toMatchObject({ data: [{ id: 'one' }], impact: { targets: [] } });
  });
  it('join/aggregate results and cascade writes share the registered dependency graph', async () => {
    await engine.command(context, db => insert(dialect, schema, db, 'orders', [order('one')]));
    const inserted = await engine.command(context, db => insert(dialect, schema, db, 'items', [{ id: 'item', tenant_id: 'a', order_id: 'one', amount: 42 }]));
    expect(inserted.impact.targets.map(t => t.endpoint)).toEqual(['orders.detail', 'orders.total']);
    expect(await engine.query('orders.detail', { id: 'one' }, context)).toMatchObject([{ id: 'one', items: [{ amount: 42 }] }]);
    expect(await engine.query('orders.total', { id: 'one' }, context)).toBe(42);
    const deleted = await engine.command(context, db => remove(dialect, schema, db, 'orders', { id: 'one' }));
    expect(deleted.impact.targets.map(t => t.endpoint)).toContain('orders.total');
    expect(await engine.query('orders.total', { id: 'one' }, context)).toBe(0);
  });
  it('transaction/savepoint rollback and closed handles cannot publish writes', async () => {
    let captured!: TestDb;
    await expect(engine.command(context, async db => { captured = db; await insert(dialect, schema, db, 'orders', [order('rolled')]); throw new Error('abort'); })).rejects.toThrow('abort');
    expect(await engine.query('orders.detail', { id: 'rolled' }, context)).toEqual([]);
    await expect(dialect === 'sqlite' ? (captured as SqliteCommandDb).execute('select 1') : (captured as PostgresCommandDb).execute(sql`select 1`)).rejects.toThrow('WRITE_CONTEXT_CLOSED');
    const result = await engine.command(context, async db => {
      await expect(db.savepoint(async child => { await insert(dialect, schema, child, 'orders', [order('child')]); throw new Error('child'); })).rejects.toThrow('child');
      await db.savepoint(child => insert(dialect, schema, child, 'orders', [order('kept')]));
    });
    expect(canonical(result.impact)).not.toContain('child');
    expect(await engine.query('orders.detail', { id: 'kept' }, context)).toHaveLength(1);
  });
  it('fixed-seed changes in actual query results always have matching impact metadata', async () => {
    await engine.command(context, db => insert(dialect, schema, db, 'orders', Array.from({ length: 8 }, (_, i) => ({ ...order('seed' + i), priority: i, customer_id: i % 2 ? 'odd' : 'even' }))));
    const inputs: [keyof typeof definitions.queries, Record<string, unknown>][] = [
      ['orders.list', { customer: 'odd' }], ['orders.list', { customer: 'even' }], ['orders.ready', {}],
      ...Array.from({ length: 8 }, (_, i): [keyof typeof definitions.queries, Record<string, unknown>] => ['orders.detail', { id: 'seed' + i }]),
    ];
    let seed = 713;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed >>> 8; };
    for (let i = 0; i < 20; i++) {
      const before = await Promise.all(inputs.map(([endpoint, input]) => engine.query(endpoint, input, context)));
      const changed = await engine.command(context, db => update(dialect, schema, db, 'orders',
        { status: random() % 2 ? 'ready' : 'draft', priority: random() % 20, customer_id: random() % 2 ? 'odd' : 'even' },
        { id: 'seed' + random() % 8 },
      ));
      const after = await Promise.all(inputs.map(([endpoint, input]) => engine.query(endpoint, input, context)));
      for (let j = 0; j < inputs.length; j++) if (canonical(before[j]) !== canonical(after[j])) {
        expect(changed.impact.targets.some(t => t.endpoint === inputs[j][0] && matchesInputSelector(inputs[j][1], t.selector)), `${i}: ${inputs[j][0]}`).toBe(true);
      }
    }
  });
  it('large writes widen detail while retaining proven common list inputs', async () => {
    const result = await engine.command(context, db => insert(dialect, schema, db, 'orders', Array.from({ length: 210 }, (_, i) => order('bulk' + i))));
    expect(result.data.count).toBe(210);
    expect(result.impact.targets.find(t=>t.endpoint==='orders.detail')?.selector.kind).toBe('all');
    expect(result.impact.targets.find(t=>t.endpoint==='orders.list')?.selector).toEqual(dialect==='postgres' ? {kind:'inputs',values:[{customer:'first'}]} : {kind:'all'});
    const changed = await engine.command(context, db => update(dialect, schema, db, 'orders', { status: 'draft' }, {}));
    expect(changed.impact.targets.find(t=>t.endpoint==='orders.ready')?.selector.kind).toBe('all');
    expect(changed.impact.targets.find(t=>t.endpoint==='orders.list')?.selector).toEqual(dialect==='postgres' ? {kind:'inputs',values:[{customer:'first'}]} : {kind:'all'});
  });
});
