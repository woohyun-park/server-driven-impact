import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { Pool } from 'pg';
import { createImpact, type Resources } from '@server-driven-impact/runtime';
import { compilePostgresArtifacts, generateObserverMigration, identifier, postgresAdapter, sql, type PostgresMajor } from '@server-driven-impact/postgres';
import { pgDatabase } from '@server-driven-impact/postgres/pg';

const adminUrl=process.env.SDI_POSTGRES_ADMIN_URL;
const runtimeUrl=process.env.SDI_POSTGRES_RUNTIME_URL;
const enabled=!!adminUrl && !!runtimeUrl;
if(process.env.SDI_POSTGRES_REQUIRED==='1' && !enabled)throw new Error('POSTGRES_FIXTURES_REQUIRED');
if(enabled && !['127.0.0.1','localhost','::1'].includes(new URL(adminUrl!).hostname))throw new Error('LOCAL_FIXTURES_ONLY');

describe.skipIf(!enabled)('PostgreSQL automatic observed-column precision',()=>{
  const schema='sdi_precision_'+randomUUID().replaceAll('-','');
  const admin=enabled?postgres(adminUrl!,{max:1,prepare:false,onnotice:()=>{}}):undefined!;
  const pool=enabled && process.env.SDI_POSTGRES_DRIVER==='pg'?new Pool({connectionString:runtimeUrl,max:1}):undefined;
  const database=enabled?(pool?{...pgDatabase(pool),end:()=>pool.end()} as unknown as postgres.Sql:postgres(runtimeUrl!,{max:1,prepare:false,onnotice:()=>{}})):undefined!;
  const resources:Resources={
    records:{schema,table:'records',idColumn:'id',scopeColumn:null,columns:['id','status','rank','label_id','note']},
    labels:{schema,table:'labels',idColumn:'id',scopeColumn:null,columns:['id','label','note']},
    secured:{schema,table:'secured',idColumn:'id',scopeColumn:null,columns:['id','visible','note']},
  };
  const input={parse:(value:unknown)=>value};
  beforeAll(async()=>{
    await admin.unsafe(`create schema "${schema}";
      create table "${schema}".records(id text primary key,status text,rank integer,label_id text,note text);
      create table "${schema}".labels(id text primary key,label text,note text);
      create table "${schema}".secured(id text primary key,visible boolean,note text);
      insert into "${schema}".records values('one','ready',1,'l',''),('two','ready',2,'l','');
      insert into "${schema}".labels values('l','old','');
      insert into "${schema}".secured values('one',true,'');
      grant usage on schema "${schema}" to routine_runtime;
      grant select,insert,update,delete on all tables in schema "${schema}" to routine_runtime;
      alter table "${schema}".secured enable row level security;
      create policy visibility on "${schema}".secured for select to routine_runtime using(visible);
      create policy allow_update on "${schema}".secured for update to routine_runtime using(true) with check(true);
      create function "${schema}".hide_secured() returns void language sql security definer set search_path=pg_catalog
      as $$update "${schema}".secured set visible=false where id='one'$$;`);
  });
  afterAll(async()=>{await database.end();await admin.unsafe(`drop schema if exists "${schema}" cascade`);await admin.end();});
  it('automatically excludes unrelated updates and includes actual filter, page, join and RLS result changes',async()=>{
    const version=Math.floor(Number((await admin.unsafe("select current_setting('server_version_num')::int as n"))[0].n)/10000) as PostgresMajor;
    const definition=(text:string,parameters:string[]=[])=>({input,source:{text,parameters},onUnresolved:'reject' as const});
    const artifact=await compilePostgresArtifacts(admin,resources,{
      detail:definition(`select id from "${schema}".records where id=$1`,['id']),
      page:definition(`select id from "${schema}".records where status=$1 order by rank limit 1`,['status']),
      count:definition(`select count(*)::int as total from "${schema}".records where status=$1`,['status']),
      joined:definition(`select r.id,l.label from "${schema}".records r join "${schema}".labels l on l.id=r.label_id where r.status=$1 order by r.id`,['status']),
      secured:definition(`select id from "${schema}".secured`),
    },{version,searchPath:[schema,'public']});
    expect(artifact.manifest.reads.detail).toEqual([{resource:'records',columns:['id'],bindings:[]}]);
    expect(artifact.manifest.reads.page).toEqual([{resource:'records',columns:['id','rank','status'],bindings:[]}]);
    expect(artifact.manifest.reads.count).toEqual([{resource:'records',columns:['status'],bindings:[]}]);
    expect(artifact.manifest.reads.secured).toEqual([{resource:'secured',columns:['id','visible'],bindings:[]}]);
    await admin.unsafe(generateObserverMigration(artifact.resources,artifact.manifest,{runtimeRole:'routine_runtime'}));
    const engine=createImpact({adapter:postgresAdapter({database}),resources:artifact.resources,queries:artifact.queries});
    await engine.validate();
    const context={scope:null};
    const endpoints=(impact:{targets:{endpoint:string}[]})=>impact.targets.map(target=>target.endpoint).sort();
    const read=()=>Promise.all([
      engine.query('detail',{id:'one'},context),engine.query('page',{status:'ready'},context),
      engine.query('count',{status:'ready'},context),engine.query('joined',{status:'ready'},context),
    ]);
    const before=await read();
    const irrelevant=await engine.command(context,tx=>tx.execute(sql`update ${identifier(schema)}.records set note='changed'`));
    expect(await read()).toEqual(before);
    expect(irrelevant.impact.targets).toEqual([]);
    const reordered=await engine.command(context,tx=>tx.execute(sql`update ${identifier(schema)}.records set rank=3 where id='one'`));
    expect((await read())[1]).not.toEqual(before[1]);
    expect(endpoints(reordered.impact)).toEqual(['page']);
    const beforeFilter=await read();
    const filtered=await engine.command(context,tx=>tx.execute(sql`update ${identifier(schema)}.records set status='done' where id='two'`));
    const afterFilter=await read();
    for(const index of [1,2,3])expect(afterFilter[index]).not.toEqual(beforeFilter[index]);
    expect(endpoints(filtered.impact)).toEqual(['count','joined','page']);
    const beforeJoin=afterFilter[3];
    const joined=await engine.command(context,tx=>tx.execute(sql`update ${identifier(schema)}.labels set label='new'`));
    expect((await read())[3]).not.toEqual(beforeJoin);
    expect(endpoints(joined.impact)).toEqual(['joined']);
    expect(await engine.query('secured',{},context)).toEqual([{id:'one'}]);
    const secured=await engine.command(context,tx=>tx.execute(sql`select ${identifier(schema)}.hide_secured()`));
    expect(await engine.query('secured',{},context)).toEqual([]);
    expect(endpoints(secured.impact)).toEqual(['secured']);
  });
});
