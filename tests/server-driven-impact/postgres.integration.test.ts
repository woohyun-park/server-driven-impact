import { validateCatalog } from '../../packages/sdi-postgres/src/postgres/catalog.js';
import { describe,it,expect,beforeAll,afterAll } from 'vitest';
import postgres from 'postgres';
import { Pool } from 'pg';
import { pgDatabase, type PgExecuteResult } from '@server-driven-impact/postgres/pg';
import { randomUUID } from 'node:crypto';
import { ordersDomain } from '../../examples/orders-impact/domain.ts';
import { compilePostgresQuery,createPostgresCatalogResolver,generateObserverMigration,identifier,migratePostgresArtifacts,postgresAdapter,resolvePostgresResources,Sql,sql,type PostgresCommandDb as TrackedDb,type PostgresExecuteResult } from '@server-driven-impact/postgres';
import { observerFingerprint,observerInternals,observerLayout } from '../../packages/sdi-postgres/src/postgres/observer.js';
import { canonical, matchesInputSelector, type ImpactSet } from '@server-driven-impact/core';
import { createImpact,defineQueries,q } from '@server-driven-impact/runtime';
import { compileManifest } from '@server-driven-impact/runtime';
const adminUrl=process.env.SDI_POSTGRES_ADMIN_URL;
const runtimeUrl=process.env.SDI_POSTGRES_RUNTIME_URL;
const required=process.env.SDI_POSTGRES_REQUIRED==='1';
const enabled=!!adminUrl && !!runtimeUrl;
if(required && !enabled) throw new Error('POSTGRES_FIXTURES_REQUIRED');
if(enabled) {
  const url=new URL(adminUrl!);
  const matrix=!!process.env.SDI_POSTGRES_ADMIN_URL;
  if(!['127.0.0.1','localhost','::1'].includes(url.hostname) || (!matrix && url.port!=='54332')) throw new Error('LOCAL_FIXTURES_ONLY');
}
describe.skipIf(!enabled)('orders domain / real PostgreSQL conformance',()=>{
  const schema='sdi_test_'+randomUUID().replaceAll('-','');
  const {resources,queries}=ordersDomain(schema);
  const admin=enabled ? postgres(adminUrl!,{max:1,prepare:false,onnotice:()=>{}}):undefined!;
  const pgPool=enabled && process.env.SDI_POSTGRES_DRIVER==='pg' ? new Pool({connectionString:runtimeUrl,max:4}) : undefined;
  const db=enabled ? (pgPool ? {...pgDatabase(pgPool),end:()=>pgPool.end()} as unknown as postgres.Sql : postgres(runtimeUrl!,{max:4,prepare:false})):undefined!;
  let serverMajor=0;
  const setup=async(tx:Parameters<NonNullable<Parameters<typeof postgresAdapter>[0]['setup']>>[0],scope:unknown)=>{await tx.unsafe("select set_config('sdi.tenant',$1,true)",[String(scope)]);};
  const adapter=enabled ? postgresAdapter({database:db,setup}):undefined!;
  const engine=enabled ? createImpact({adapter,resources,queries}):undefined!;
  const driverRows=(result:unknown) => pgPool ? (result as PgExecuteResult).rows : [...result as PostgresExecuteResult];
  const run=async(scope='a',work:(db:TrackedDb)=>Promise<unknown>)=>{
    const result=await engine.command({scope},db=>work(db));
    return {data:result.data,impact:result.impact};
  };
  const insert=async(tx:TrackedDb,resource:string,rows:Record<string,unknown>[])=>{
    const table=resource==='items'?'order_items':resource;
    const names=Object.keys(rows[0]);
    const values=rows.flatMap(row=>names.map(name=>row[name]));
    const tuples=rows.map((_,row)=>`(${names.map((__,column)=>`$${row*names.length+column+1}`).join(',')})`).join(',');
    return tx.execute(new Sql(`insert into "${schema}"."${table}"(${names.map(name=>`"${name}"`).join(',')}) values ${tuples} returning *`,values));
  };
  const read=(endpoint:keyof typeof queries,input:Record<string,unknown>,scope='a')=>engine.query(endpoint,input,{scope});
  function includes(impact:ImpactSet,endpoint:string,input:Record<string,unknown>) {return impact.targets.some(t=>t.endpoint===endpoint && matchesInputSelector(input,t.selector));}
  beforeAll(async()=>{
    const version=await admin.unsafe(`select current_setting('server_version_num')::int as number`);
    serverMajor=Math.floor(Number(version[0]?.number)/10000);
    const expected=process.env.SDI_POSTGRES_MAJOR ? Number(process.env.SDI_POSTGRES_MAJOR) : undefined;
    if(expected !== undefined && serverMajor !== expected) throw new Error(`POSTGRES_MAJOR_MISMATCH:${serverMajor}:${expected}`);
    await admin.unsafe(`create schema "${schema}";
      create table "${schema}".orders(id text primary key,tenant_id text not null,customer_id text,status text not null,priority integer not null,note text);
      create table "${schema}".order_items(id text primary key,tenant_id text not null,order_id text references "${schema}".orders(id) on delete cascade,amount integer not null);
      grant usage on schema "${schema}" to routine_runtime;
      grant select,insert,update,delete on all tables in schema "${schema}" to routine_runtime;
      alter table "${schema}".orders enable row level security;
      alter table "${schema}".order_items enable row level security;
      create policy tenant on "${schema}".orders to routine_runtime using(tenant_id=current_setting('sdi.tenant',true)) with check(tenant_id=current_setting('sdi.tenant',true));
      create policy tenant on "${schema}".order_items to routine_runtime using(tenant_id=current_setting('sdi.tenant',true)) with check(tenant_id=current_setting('sdi.tenant',true));`);
    await admin.unsafe(generateObserverMigration(resources,compileManifest(queries,resources),{runtimeRole:'routine_runtime'}));
    await engine.validate();
  });
  afterAll(async()=>{await db.end();await admin.unsafe(`drop schema if exists "${schema}" cascade`);await admin.end();});
  it('runs against the declared PostgreSQL capability target',()=>{
    expect(serverMajor).toBeGreaterThanOrEqual(14);
    expect(serverMajor).toBeLessThanOrEqual(18);
  });
  it('rejects narrow selectors on nondeterministic collations during validation',async()=>{
    await admin.unsafe(`create collation "${schema}".folded (provider=icu,locale='und-u-ks-level2',deterministic=false);
      create table "${schema}".collated(id text primary key,value text collate "${schema}".folded)`);
    const collated={value:{schema,table:'collated',idColumn:'id',scopeColumn:null,columns:['id','value']}};
    await expect(validateCatalog(admin,collated,{protocolVersion:1,reads:{byValue:[{resource:'value',columns:'*',bindings:[{column:'value',input:'value'}]}]}})).rejects.toThrow('UNSUPPORTED_SELECTOR_COLLATION:value:value');
  });
  it('empty→insert, customer move, joins, aggregates, cascade and tenant isolation',async()=>{
    expect(await read('orders.list',{customer:'first'})).toEqual([]);
    const inserted=await run('a',tx=>insert(tx,'orders',[{id:'one',tenant_id:'a',customer_id:'first',status:'ready',priority:1,note:null}]));
    expect(includes(inserted.impact,'orders.list',{customer:'first'})).toBe(true);
    expect(await read('orders.list',{customer:'first'},'b')).toEqual([]);
    await expect(run('b',tx=>insert(tx,'orders',[{id:'forbidden',tenant_id:'a',customer_id:null,status:'ready',priority:0,note:null}]))).rejects.toMatchObject({code:'42501'});
    const moved=await run('a',tx=>tx.execute(sql`update ${identifier(schema)}.orders set customer_id=${'second'} where id=${'one'}`));
    for(const customer of ['first','second'])expect(includes(moved.impact,'orders.list',{customer})).toBe(true);
    const item=await run('a',tx=>insert(tx,'items',[{id:'item',tenant_id:'a',order_id:'one',amount:42}]));
    expect(includes(item.impact,'orders.detail',{id:'one'})).toBe(true);expect(includes(item.impact,'orders.total',{id:'one'})).toBe(true);
    expect(await read('orders.total',{id:'one'})).toBe(42);
    const deleted=await run('a',tx=>tx.execute(sql`delete from ${identifier(schema)}.orders where id=${'one'}`));
    expect(includes(deleted.impact,'orders.total',{id:'one'})).toBe(true);expect(await read('orders.total',{id:'one'})).toBe(0);
  });
  it('rollback/savepoint, no-op, commit failure and closed contexts',async()=>{
    let captured:TrackedDb|undefined;
    await expect(run('a',async tx=>{captured=tx;await insert(tx,'orders',[{id:'rolled',tenant_id:'a',customer_id:'x',status:'ready',priority:0,note:null}]);throw new Error('rollback');})).rejects.toThrow('rollback');
    expect(await read('orders.detail',{id:'rolled'})).toEqual([]);
    await expect(captured!.execute(sql`select 1`)).rejects.toThrow('WRITE_CONTEXT_CLOSED');
    const result=await run('a',async tx=>{
      await expect(tx.savepoint(async child=>{await insert(child,'orders',[{id:'child',tenant_id:'a',customer_id:'child',status:'ready',priority:0,note:null}]);throw new Error('child rollback');})).rejects.toThrow('child rollback');
      await tx.savepoint(child=>insert(child,'orders',[{id:'kept',tenant_id:'a',customer_id:'kept',status:'ready',priority:0,note:null}]));
    });
    expect(await read('orders.detail',{id:'child'})).toEqual([]);expect(canonical(result.impact)).not.toContain('child');
    expect((await run('a',tx=>tx.execute(sql`update ${identifier(schema)}.orders set note=${'no'} where id=${'missing'}`))).impact.targets).toEqual([]);
    await admin.unsafe(`alter table "${schema}".orders add constraint unique_note unique(note) deferrable initially deferred`);
    await expect(run('a',tx=>insert(tx,'orders',[{id:'bad1',tenant_id:'a',customer_id:null,status:'ready',priority:0,note:'duplicate'},{id:'bad2',tenant_id:'a',customer_id:null,status:'ready',priority:0,note:'duplicate'}]))).rejects.toMatchObject({code:'23505'});
    expect(await read('orders.detail',{id:'bad1'})).toEqual([]);
  });
  it('serializes artifact migration against an active SDI transaction',async()=>{
    let entered!:()=>void;
    const active=new Promise<void>(resolve=>{entered=resolve;});
    let release!:()=>void;
    const gate=new Promise<void>(resolve=>{release=resolve;});
    const command=engine.command({scope:'a'},async()=>{entered();await gate;return 'held';});
    await active;
    let migrated=false;
    const migration=migratePostgresArtifacts(admin,resources,compileManifest(queries,resources),{runtimeRole:'routine_runtime'}).then(result=>{migrated=true;return result;});
    await new Promise(resolve=>setTimeout(resolve,50));
    expect(migrated).toBe(false);
    release();
    expect((await command).data).toBe('held');
    await migration;
    expect(migrated).toBe(true);
  });
  it('fixed-seed result-change implies impact, across WHERE/ORDER and scalar predicates',async()=>{
    await run('a',tx=>insert(tx,'orders',Array.from({length:8},(_,i)=>({id:'seed'+i,tenant_id:'a',customer_id:i%2?'odd':'even',status:i%2?'ready':'draft',priority:i,note:null}))));
    let seed=713;const rand=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed>>>8;};
    const inputs=[['orders.list',{customer:'odd'}],['orders.list',{customer:'even'}],['orders.ready',{}],...Array.from({length:8},(_,i)=>['orders.detail',{id:'seed'+i}])] as [keyof typeof queries,Record<string,unknown>][];
    for(let i=0;i<32;i++) {
      const before=await Promise.all(inputs.map(([endpoint,input])=>read(endpoint,input)));
      const id='seed'+rand()%8;
      const result=await run('a',tx=>tx.execute(sql`update ${identifier(schema)}.orders set status=${rand()%2?'ready':'draft'},priority=${rand()%20},customer_id=${rand()%2?'odd':'even'} where id=${id}`));
      const after=await Promise.all(inputs.map(([endpoint,input])=>read(endpoint,input)));
      for(let j=0;j<inputs.length;j++)if(canonical(before[j])!==canonical(after[j]))expect(includes(result.impact,...inputs[j]),`${i} ${inputs[j][0]}`).toBe(true);
    }
  });
  it('oversized selector values widen in the database before detailed facts return',async()=>{
    const result=await run('a',tx=>insert(tx,'orders',[{id:'large-selector',tenant_id:'a',customer_id:'x'.repeat(140000),status:'ready',priority:0,note:null}]));
    expect(result.impact.targets.find(t=>t.endpoint==='orders.list')?.selector.kind).toBe('all');
    expect(canonical(result.impact).length).toBeLessThan(2000);
  });
  it('executes native PostgreSQL DML unchanged on the observed transaction',async()=>{
    const table=sql`${identifier(schema)}.${identifier('orders')}`;
    const inserted=await engine.command({scope:'a'},db=>db.execute(sql`
      insert into ${table}(id,tenant_id,customer_id,status,priority,note)
      values(${'native'},${'a'},${'native-before'},${'ready'},${1},${null}) returning id`));
    expect(driverRows(inserted.data)).toEqual([{id:'native'}]);
    expect(includes(inserted.impact,'orders.list',{customer:'native-before'})).toBe(true);
    if(serverMajor>=15) {
      const merged=await engine.command({scope:'a'},db=>db.execute(sql`
        merge into ${table} t using (values(${'native'},${'native-after'})) s(id,customer_id)
        on t.id=s.id when matched then update set customer_id=s.customer_id`));
      expect(includes(merged.impact,'orders.list',{customer:'native-before'})).toBe(true);
      expect(includes(merged.impact,'orders.list',{customer:'native-after'})).toBe(true);
    } else {
      await expect(engine.command({scope:'a'},db=>db.execute(sql`
        merge into ${table} t using (values(${'native'},${'native-after'})) s(id,customer_id)
        on t.id=s.id when matched then update set customer_id=s.customer_id`))).rejects.toMatchObject({code:'42601'});
    }
  });
  it('observes composite-key and keyless resources without inverse reads',async()=>{
    await admin.unsafe(`create table "${schema}".composite_runtime(a int,b int,value text,primary key(a,b));
      create table "${schema}".keyless_runtime(a int,value text);
      create function "${schema}".add_keyless(p_a int,p_value text) returns int language plpgsql as $$begin insert into "${schema}".keyless_runtime(a,value) values(p_a,p_value);return p_a;end$$;
      grant select,insert,update,delete on "${schema}".composite_runtime, "${schema}".keyless_runtime to routine_runtime;
      grant execute on function "${schema}".add_keyless(int,text) to routine_runtime`);
    const extraResources = {
      composite:{schema,table:'composite_runtime',idColumn:['a','b'],scopeColumn:null,columns:['a','b','value']},
      keyless:{schema,table:'keyless_runtime',idColumn:null,scopeColumn:null,columns:['a','value']},
    } as const;
    const input={parse:(value:unknown)=>value as Record<string,unknown>};
    const extraQueries=defineQueries({
      'composite.byA':{input,plan:q.select('composite',{where:[q.eq('a',q.input('a'))]})},
      'keyless.byA':{input,plan:q.select('keyless',{where:[q.eq('a',q.input('a'))]})},
    });
    await admin.unsafe(generateObserverMigration(extraResources,compileManifest(extraQueries,extraResources),{runtimeRole:'routine_runtime'}));
    const extra=createImpact({adapter:postgresAdapter({database:db}),resources:extraResources,queries:extraQueries});
    await extra.validate();
    const inserted=await extra.command({scope:'a'},tx=>tx.execute(sql`insert into ${identifier(schema)}.composite_runtime(a,b,value) values(${1},${2},${'x'})`));
    expect(includes(inserted.impact,'composite.byA',{a:1})).toBe(true);
    const keyless=await extra.command({scope:'a'},tx=>tx.execute(sql`insert into ${identifier(schema)}.keyless_runtime(a,value) values(${7},${'x'})`));
    expect(includes(keyless.impact,'keyless.byA',{a:7})).toBe(true);
    const changed=await extra.command({scope:'a'},tx=>tx.execute(sql`update ${identifier(schema)}.keyless_runtime set value=${'y'} where a=${7}`));
    expect(includes(changed.impact,'keyless.byA',{a:7})).toBe(true);
    const called=await extra.command({scope:'a'},tx=>tx.execute(sql`select ${identifier(schema)}.add_keyless(${9},${'rpc'}) as value`));
    expect(driverRows(called.data)).toEqual([{value:9}]);
    expect(includes(called.impact,'keyless.byA',{a:9})).toBe(true);
  });
  it('executes an automatically compiled native SQL query and narrows its input impact',async()=>{
    await admin.unsafe(`create table "${schema}"."NativeRows"("Key" text primary key,"Value" text not null,"Payload" json);
      grant select,insert,update,delete on "${schema}"."NativeRows" to routine_runtime`);
    const nativeResources={native:{schema,table:'NativeRows',idColumn:'Key',scopeColumn:null,columns:['Key','Value','Payload']}} as const;
    const plan=await compilePostgresQuery({text:`select "Key","Value","Payload" from "${schema}"."NativeRows" where "Key"=$1`,parameters:['id']},nativeResources,17);
    const nativeQueries=defineQueries({'native.byId':{input:{parse:(value:unknown)=>value as Record<string,unknown>},plan}});
    await admin.unsafe(generateObserverMigration(nativeResources,compileManifest(nativeQueries,nativeResources),{runtimeRole:'routine_runtime'}));
    const native=createImpact({adapter:postgresAdapter({database:db}),resources:nativeResources,queries:nativeQueries});
    await native.validate();
    expect(await native.query('native.byId',{id:'one'},{scope:'a'})).toEqual([]);
    const table=sql`${identifier(schema)}.${identifier('NativeRows')}`;
    const result=await native.command({scope:'a'},db=>db.execute(sql`insert into ${table}(${identifier('Key')},${identifier('Value')},${identifier('Payload')}) values(${'one'},${'hello'},${'{"a":1}'}::json)`));
    expect(includes(result.impact,'native.byId',{id:'one'})).toBe(true);
    expect(includes(result.impact,'native.byId',{id:'two'})).toBe(false);
    const updated=await native.command({scope:'a'},db=>db.execute(sql`update ${table} set ${identifier('Payload')}=${'{"a":2}'}::json where ${identifier('Key')}=${'one'}`));
    expect(includes(updated.impact,'native.byId',{id:'one'})).toBe(true);
    expect(await native.query('native.byId',{id:'one'},{scope:'a'})).toEqual([{Key:'one',Value:'hello',Payload:pgPool?{a:2}:'{"a":2}'}]);
  });
  it('catalog accepts composite and keyless tables while retaining unsupported table checks',async()=>{
    await admin.unsafe(`create table "${schema}".composite(a int,b int,value text,primary key(a,b))`);
    await expect(validateCatalog(admin,{test:{schema,table:'composite',idColumn:['a','b'],scopeColumn:null,columns:['a','b','value'],selectorColumns:['a','b']}})).resolves.toBeUndefined();
    await admin.unsafe(`create table "${schema}".keyless(a int,b int)`);
    await expect(validateCatalog(admin,{test:{schema,table:'keyless',idColumn:null,scopeColumn:null,columns:['a','b'],selectorColumns:['a']}})).resolves.toBeUndefined();
    await admin.unsafe(`create table "${schema}".partitioned(id int primary key) partition by range(id)`);
    await expect(validateCatalog(admin,{test:{schema,table:'partitioned',idColumn:'id',scopeColumn:null,columns:['id'],selectorColumns:['id']}})).rejects.toThrow('UNSUPPORTED_TABLE');
    await admin.unsafe(`create table "${schema}".parent(id int primary key);create table "${schema}".child() inherits("${schema}".parent)`);
    await expect(validateCatalog(admin,{test:{schema,table:'parent',idColumn:'id',scopeColumn:null,columns:['id'],selectorColumns:['id']}})).rejects.toThrow('UNSUPPORTED_TABLE');
    await admin.unsafe(`create table "${schema}".permissions(uid int primary key);
      create table "${schema}".secured(id int primary key,uid int);
      alter table "${schema}".secured enable row level security;
      create policy hidden_dependency on "${schema}".secured using(exists(select 1 from "${schema}".permissions p where p.uid=secured.uid))`);
    await expect(validateCatalog(admin,{test:{schema,table:'secured',idColumn:'id',scopeColumn:null,columns:['id','uid']}})).rejects.toThrow('UNRESOLVED_RLS_DEPENDENCY');
    const result=await run('a',tx=>tx.execute(sql`insert into ${identifier(schema)}.orders(id,tenant_id,customer_id,status,priority,note)
      values(${'kept'},${'a'},${'upsert'},${'ready'},${0},${null}) on conflict(id) do update set customer_id=excluded.customer_id`));
    expect(result.impact.targets.find(t=>t.endpoint==='orders.list')?.selector).toEqual({kind:'inputs',values:[{customer:'kept'},{customer:'upsert'}]});
  });
  it('expands nested view and RLS helper dependencies through the catalog',async()=>{
    await admin.unsafe(`create table "${schema}".memberships(tenant_id text primary key);
      create table "${schema}".secured_rows(id text primary key,tenant_id text not null,value text not null);
      create function "${schema}".can_read(p_tenant text) returns boolean language sql stable
        as $$select exists(select 1 from "${schema}".memberships m where m.tenant_id=p_tenant)$$;
      alter table "${schema}".secured_rows enable row level security;
      create policy membership_access on "${schema}".secured_rows using("${schema}".can_read(tenant_id));
      create view "${schema}".secured_view as select * from "${schema}".secured_rows;
      create view "${schema}".nested_secured_view as select * from "${schema}".secured_view;
      insert into "${schema}".secured_rows values('visible','a','value');
      grant usage,create on schema "${schema}" to routine_runtime;
      alter view "${schema}".secured_view owner to routine_runtime;
      alter view "${schema}".nested_secured_view owner to routine_runtime;
      grant select,insert,update,delete on "${schema}".memberships, "${schema}".secured_rows to routine_runtime;
      grant select on "${schema}".secured_view, "${schema}".nested_secured_view to routine_runtime;
      grant execute on function "${schema}".can_read(text) to routine_runtime`);
    const securedResources={
      secured:{schema,table:'secured_rows',idColumn:'id',scopeColumn:null,columns:['id','tenant_id','value']},
      memberships:{schema,table:'memberships',idColumn:'tenant_id',scopeColumn:null,columns:['tenant_id']},
    } as const;
    const catalog=createPostgresCatalogResolver(admin,securedResources,{searchPath:[schema,'public'],parserVersion:serverMajor as 14|15|16|17|18});
    const plan=await compilePostgresQuery({text:`select * from "${schema}".nested_secured_view where id=$1`,parameters:['id']},securedResources,serverMajor as 14|15|16|17|18,{catalog});
    expect(plan.reads).toEqual([
      {resource:'memberships',columns:'*',bindings:[]},
      {resource:'secured',columns:'*',bindings:[]},
    ]);
    const securedQueries=defineQueries({'secured.byId':{input:{parse:(value:unknown)=>value as Record<string,unknown>},plan}});
    const securedManifest=compileManifest(securedQueries,securedResources);
    await admin.unsafe(generateObserverMigration(securedResources,securedManifest,{runtimeRole:'routine_runtime'}));
    const securedEngine=createImpact({adapter:postgresAdapter({database:db}),resources:securedResources,queries:securedQueries});
    await securedEngine.validate();
    expect(await securedEngine.query('secured.byId',{id:'visible'},{scope:'a'})).toEqual([]);
    const changed=await securedEngine.command({scope:'a'},db=>db.execute(sql`insert into ${identifier(schema)}.${identifier('memberships')}(tenant_id) values(${'a'})`));
    expect(changed.impact.targets).toContainEqual({endpoint:'secured.byId',scope:'global',selector:{kind:'all'}});
    expect(await securedEngine.query('secured.byId',{id:'visible'},{scope:'a'})).toEqual([{id:'visible',tenant_id:'a',value:'value'}]);
  });
  it('does not miss self-join, untracked function reads, or non-row freshness dependencies',async()=>{
    await admin.unsafe(`create table "${schema}".compatibility_users(id text primary key,name text not null);
      create table "${schema}".compatibility_hidden(id text primary key);
      insert into "${schema}".compatibility_users values('a','Alice'),('b','Bob');
      insert into "${schema}".compatibility_hidden values('a');
      create function "${schema}".hidden_reader() returns bigint language sql stable
        as 'select count(*) from "${schema}".compatibility_users join "${schema}".compatibility_hidden using(id)';
      grant select,update on "${schema}".compatibility_users to routine_runtime;
      grant select,delete on "${schema}".compatibility_hidden to routine_runtime;
      grant execute on function "${schema}".hidden_reader() to routine_runtime`);
    const compatibilityResources={users:{schema,table:'compatibility_users',idColumn:'id',scopeColumn:null,columns:['id','name']}} as const;
    const catalog=createPostgresCatalogResolver(admin,compatibilityResources,{searchPath:[schema,'public'],parserVersion:serverMajor as 14|15|16|17|18});
    const pairPlan=await compilePostgresQuery({
      text:`select a.name as first,b.name as second from "${schema}".compatibility_users a cross join "${schema}".compatibility_users b where a.id=$1 and b.id=$2`,
      parameters:['left','right'],
    },compatibilityResources,serverMajor as 14|15|16|17|18,{catalog});
    expect(pairPlan.reads).toEqual([
      {resource:'users',columns:'*',bindings:[{column:'id',input:'left'}]},
      {resource:'users',columns:'*',bindings:[{column:'id',input:'right'}]},
    ]);
    const pairQueries=defineQueries({pair:{input:{parse:(value:unknown)=>value as Record<string,unknown>},plan:pairPlan}});
    await admin.unsafe(generateObserverMigration(compatibilityResources,compileManifest(pairQueries,compatibilityResources),{runtimeRole:'routine_runtime'}));
    const pair=createImpact({adapter:postgresAdapter({database:db}),resources:compatibilityResources,queries:pairQueries});
    await pair.validate();
    const input={left:'a',right:'b'};
    const before=await pair.query('pair',input,{scope:'a'});
    const changed=await pair.command({scope:'a'},db=>db.execute(sql`update ${identifier(schema)}.${identifier('compatibility_users')} set name=${'Changed'} where id=${'a'}`));
    expect(await pair.query('pair',input,{scope:'a'})).not.toEqual(before);
    expect(includes(changed.impact,'pair',input)).toBe(true);
    await expect(compilePostgresQuery({text:`select lower(name) from "${schema}".compatibility_users`},compatibilityResources,serverMajor as 14|15|16|17|18,{catalog}))
      .resolves.toMatchObject({reads:[{resource:'users'}]});
    await expect(compilePostgresQuery({text:`select "${schema}".hidden_reader()`},compatibilityResources,serverMajor as 14|15|16|17|18,{catalog}))
      .rejects.toThrow(`UNTRACKED_QUERY_RELATION:${schema}.compatibility_hidden`);
    const discovering=createPostgresCatalogResolver(admin,compatibilityResources,{searchPath:[schema,'public'],parserVersion:serverMajor as 14|15|16|17|18,discoverUnregisteredRelations:true});
    const hiddenPlan=await compilePostgresQuery({text:`select "${schema}".hidden_reader()`},compatibilityResources,serverMajor as 14|15|16|17|18,{catalog:discovering});
    const hiddenResource=`postgres:${schema}.compatibility_hidden`;
    expect(hiddenPlan.reads).toEqual([
      {resource:hiddenResource,columns:'*',bindings:[]},
      {resource:'users',columns:'*',bindings:[]},
    ]);
    expect(discovering.resources[hiddenResource]).toEqual({schema,table:'compatibility_hidden',idColumn:'id',scopeColumn:null,columns:['id']});
    const hiddenQueries=defineQueries({hidden:{input:{parse:(value:unknown)=>value as Record<string,unknown>},plan:hiddenPlan}});
    await admin.unsafe(generateObserverMigration(discovering.resources,compileManifest(hiddenQueries,discovering.resources),{runtimeRole:'routine_runtime'}));
    const hidden=createImpact({adapter:postgresAdapter({database:db}),resources:discovering.resources,queries:hiddenQueries});
    await hidden.validate();
    const hiddenBefore=await hidden.query('hidden',{}, {scope:'a'});
    const hiddenChanged=await hidden.command({scope:'a'},db=>db.execute(sql`delete from ${identifier(schema)}.${identifier('compatibility_hidden')} where id=${'a'}`));
    expect(await hidden.query('hidden',{}, {scope:'a'})).not.toEqual(hiddenBefore);
    expect(includes(hiddenChanged.impact,'hidden',{})).toBe(true);
    await expect(compilePostgresQuery({text:`select now(),id from "${schema}".compatibility_users`},compatibilityResources,serverMajor as 14|15|16|17|18,{catalog}))
      .rejects.toThrow('POSTGRES_QUERY_REQUIRES_FRESHNESS_POLICY');
  });
  it('observes parent and direct-leaf partition and inheritance writes as one logical resource',async()=>{
    await admin.unsafe(`create table "${schema}".events(id int,bucket int,value text,primary key(id,bucket)) partition by range(bucket);
      create table "${schema}".events_early partition of "${schema}".events for values from (0) to (10);
      create table "${schema}".events_late partition of "${schema}".events for values from (10) to (20);
      create table "${schema}".inherited_events(id int primary key,value text);
      create table "${schema}".inherited_events_child(extra text) inherits("${schema}".inherited_events);
      grant select,insert,update,delete,truncate on "${schema}".events, "${schema}".events_early, "${schema}".events_late,
        "${schema}".inherited_events, "${schema}".inherited_events_child to routine_runtime`);
    const unresolved={
      events:{schema,table:'events',idColumn:['id','bucket'],scopeColumn:null,columns:['id','bucket','value']},
      inherited:{schema,table:'inherited_events',idColumn:'id',scopeColumn:null,columns:['id','value']},
    } as const;
    const hierarchyResources=await resolvePostgresResources(admin,unresolved);
    expect(hierarchyResources.events.physicalRelations).toHaveLength(3);
    expect(hierarchyResources.inherited.physicalRelations).toHaveLength(2);
    const input={parse:(value:unknown)=>value as Record<string,unknown>};
    const hierarchyQueries=defineQueries({
      'events.byId':{input,plan:q.select('events',{where:[q.eq('id',q.input('id'))]})},
      'inherited.byId':{input,plan:q.select('inherited',{where:[q.eq('id',q.input('id'))]})},
    });
    const hierarchyManifest=compileManifest(hierarchyQueries,hierarchyResources);
    await admin.unsafe(generateObserverMigration(hierarchyResources,hierarchyManifest,{runtimeRole:'routine_runtime'}));
    const hierarchy=createImpact({adapter:postgresAdapter({database:db}),resources:hierarchyResources,queries:hierarchyQueries});
    await hierarchy.validate();
    const events=sql`${identifier(schema)}.${identifier('events')}`;
    const early=sql`${identifier(schema)}.${identifier('events_early')}`;
    const inheritedChild=sql`${identifier(schema)}.${identifier('inherited_events_child')}`;
    const parentWrite=await hierarchy.command({scope:'a'},db=>db.execute(sql`insert into ${events} values(${1},${1},${'parent'})`));
    expect(includes(parentWrite.impact,'events.byId',{id:1})).toBe(true);
    const leafWrite=await hierarchy.command({scope:'a'},db=>db.execute(sql`insert into ${early} values(${2},${2},${'leaf'})`));
    expect(includes(leafWrite.impact,'events.byId',{id:2})).toBe(true);
    const moved=await hierarchy.command({scope:'a'},db=>db.execute(sql`update ${events} set bucket=${11} where id=${1}`));
    expect(includes(moved.impact,'events.byId',{id:1})).toBe(true);
    const inheritedWrite=await hierarchy.command({scope:'a'},db=>db.execute(sql`insert into ${inheritedChild}(id,value,extra) values(${3},${'child'},${'extra'})`));
    expect(includes(inheritedWrite.impact,'inherited.byId',{id:3})).toBe(true);
    await admin.unsafe(`create table "${schema}".events_future partition of "${schema}".events for values from (20) to (30)`);
    await expect(hierarchy.validate()).rejects.toThrow('RELATION_TOPOLOGY_DRIFT');
    const installed=await migratePostgresArtifacts(admin,unresolved,hierarchyManifest,{runtimeRole:'routine_runtime'});
    expect(installed.impact.targets.map(target=>target.endpoint)).toEqual(['events.byId','inherited.byId']);
    const next=createImpact({adapter:postgresAdapter({database:db}),resources:installed.resources,queries:hierarchyQueries});
    const future=await next.command({scope:'a'},db=>db.execute(sql`insert into ${events} values(${4},${21},${'future'})`));
    expect(includes(future.impact,'events.byId',{id:4})).toBe(true);
  });
  it('keeps COPY and cursor protocols inside the guarded physical session',async()=>{
    const orders=sql`${identifier(schema)}.${identifier('orders')}`;
    await expect(engine.command({scope:'a'},db=>db.copyFrom(
      sql`copy ${orders}(id,tenant_id,customer_id,status,priority,note) from stdin with (format csv)`,
      ['copy-forbidden,a,copy,ready,1,\n'],
    ))).rejects.toMatchObject({code:'0A000'});
    await admin.unsafe(`create table "${schema}".copy_rows(id text primary key,group_id text not null,value int not null);
      grant select,insert,update,delete on "${schema}".copy_rows to routine_runtime`);
    const copyResources={copy:{schema,table:'copy_rows',idColumn:'id',scopeColumn:null,columns:['id','group_id','value']}} as const;
    const copyQueries=defineQueries({'copy.byGroup':{input:{parse:(value:unknown)=>value as Record<string,unknown>},plan:q.select('copy',{where:[q.eq('group_id',q.input('group'))]})}});
    await admin.unsafe(generateObserverMigration(copyResources,compileManifest(copyQueries,copyResources),{runtimeRole:'routine_runtime'}));
    const copyEngine=createImpact({adapter:postgresAdapter({database:db}),resources:copyResources,queries:copyQueries});
    await copyEngine.validate();
    const table=sql`${identifier(schema)}.${identifier('copy_rows')}`;
    const copied=await copyEngine.command({scope:'a'},db=>db.copyFrom(
      sql`copy ${table}(id,group_id,value) from stdin with (format csv)`,
      ['copy-one,copy,1\n','copy-two,copy,2\n'],
    ));
    expect(includes(copied.impact,'copy.byGroup',{group:'copy'})).toBe(true);
    const cursorRows=await copyEngine.command({scope:'a'},async db=>{
      const rows:Record<string,unknown>[]=[];
      for await(const batch of db.cursor(sql`select id from ${table} where id like ${'copy-%'} order by id`,1))rows.push(...batch);
      return rows;
    });
    expect(cursorRows.data).toEqual([{id:'copy-one'},{id:'copy-two'}]);
    const exported=await copyEngine.command({scope:'a'},async db=>{
      const chunks:Uint8Array[]=[];
      for await(const chunk of db.copyTo(sql`copy (select id from ${table} where id like 'copy-%' order by id) to stdout`))chunks.push(chunk);
      return Buffer.concat(chunks).toString('utf8');
    });
    expect(exported.data).toBe('copy-one\ncopy-two\n');
    await expect(copyEngine.command({scope:'a'},async db=>{
      db.cursor(sql`select id from ${table}`);
    })).rejects.toThrow('UNAWAITED_DATABASE_OPERATION');
  });
  it('marks a materialized view only after its refresh succeeds',async()=>{
    await admin.unsafe(`create table "${schema}".material_source(id text primary key,value text not null);
      insert into "${schema}".material_source values('one','before');
      create materialized view "${schema}".material_snapshot as select * from "${schema}".material_source;
      grant usage,create on schema "${schema}" to routine_runtime;
      grant select on "${schema}".material_source to routine_runtime;
      alter materialized view "${schema}".material_snapshot owner to routine_runtime`);
    const materialResources={snapshot:{schema,table:'material_snapshot',idColumn:null,scopeColumn:null,columns:['id','value'],postgresKind:'materialized-view'}} as const;
    const materialQueries=defineQueries({'snapshot.all':{input:{parse:(value:unknown)=>value as Record<string,unknown>},plan:q.select('snapshot')}});
    await admin.unsafe(generateObserverMigration(materialResources,compileManifest(materialQueries,materialResources),{runtimeRole:'routine_runtime'}));
    const material=createImpact({adapter:postgresAdapter({database:db}),resources:materialResources,queries:materialQueries});
    await material.validate();
    expect(await material.query('snapshot.all',{}, {scope:'a'})).toEqual([{id:'one',value:'before'}]);
    await admin.unsafe(`insert into "${schema}".material_source values('two','after')`);
    expect(await material.query('snapshot.all',{}, {scope:'a'})).toEqual([{id:'one',value:'before'}]);
    const refreshed=await material.command({scope:'a'},db=>db.refreshMaterializedView('snapshot'));
    expect(refreshed.impact.targets).toEqual([{endpoint:'snapshot.all',scope:'global',selector:{kind:'all'}}]);
    expect(await material.query('snapshot.all',{}, {scope:'a'})).toEqual([{id:'one',value:'before'},{id:'two',value:'after'}]);
    await admin.unsafe(`insert into "${schema}".material_source values('three','rolled-back')`);
    const rolledBack=await material.command({scope:'a'},async db=>{
      await expect(db.savepoint(async child=>{await child.refreshMaterializedView('snapshot');throw new Error('rollback refresh');})).rejects.toThrow('rollback refresh');
    });
    expect(rolledBack.impact.targets).toEqual([]);
    expect(await material.query('snapshot.all',{}, {scope:'a'})).toEqual([{id:'one',value:'before'},{id:'two',value:'after'}]);
    await expect(material.command({scope:'a'},db=>db.refreshMaterializedView('missing'))).rejects.toThrow('MATERIALIZED_VIEW_RESOURCE_REQUIRED');
  });
  it('refuses startup when an installed observer function was replaced',async()=>{
    const manifest=compileManifest(queries,resources);
    const fingerprint=observerFingerprint(resources,manifest);
    const layout=observerLayout(fingerprint);
    const functionName=observerInternals.functionName('orders','insert');
    await admin.unsafe(`create or replace function ${layout.internalSchema}.${functionName}() returns trigger
      language plpgsql security invoker set search_path=pg_catalog,pg_temp
      as $$begin return null;end$$`);
    const fresh=createImpact({adapter:postgresAdapter({database:db,setup}),resources,queries});
    try {
      await expect(fresh.validate()).rejects.toThrow('OBSERVER_COVERAGE_MISMATCH');
    } finally {
      await admin.unsafe(generateObserverMigration(resources,manifest,{runtimeRole:'routine_runtime'}));
    }
    await expect(createImpact({adapter:postgresAdapter({database:db,setup}),resources,queries}).validate()).resolves.toBeUndefined();
  });
});
