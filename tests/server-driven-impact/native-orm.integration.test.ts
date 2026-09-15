import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { Pool } from 'pg';
import { eq, sql as dsql } from 'drizzle-orm';
import { createImpact, compileManifest } from '@server-driven-impact/runtime';
import { generateObserverMigration, postgresAdapter, type PostgresPendingQuery } from '@server-driven-impact/postgres';
import { pgAdapter } from '@server-driven-impact/postgres/pg';
import { drizzleAdapter, type DrizzleCommandDb } from '@server-driven-impact/postgres/drizzle';
import { ordersDomain } from '../../examples/orders-impact/domain.js';
import { orderRepository } from '../../examples/orders-impact/drizzle-repository.js';
import { affectedQueries } from '../../examples/orders-impact/consume-impact.js';

const adminUrl = process.env.SDI_POSTGRES_ADMIN_URL,
  runtimeUrl = process.env.SDI_POSTGRES_RUNTIME_URL;
const enabled = !!adminUrl && !!runtimeUrl;
if (enabled && !['127.0.0.1', 'localhost', '::1'].includes(new URL(adminUrl!).hostname))
  throw new Error('LOCAL_FIXTURES_ONLY');
describe.skipIf(!enabled)('native/Drizzle mutation to frontend conformance', () => {
  const schema = 'sdi_native_' + randomUUID().replaceAll('-', '');
  const domain = ordersDomain(schema),
    repository = orderRepository(schema);
  const admin = enabled ? postgres(adminUrl!, { max: 1, prepare: false, onnotice: () => {} }) : undefined!;
  const pool = enabled ? new Pool({ connectionString: runtimeUrl, max: 3 }) : undefined!;
  const database = enabled ? postgres(runtimeUrl!, { max: 3, prepare: false }) : undefined!;
  const setup = async (tx: { unsafe: (text: string, values?: never[]) => PromiseLike<unknown> }, scope: unknown) => {
    await tx.unsafe("select set_config('sdi.tenant',$1,true)", [String(scope)] as never[]);
  };
  const native = enabled ? createImpact({ ...domain, adapter: pgAdapter({ database: pool, setup }) }) : undefined!;
  const tagged = enabled ? createImpact({ ...domain, adapter: postgresAdapter({ database, setup }) }) : undefined!;
  const orm = enabled ? createImpact({ ...domain, adapter: drizzleAdapter({ database: pool, setup }) }) : undefined!;
  beforeAll(async () => {
    await admin.unsafe(`create schema "${schema}";
      create table "${schema}".orders(id text primary key,tenant_id text not null,customer_id text,status text not null,priority integer not null,note text);
      create table "${schema}".order_items(id text primary key,tenant_id text not null,order_id text references "${schema}".orders(id) on delete cascade,amount integer not null);
      grant usage on schema "${schema}" to routine_runtime;
      grant select,insert,update,delete on all tables in schema "${schema}" to routine_runtime;
      alter table "${schema}".orders enable row level security;
      alter table "${schema}".order_items enable row level security;
      create policy tenant on "${schema}".orders to routine_runtime using(tenant_id=current_setting('sdi.tenant',true)) with check(tenant_id=current_setting('sdi.tenant',true));
      create policy tenant on "${schema}".order_items to routine_runtime using(tenant_id=current_setting('sdi.tenant',true)) with check(tenant_id=current_setting('sdi.tenant',true));`);
    await admin.unsafe(
      generateObserverMigration(domain.resources, compileManifest(domain.queries, domain.resources), {
        runtimeRole: 'routine_runtime',
      }),
    );
    await orm.validate();
  });
  afterAll(async () => {
    await pool.end();
    await database.end();
    await admin.unsafe(`drop schema if exists "${schema}" cascade`);
    await admin.end();
  });
  it('preserves pg rowMode, codecs, rowCount and rejects transaction control', async () => {
    const result = await native.command({ scope: 'a' }, async tx => {
      const decoded = await tx.query({ text: 'select $1::int as n, $2::jsonb as payload', rowMode: 'array' }, [
        7,
        { ok: true },
      ]);
      expect(decoded.rows).toEqual([[7, { ok: true }]]);
      const date = await tx.query({
        text: "select '2026-09-10'::date as day",
        types: { getTypeParser: () => (v: string) => 'parsed:' + v },
      });
      expect(date.rows[0].day).toBe('parsed:2026-09-10');
      return tx.query(`insert into "${schema}".orders values($1,$2,$3,$4,$5,$6) returning *`, [
        'native',
        'a',
        'A',
        'ready',
        1,
        null,
      ]);
    });
    expect(result.data.rowCount).toBe(1);
    expect(result.data.rows[0].id).toBe('native');
    await expect(native.command({ scope: 'a' }, tx => tx.query('/* comment */ COMMIT'))).rejects.toThrow();
  });
  it('keeps postgres.js tagged queries lazy and rejects execution after command end', async () => {
    let late!: PostgresPendingQuery<unknown>;
    const result = await tagged.command({ scope: 'a' }, async tx => {
      late = tx`select 99`;
      const rows = await tx`select ${7}::int as n`;
      expect(rows.count).toBe(1);
      expect(rows[0].n).toBe(7);
      return tx.savepoint(async child => (await child`select ${8}::int as n`)[0].n);
    });
    expect(result.data).toBe(8);
    expect(result.impact.targets).toEqual([]);
    await expect(late.execute()).rejects.toThrow('WRITE_CONTEXT_CLOSED');
    await expect(
      tagged.command({ scope: 'a' }, async tx => {
        void tx`select pg_sleep(0.02)`.execute();
      }),
    ).rejects.toThrow('UNAWAITED_DATABASE_OPERATION');
  });
  it('returns precise frontend selectors from repository functions, JOIN and savepoint rollback', async () => {
    await orm.command({ scope: 'a' }, async tx => {
      await tx
        .insert(repository.orders)
        .values({ id: 'orm', tenant_id: 'a', customer_id: 'A', status: 'ready', priority: 2 });
      await tx.insert(repository.items).values({ id: 'item', tenant_id: 'a', order_id: 'orm', amount: 12 });
    });
    let escaped!: DrizzleCommandDb, late!: ReturnType<DrizzleCommandDb['execute']>;
    const result = await orm.command({ scope: 'a' }, async tx => {
      escaped = tx;
      late = tx.execute(dsql`select 1`);
      expect(await repository.total(tx, 'orm')).toBe(12);
      await expect(
        tx.transaction(async child => {
          await repository.move(child, 'orm', 'cancelled');
          throw new Error('cancel');
        }),
      ).rejects.toThrow('cancel');
      return repository.move(tx, 'orm', 'B');
    });
    const response = JSON.parse(JSON.stringify(result));
    const cached = [
      { endpoint: 'orders.detail', input: { id: 'orm' } },
      { endpoint: 'orders.list', input: { customer: 'A' } },
      { endpoint: 'orders.list', input: { customer: 'B' } },
      { endpoint: 'orders.list', input: { customer: 'C' } },
      { endpoint: 'orders.list', input: { customer: 'cancelled' } },
    ];
    expect(affectedQueries(response.impact, cached)).toEqual(cached.slice(0, 3));
    expect(response.data.customer_id).toBe('B');
    expect(Object.keys(response)).toEqual(['data', 'impact']);
    await expect(late).rejects.toThrow();
    await expect(escaped.select().from(repository.orders)).rejects.toThrow();
    const deleted = await orm.command({ scope: 'a' }, tx =>
      tx.delete(repository.orders).where(eq(repository.orders.id, 'orm')),
    );
    expect(deleted.impact.targets.some(t => t.endpoint === 'orders.total')).toBe(true);
  });
  it('preserves RLS and SQL error codes through ORM execution', async () => {
    await expect(
      orm.command({ scope: 'b' }, tx =>
        tx.insert(repository.orders).values({ id: 'forbidden', tenant_id: 'a', status: 'ready', priority: 0 }),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });
});
