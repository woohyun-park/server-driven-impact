import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { Pool } from 'pg';
import { compileManifest, createImpact, q, type QueryManifest, type Resources } from '@server-driven-impact/runtime';
import { generateObserverMigration, identifier, postgresAdapter, sql } from '@server-driven-impact/postgres';
import { pgDatabase } from '@server-driven-impact/postgres/pg';
import { validateCatalog } from '../../packages/sdi-postgres/src/postgres/catalog.js';

const adminUrl=process.env.SDI_POSTGRES_ADMIN_URL;
const runtimeUrl=process.env.SDI_POSTGRES_RUNTIME_URL;
const enabled=!!adminUrl && !!runtimeUrl;
if(process.env.SDI_POSTGRES_REQUIRED==='1' && !enabled)throw new Error('POSTGRES_FIXTURES_REQUIRED');
if(enabled && !['127.0.0.1','localhost','::1'].includes(new URL(adminUrl!).hostname))throw new Error('LOCAL_FIXTURES_ONLY');
const input={parse:(value:unknown)=>value};

describe.skipIf(!enabled)('RLS hidden row and column dependencies',()=>{
  const schema='sdi_rls_'+randomUUID().replaceAll('-','');
  const admin=enabled?postgres(adminUrl!,{max:1,prepare:false,onnotice:()=>{}}):undefined!;
  const pool=enabled && process.env.SDI_POSTGRES_DRIVER==='pg'?new Pool({connectionString:runtimeUrl,max:1}):undefined;
  const database=enabled?(pool?{...pgDatabase(pool),end:()=>pool.end()} as unknown as postgres.Sql:postgres(runtimeUrl!,{max:1,prepare:false,onnotice:()=>{}})):undefined!;
  const controls={schema,table:'controls',idColumn:'id',scopeColumn:null,columns:['id','status','tenant']} as const;
  const secured={schema,table:'secured',idColumn:'id',scopeColumn:null,columns:['id','status']} as const;
  beforeAll(async()=>{
    await admin.unsafe(`create schema "${schema}";
      create table "${schema}".controls(id text primary key,status text,tenant text);
      create table "${schema}".secured(id text primary key,status text);
      create table "${schema}".selfread(id text primary key,status text);
      create table "${schema}".simple(id text primary key,tenant text,visible boolean);
      create table "${schema}".inline_self(id text primary key,status text);
      insert into "${schema}".secured values('visible','visible');
      create function "${schema}".can_read() returns boolean language sql stable security definer
        as $$select exists(select 1 from "${schema}".controls where status='permit')$$;
      create function "${schema}".can_read_self() returns boolean language sql stable security definer
        as $$select exists(select 1 from "${schema}".selfread where status='permit')$$;
      alter table "${schema}".secured enable row level security;
      create policy access on "${schema}".secured using("${schema}".can_read());
      alter table "${schema}".selfread enable row level security;
      create policy access on "${schema}".selfread using("${schema}".can_read_self());
      alter table "${schema}".inline_self enable row level security;
      create policy access on "${schema}".inline_self using(exists(select 1 from "${schema}".inline_self gate where gate.status='permit'));
      alter table "${schema}".simple enable row level security;
      create policy access on "${schema}".simple using(tenant=current_setting('sdi.tenant',true) and visible);
      grant usage on schema "${schema}" to routine_runtime;
      grant select,insert,update,delete on all tables in schema "${schema}" to routine_runtime;`);
  });
  afterAll(async()=>{await database.end();await admin.unsafe(`drop schema if exists "${schema}" cascade`);await admin.end();});
  it('rejects a q projection that omits a same-row RLS column while permitting explicit coverage',async()=>{
    const resources:Resources={simple:{schema,table:'simple',idColumn:'id',scopeColumn:'tenant',columns:['id','tenant','visible']}};
    const narrow=compileManifest({simple:{input,plan:q.select('simple',{columns:['id']})}},resources);
    await expect(validateCatalog(admin,resources,narrow)).rejects.toThrow('UNRESOLVED_RLS_COLUMN_DEPENDENCY:simple');
    const covered=compileManifest({simple:{input,plan:q.select('simple',{columns:['id','visible']})}},resources);
    expect([...await validateCatalog(admin,resources,covered)]).toEqual([]);
    await admin.unsafe(`alter policy access on "${schema}".simple using((to_jsonb(simple)->>'visible')::boolean)`);
    const wholeRow=compileManifest({simple:{input,plan:q.select('simple',{columns:['visible']})}},resources);
    await expect(validateCatalog(admin,resources,wholeRow)).rejects.toThrow('UNRESOLVED_RLS_COLUMN_DEPENDENCY');
  });
  it('requires broad hidden resource paths and disables literal proofs regardless of catalog iteration order',async()=>{
    const resources:Resources={controls,secured};
    const broad:QueryManifest={protocolVersion:1,reads:{visible:[{resource:'secured',columns:'*',bindings:[]},{resource:'controls',columns:'*',bindings:[],filters:[{column:'status',value:'visible'}]}]}};
    const narrowed:QueryManifest={protocolVersion:1,reads:{visible:[broad.reads.visible[0],{...broad.reads.visible[1],bindings:[{column:'id',input:'id'}]}]}};
    await expect(validateCatalog(admin,resources,narrowed)).rejects.toThrow('UNRESOLVED_RLS_COLUMN_DEPENDENCY');
    await expect(validateCatalog(admin,resources,{protocolVersion:1,reads:{visible:[broad.reads.visible[0]]}})).rejects.toThrow('UNRESOLVED_RLS_DEPENDENCY');
    expect([...await validateCatalog(admin,resources,broad)]).toEqual([]);
    expect([...await validateCatalog(admin,{secured,controls},broad)]).toEqual([]);
    const queries={visible:{input,plan:{kind:'postgres-query' as const,text:`select id from "${schema}".secured`,parameters:[],reads:broad.reads.visible}}};
    const manifest=compileManifest(queries,resources);
    await admin.unsafe(generateObserverMigration(resources,manifest,{runtimeRole:'routine_runtime'}));
    const engine=createImpact({adapter:postgresAdapter({database}),resources,queries});
    await engine.validate();
    expect(await engine.query('visible',{}, {scope:null})).toEqual([]);
    const changed=await engine.command({scope:null},tx=>tx.execute(sql`insert into ${identifier(schema)}.controls values('gate','permit','other-tenant')`));
    expect(await engine.query('visible',{}, {scope:null})).toEqual([{id:'visible'}]);
    expect(changed.impact.targets).toEqual([{endpoint:'visible',scope:'global',selector:{kind:'all'}}]);
  });
  it('rejects same-table helper bindings and unproved cross-tenant hidden dependencies',async()=>{
    const resources:Resources={selfread:{schema,table:'selfread',idColumn:'id',scopeColumn:null,columns:['id','status']}};
    const narrow=compileManifest({selfread:{input,plan:q.select('selfread',{where:[q.eq('id',q.input('id'))]})}},resources);
    await expect(validateCatalog(admin,resources,narrow)).rejects.toThrow('UNRESOLVED_RLS_COLUMN_DEPENDENCY');
    const broad=compileManifest({selfread:{input,plan:q.select('selfread')}},resources);
    expect([...await validateCatalog(admin,resources,broad)]).toEqual([]);
    const inline:Resources={inline:{schema,table:'inline_self',idColumn:'id',scopeColumn:null,columns:['id','status']}};
    const inlineBound=compileManifest({inline:{input,plan:q.select('inline',{where:[q.eq('id',q.input('id'))]})}},inline);
    await expect(validateCatalog(admin,inline,inlineBound)).rejects.toThrow('UNRESOLVED_RLS_COLUMN_DEPENDENCY');
    const scoped:Resources={controls:{...controls,scopeColumn:'tenant'},secured};
    await expect(validateCatalog(admin,scoped,{protocolVersion:1,reads:{visible:[{resource:'secured',columns:'*',bindings:[]},{resource:'controls',columns:'*',bindings:[]}]}})).rejects.toThrow('UNRESOLVED_RLS_SCOPE_DEPENDENCY');
  });
});
