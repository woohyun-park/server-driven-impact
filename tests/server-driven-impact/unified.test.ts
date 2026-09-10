import { describe, it, expect, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { matchesInputSelector, type ImpactSet } from '@server-driven-impact/core';
import { createImpact, q, defineQueries } from '@server-driven-impact/runtime';
import { sqliteAdapter, type SqliteCommandDb } from '@server-driven-impact/sqlite';
import { ordersDomain } from '../../examples/orders-impact/domain.js';
import { describeQueries } from '@server-driven-impact/runtime/debug';

const databases: DatabaseSync[] = [];
afterEach(() => { for (const database of databases.splice(0)) database.close(); });
function fixture() {
  const database = new DatabaseSync(':memory:'); databases.push(database);
  database.exec(`create table orders(id text primary key,tenant_id text not null,customer_id text,status text not null,priority integer not null,note text);
    create table order_items(id text primary key,tenant_id text not null,order_id text references orders(id) on delete cascade,amount integer not null);`);
  const definitions = ordersDomain('main');
  const adapter = sqliteAdapter({ database });
  const engine = createImpact({ adapter, ...definitions });
  return { database, engine, adapter, ...definitions };
}
const context = { scope: 'a' };
const order = (id: string, customer = 'first') => ({ id, tenant_id: 'a', customer_id: customer, status: 'ready', priority: 1, note: null });
async function insert(db:SqliteCommandDb,table:string,rows:Record<string,unknown>[],returning=false) {
  if(!rows.length)return [];
  const names=Object.keys(rows[0]);
  const values=rows.flatMap(row=>names.map(name=>row[name] as null|string|number));
  const tuples=rows.map((_,row)=>`(${names.map((__,column)=>`?${row*names.length+column+1}`).join(',')})`).join(',');
  return db.execute(`insert into ${table}(${names.join(',')}) values ${tuples}${returning?' returning *':''}`,values);
}
const update=(db:SqliteCommandDb,table:string,set:string,where:string,values:readonly (null|string|number)[]=[])=>db.execute(`update ${table} set ${set} where ${where} returning *`,values);
const remove=(db:SqliteCommandDb,table:string,where:string,values:readonly (null|string|number)[]=[])=>db.execute(`delete from ${table} where ${where} returning *`,values);
function includes(impact: ImpactSet, endpoint: string, input: Record<string, unknown>) {
  return impact.targets.some(t => t.endpoint === endpoint && matchesInputSelector(input, t.selector));
}
describe('unified API / actual SQLite', () => {
  it('exposes only the native transaction operations', async () => {
    const { engine } = fixture();
    await engine.command(context, async db => {
      expect(Object.keys(db).sort()).toEqual(['execute', 'savepoint']);
      expect(db).not.toHaveProperty('insert');
      expect(db).not.toHaveProperty('sqlite');
    });
  });
  it('runs the same executable definitions for reads and impact, without a supplied manifest', async () => {
    const { engine } = fixture();
    await engine.validate();
    expect(await engine.query('orders.list', { customer: 'first' }, context)).toEqual([]);
    const inserted = await engine.command(context, db => insert(db,'orders',[order('one')]));
    expect(inserted).not.toHaveProperty('affected');
    expect(inserted.data).toEqual([]);
    expect(includes(inserted.impact, 'orders.list', { customer: 'first' })).toBe(true);
    const moved = await engine.command(context, db => update(db,'orders','customer_id=?1','id=?2',['second','one']));
    for (const customer of ['first', 'second']) expect(includes(moved.impact, 'orders.list', { customer })).toBe(true);
    const item = await engine.command(context, db => insert(db,'order_items',[{ id: 'item', tenant_id: 'a', order_id: 'one', amount: 42 }]));
    expect(includes(item.impact, 'orders.detail', { id: 'one' })).toBe(true);
    expect(await engine.query('orders.total', { id: 'one' }, context)).toBe(42);
    expect(await engine.query('orders.detail', { id: 'one' }, context)).toMatchObject([{ id: 'one', items: [{ amount: 42 }] }]);
    const deleted = await engine.command(context, db => remove(db,'orders','id=?1',['one']));
    expect(includes(deleted.impact, 'orders.total', { id: 'one' })).toBe(true);
    expect(await engine.query('orders.total', { id: 'one' }, context)).toBe(0);
  });
  it('discards rolled back facts, rejects leaked contexts, and reports no-op correctly', async () => {
    const { engine } = fixture();
    let captured!: SqliteCommandDb;
    await expect(engine.command(context, async db => {
      captured = db;
      await insert(db,'orders',[order('rolled')]);
      throw new Error('abort');
    })).rejects.toThrow('abort');
    await expect(captured.execute('select 1')).rejects.toThrow('WRITE_CONTEXT_CLOSED');
    expect(await engine.query('orders.detail', { id: 'rolled' }, context)).toEqual([]);
    const result = await engine.command(context, async db => {
      await expect(db.savepoint(async child => { await insert(child,'orders',[order('discarded', 'discarded')]); throw new Error('child'); })).rejects.toThrow('child');
      return db.savepoint(child => insert(child,'orders',[order('kept', 'kept')]));
    });
    expect(JSON.stringify(result.impact)).not.toContain('discarded');
    expect((await engine.command(context, db => update(db,'orders','status=?1','id=?2',['draft','missing']))).impact.targets).toEqual([]);
    expect((await engine.command(context, db => update(db,'orders','status=?1','id=?2',['ready','kept']))).impact.targets).toEqual([]);
    expect((await engine.command(context, db => update(db,'orders','note=?1','id=?2',['private','kept']))).impact.targets.map(t => t.endpoint)).toEqual(['orders.detail']);
  });
  it('commit failure publishes no result, and a caught failed write cannot commit earlier writes', async () => {
    const { engine, database } = fixture();
    database.exec('create unique index unique_note on orders(note)');
    await expect(engine.command(context, async db => {
      await insert(db,'orders',[{ ...order('one'), note: 'same' }]);
      await expect(insert(db,'orders',[{ ...order('two'), note: 'same' }])).rejects.toThrow();
    })).rejects.toThrow('COMMAND_OPERATION_FAILED');
    expect(await engine.query('orders.detail', { id: 'one' }, context)).toEqual([]);
    const { resources, queries } = ordersDomain('main');
    database.exec('drop table order_items; create table order_items(id text primary key,tenant_id text not null,order_id text references orders(id) on delete cascade deferrable initially deferred,amount integer not null)');
    const second = createImpact({ adapter: sqliteAdapter({ database }), resources, queries });
    await expect(second.command(context, db => insert(db,'order_items',[{ id: 'bad', tenant_id: 'a', order_id: 'missing', amount: 2 }]))).rejects.toThrow(/FOREIGN KEY/);
    expect(await second.query('orders.total', { id: 'missing' }, context)).toBe(0);
  });
  it('serializes commands on a shared connection and isolates request collectors', async () => {
    const { engine } = fixture();
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => engine.command(context, async db => {
      await Promise.resolve();
      return insert(db,'orders',[order(String(i), 'customer' + i)]);
    })));
    results.forEach((result, i) => expect(result.impact.targets.find(t => t.endpoint === 'orders.list')?.selector).toEqual({ kind: 'inputs', values: [{ customer: 'customer' + i }] }));
  });
  it('rejects overlapping savepoints and unfinished writes', async () => {
    const { engine } = fixture();
    await expect(engine.command(context, async db => { void db.savepoint(async child => { await new Promise(resolve => setTimeout(resolve, 5)); await insert(child,'orders',[order('unawaited')]); }); })).rejects.toThrow('UNAWAITED_DATABASE_OPERATION');
    expect(await engine.query('orders.detail', { id: 'unawaited' }, context)).toEqual([]);
    await engine.command(context, async db => {
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const child = db.savepoint(async () => gate);
      await expect(db.savepoint(async () => {})).rejects.toThrow('OVERLAPPING_SAVEPOINT');
      release(); await child;
    });
  });
  it('bounds bulk facts and keeps OLD/NEW nullable selector membership', async () => {
    const { engine } = fixture();
    await engine.command(context, db => insert(db,'orders',[{ ...order('nullable'), customer_id: null }]));
    const moved = await engine.command(context, db => update(db,'orders','customer_id=?1','customer_id is null',['new']));
    expect(includes(moved.impact, 'orders.list', { customer: null })).toBe(true);
    expect(includes(moved.impact, 'orders.list', { customer: 'new' })).toBe(true);
    await engine.command(context, db => insert(db,'orders',Array.from({ length: 210 }, (_, i) => order('bulk' + i))));
    const bulk = await engine.command(context, db => update(db,'orders','status=?1','true',['draft']));
    expect(bulk.data).toHaveLength(211);
    expect(bulk.impact.targets.every(t => t.selector.kind === 'all')).toBe(true);
  });
  it('preserves every changed resource when one command exceeds the fact budget',async()=>{
    const {adapter,resources}=fixture();
    const input={parse:(value:unknown)=>value as Record<string,unknown>};
    const engine=createImpact({adapter,resources,queries:defineQueries({
      orderOnly:{input,plan:q.select('orders',{columns:['id']})},
      itemOnly:{input,plan:q.select('items',{columns:['id']})},
    })});
    const result=await engine.command(context,async db=>{
      await insert(db,'orders',Array.from({length:201},(_,i)=>order('overflow-'+i)));
      await insert(db,'order_items',[{id:'overflow-item',tenant_id:'a',order_id:'overflow-0',amount:1}]);
    });
    expect(result.impact.targets.map(target=>target.endpoint)).toEqual(['itemOnly','orderOnly']);
    expect(result.impact.targets.every(target=>target.selector.kind==='all')).toBe(true);
  });
  it('executes count, OR/NOT and input pagination in the database', async () => {
    const {adapter,resources}=fixture();
    const input={parse:(value:unknown)=>value as Record<string,unknown>};
    const queries=defineQueries({
      count:{
        input,
        plan:q.count('orders',{where:[
          q.or(q.eq('status',q.literal('ready')),q.not(q.eq('customer_id',q.literal('blocked')))),
        ]}),
      },
      page:{input,plan:q.select('orders',{columns:['id'],order:[{field:'id'}],limit:q.input('size'),offset:q.input('offset')})},
      offsetOnly:{input,plan:q.select('orders',{columns:['id'],order:[{field:'id'}],offset:q.input('offset')})},
    });
    const engine=createImpact({adapter,resources,queries});
    await engine.command(context,db=>insert(db,'orders',[order('a'),order('b'),order('c')]));
    expect(await engine.query('count',{},context)).toBe(3);
    expect(await engine.query('page',{size:1,offset:1},context)).toEqual([{id:'b'}]);
    expect(await engine.query('offsetOnly',{offset:1},context)).toEqual([{id:'b'},{id:'c'}]);
    await expect(engine.query('page',{size:0,offset:0},context)).rejects.toThrow('Invalid query limit');
  });
  it('includes unexecuted branches and snapshots the registered plans', async () => {
    const { adapter, resources } = fixture();
    const plan = q.select('orders', { columns: ['id'] });
    const queries = defineQueries({ sample: { input: { parse: () => ({}) }, plan: q.when(() => false, q.select('items'), plan) } });
    const engine = createImpact({ adapter, resources, queries });
    plan.resource = 'items';
    await engine.command(context, db => insert(db,'orders',[order('one')]));
    expect(await engine.query('sample', {}, context)).toEqual([{ id: 'one' }]);
    const changed = await engine.command(context, db => insert(db,'order_items',[{ id: 'i', tenant_id: 'a', order_id: 'one', amount: 1 }]));
    expect(changed.impact.targets.map(t => t.endpoint)).toEqual(['sample']);
    expect(describeQueries(resources, queries).sources.sample).toEqual(['items']);
  });
  it('rejects missing adapters, arbitrary manifests, unknown endpoints and SQL injection', async () => {
    const { engine, adapter, resources } = fixture();
    // @ts-expect-error A hand-written manifest cannot replace adapter/query registration.
    expect(() => createImpact({ resources, manifest: { reads: {} } })).toThrow('IMPACT_ADAPTER_REQUIRED');
    // @ts-expect-error The adapter and manifest are not enough either.
    expect(() => createImpact({ adapter, resources, manifest: {} })).toThrow('QUERY_DEFINITIONS_REQUIRED');
    // @ts-expect-error Query endpoint names are inferred.
    await expect(engine.query('unknown', {}, context)).rejects.toThrow('UNKNOWN_QUERY');
    await engine.command(context, db => insert(db,'orders',[order('injection', "'; delete from orders; --")]));
    expect(await engine.query('orders.list', { customer: "'; delete from orders; --" }, context)).toHaveLength(1);
    await expect(engine.command(context, db => db.execute('update orders set status=?1 where id=?2; drop table orders',['bad','x']))).rejects.toThrow('SQLITE_SINGLE_STATEMENT_REQUIRED');
  });
  it('observes native SQLite DML and writes performed by business triggers', async () => {
    const { database, adapter, resources, queries } = fixture();
    database.exec("create trigger hidden after insert on orders begin update orders set note='hidden' where id=new.id; end");
    const engine=createImpact({adapter,resources,queries});
    const result=await engine.command(context,db=>db.execute(
      'insert into orders(id,tenant_id,customer_id,status,priority,note) values(?,?,?,?,?,?)',
      ['native','a','first','ready',1,null],
    ));
    expect(includes(result.impact,'orders.list',{customer:'first'})).toBe(true);
    expect(result.impact.targets.map(target=>target.endpoint)).toContain('orders.detail');
    expect(await engine.query('orders.detail',{id:'native'},context)).toMatchObject([{note:'hidden'}]);
  });
  it('observes native identity changes and rejects operations it cannot observe safely',async()=>{
    const {engine}=fixture();
    await engine.command(context,db=>insert(db,'orders',[order('old')]));
    const moved=await engine.command(context,db=>db.execute('update orders set id=? where id=? returning *',['new','old']));
    expect(moved.data).toEqual([expect.objectContaining({id:'new'})]);
    expect(includes(moved.impact,'orders.detail',{id:'old'})).toBe(true);
    expect(includes(moved.impact,'orders.detail',{id:'new'})).toBe(true);
    await expect(engine.command(context,db=>db.execute('commit'))).rejects.toThrow('SQLITE_TRANSACTION_OR_DDL_FORBIDDEN');
    await expect(engine.command(context,db=>db.execute('/* harmless-looking prefix */ COMMIT'))).rejects.toThrow('SQLITE_TRANSACTION_OR_DDL_FORBIDDEN');
    await expect(engine.command(context,db=>db.execute("insert into orders(id,tenant_id,customer_id,status,priority,note) values('escape','a','first','ready',1,null); commit"))).rejects.toThrow('SQLITE_SINGLE_STATEMENT_REQUIRED');
    await expect(engine.command(context,db=>db.execute("update orders set note='contains;semicolon' where id='new'"))).resolves.toBeDefined();
    await expect(engine.command(context,db=>db.execute("insert or replace into orders(id,tenant_id,customer_id,status,priority,note) values('new','a','second','ready',1,null)"))).rejects.toThrow('SQLITE_REPLACE_UNSUPPORTED');
  });
  it('matches numeric affinity and NOCASE result changes conservatively',async()=>{
    const database=new DatabaseSync(':memory:');databases.push(database);
    database.exec('create table values_table(id text primary key,tenant text,number_value integer,label text collate nocase)');
    const resources={values:{schema:'main',table:'values_table',idColumn:'id',scopeColumn:'tenant',columns:['id','tenant','number_value','label']}};
    const input={parse:(value:unknown)=>value as Record<string,unknown>};
    const queries=defineQueries({
      number:{input,plan:q.select('values',{where:[q.eq('number_value',q.input('value'))]})},
      label:{input,plan:q.select('values',{where:[q.eq('label',q.input('value'))]})},
    });
    const engine=createImpact({adapter:sqliteAdapter({database}),resources,queries});
    await engine.validate();
    const inserted=await engine.command(context,db=>insert(db,'values_table',[{id:'one',tenant:'a',number_value:1,label:'work'}]));
    expect(includes(inserted.impact,'number',{value:'1'})).toBe(true);
    expect(includes(inserted.impact,'label',{value:'WORK'})).toBe(true);
    const changed=await engine.command(context,db=>update(db,'values_table','label=?1','id=?2',['WORK','one']));
    expect(changed.impact.targets.map(target=>target.endpoint)).toContain('label');
  });
  it('rejects schema-level REPLACE policies that can hide the deleted row',async()=>{
    const database=new DatabaseSync(':memory:');databases.push(database);
    database.exec('create table unsafe(id text primary key on conflict replace,tenant text,value text)');
    const resources={unsafe:{schema:'main',table:'unsafe',idColumn:'id',scopeColumn:'tenant',columns:['id','tenant','value']}};
    const engine=createImpact({adapter:sqliteAdapter({database}),resources,queries:defineQueries({all:{input:{parse:()=>({})},plan:q.select('unsafe')}})});
    await expect(engine.validate()).rejects.toThrow('SQLITE_SCHEMA_REPLACE_UNSUPPORTED:unsafe');
  });
  it('runs without implicit validation and performs fresh SQLite validation only when requested',async()=>{
    const {engine,database}=fixture();
    await engine.command(context,db=>insert(db,'orders',[order('without-validation')]));
    expect(await engine.query('orders.detail',{id:'without-validation'},context)).toHaveLength(1);
    await expect(engine.validate()).resolves.toBeUndefined();
    database.exec('alter table orders add column drift text');
    expect(await engine.query('orders.detail',{id:'without-validation'},context)).toHaveLength(1);
    await expect(engine.validate()).rejects.toThrow('COLUMN_DRIFT:orders');
  });
});
