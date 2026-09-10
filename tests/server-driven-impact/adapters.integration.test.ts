import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { canonical, matchesInputSelector } from '@server-driven-impact/core';
import { createImpact, q, type CommandDb, type ImpactAdapter } from '@server-driven-impact/runtime';
import { generateObserverMigration,postgresAdapter } from '@server-driven-impact/postgres';
import { compileManifest } from '@server-driven-impact/runtime';
import { sqliteAdapter } from '@server-driven-impact/sqlite';
import { ordersDomain } from '../../examples/orders-impact/domain.js';

const adminUrl = process.env.SDI_POSTGRES_ADMIN_URL;
const runtimeUrl = process.env.SDI_POSTGRES_RUNTIME_URL;
const pgEnabled = Boolean(adminUrl && runtimeUrl);
if (pgEnabled && (new URL(adminUrl!).hostname !== '127.0.0.1' || new URL(adminUrl!).port !== '54332')) throw new Error('LOCAL_FIXTURES_ONLY');
for (const dialect of ['sqlite', 'postgres'] as const) describe.skipIf(dialect === 'postgres' && !pgEnabled)(`${dialect}: common API conformance`, () => {
  const schema = dialect === 'sqlite' ? 'main' : 'sdi_common_' + randomUUID().replaceAll('-', '');
  const definitions = ordersDomain(schema);
  const context = { scope: 'a' };
  let engine: ReturnType<typeof createImpact<CommandDb, typeof definitions.queries>>;
  let cleanup: () => Promise<void>;
  let reset: () => Promise<void>;
  beforeAll(async () => {
    let adapter: ImpactAdapter<CommandDb>;
    if (dialect === 'sqlite') {
      const database = new DatabaseSync(':memory:');
      database.exec(`create table orders(id text primary key,tenant_id text not null,customer_id text,status text not null,priority integer not null,note text);
        create table order_items(id text primary key,tenant_id text not null,order_id text references orders(id) on delete cascade,amount integer not null);`);
      adapter = sqliteAdapter({ database });
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
      adapter = postgresAdapter({ database });
    }
    engine = createImpact({ adapter, ...definitions });
    await engine.validate();
  });
  beforeEach(async () => { await reset(); });
  afterAll(async () => { await cleanup?.(); });
  const order = (id: string) => ({ id, tenant_id: 'a', customer_id: 'first', status: 'ready', priority: 1, note: null });
  it('new membership, OLD/NEW filters, no-match/no-change, nullable filters and supported predicates', async () => {
    const insert = await engine.command(context, db => db.insert('orders', [order('one')], { returnRows: true }));
    expect(insert.data.rows).toMatchObject([{ id: 'one' }]);
    expect(insert.impact.targets.find(t => t.endpoint === 'orders.list')?.selector).toEqual({ kind: 'inputs', values: [{ customer: 'first' }] });
    const moved = await engine.command(context, db => db.update('orders', { where: [q.filter('id', 'in', q.literal(['one']))], set: { customer_id: null }, returnRows: true }));
    expect(moved.data.rows).toMatchObject([{ customer_id: null }]);
    expect(moved.impact.targets.find(t => t.endpoint === 'orders.list')?.selector).toEqual({ kind: 'inputs', values: [{ customer: 'first' }, { customer: null }] });
    expect((await engine.command(context, db => db.update('orders', { where: { customer_id: null }, set: { customer_id: 'second' } }))).data.count).toBe(1);
    for (const id of ['one', 'missing']) expect((await engine.command(context, db => db.update('orders', { where: { id }, set: { status: 'ready' } }))).impact.targets).toEqual([]);
    expect(await engine.command(context, db => db.select('orders', { where: [q.filter('priority', '>=', q.literal(1))], columns: ['id'] }))).toMatchObject({ data: [{ id: 'one' }], impact: { targets: [] } });
  });
  it('join/aggregate results and cascade writes share the registered dependency graph', async () => {
    await engine.command(context, db => db.insert('orders', [order('one')]));
    const insert = await engine.command(context, db => db.insert('items', [{ id: 'item', tenant_id: 'a', order_id: 'one', amount: 42 }]));
    expect(insert.impact.targets.map(t => t.endpoint)).toEqual(['orders.detail', 'orders.total']);
    expect(await engine.query('orders.detail', { id: 'one' }, context)).toMatchObject([{ id: 'one', items: [{ amount: 42 }] }]);
    expect(await engine.query('orders.total', { id: 'one' }, context)).toBe(42);
    const deleted = await engine.command(context, db => db.delete('orders', { where: { id: 'one' } }));
    expect(deleted.impact.targets.map(t => t.endpoint)).toContain('orders.total');
    expect(await engine.query('orders.total', { id: 'one' }, context)).toBe(0);
  });
  it('transaction/savepoint rollback and closed handles cannot publish writes', async () => {
    let captured!: CommandDb;
    await expect(engine.command(context, async db => { captured = db; await db.insert('orders', [order('rolled')]); throw new Error('abort'); })).rejects.toThrow('abort');
    expect(await engine.query('orders.detail', { id: 'rolled' }, context)).toEqual([]);
    await expect(captured.insert('orders', [])).rejects.toThrow('WRITE_CONTEXT_CLOSED');
    const result = await engine.command(context, async db => {
      await expect(db.savepoint(async child => { await child.insert('orders', [order('child')]); throw new Error('child'); })).rejects.toThrow('child');
      await db.savepoint(child => child.insert('orders', [order('kept')]));
    });
    expect(canonical(result.impact)).not.toContain('child');
    expect(await engine.query('orders.detail', { id: 'kept' }, context)).toHaveLength(1);
  });
  it('fixed-seed changes in actual query results always have matching impact metadata', async () => {
    await engine.command(context, db => db.insert('orders', Array.from({ length: 8 }, (_, i) => ({ ...order('seed' + i), priority: i, customer_id: i % 2 ? 'odd' : 'even' }))));
    const inputs: [keyof typeof definitions.queries, Record<string, unknown>][] = [
      ['orders.list', { customer: 'odd' }], ['orders.list', { customer: 'even' }], ['orders.ready', {}],
      ...Array.from({ length: 8 }, (_, i): [keyof typeof definitions.queries, Record<string, unknown>] => ['orders.detail', { id: 'seed' + i }]),
    ];
    let seed = 713;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed >>> 8; };
    for (let i = 0; i < 20; i++) {
      const before = await Promise.all(inputs.map(([endpoint, input]) => engine.query(endpoint, input, context)));
      const changed = await engine.command(context, db => db.update('orders', {
        where: { id: 'seed' + random() % 8 }, set: { status: random() % 2 ? 'ready' : 'draft', priority: random() % 20, customer_id: random() % 2 ? 'odd' : 'even' },
      }));
      const after = await Promise.all(inputs.map(([endpoint, input]) => engine.query(endpoint, input, context)));
      for (let j = 0; j < inputs.length; j++) if (canonical(before[j]) !== canonical(after[j])) {
        expect(changed.impact.targets.some(t => t.endpoint === inputs[j][0] && matchesInputSelector(inputs[j][1], t.selector)), `${i}: ${inputs[j][0]}`).toBe(true);
      }
    }
  });
  it('large writes widen without tracking tables or extra public hooks', async () => {
    const result = await engine.command(context, db => db.insert('orders', Array.from({ length: 210 }, (_, i) => order('bulk' + i))));
    expect(result.data.count).toBe(210);
    expect(result.impact.targets.find(t=>t.endpoint==='orders.detail')?.selector.kind).toBe('all');
    expect(result.impact.targets.find(t=>t.endpoint==='orders.list')?.selector).toEqual({kind:'all'});
    const changed = await engine.command(context, db => db.update('orders', { where: {}, set: { status: 'draft' } }));
    expect(changed.impact.targets.find(t=>t.endpoint==='orders.ready')?.selector.kind).toBe('all');
    expect(changed.impact.targets.find(t=>t.endpoint==='orders.list')?.selector).toEqual({kind:'all'});
  });
});
