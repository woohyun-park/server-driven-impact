import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { Pool } from 'pg';
import { compileManifest, createImpact, q, type QueryManifest, type Resources } from '@server-driven-impact/runtime';
import { compilePostgresArtifacts, generateObserverMigration, identifier, postgresAdapter, sql, type PostgresMajor } from '@server-driven-impact/postgres';
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

describe.skipIf(!enabled)('RLS command, role and column precision',()=>{
  const schema='sdi_policy_'+randomUUID().replaceAll('-','');
  const roleA=schema+'_a',roleB=schema+'_b',roleC=schema+'_c',owner=schema+'_owner',bypass=schema+'_bypass';
  const admin=enabled?postgres(adminUrl!,{max:1,prepare:false,onnotice:()=>{}}):undefined!;
  const pool=enabled && process.env.SDI_POSTGRES_DRIVER==='pg'?new Pool({connectionString:runtimeUrl,max:1}):undefined;
  const database=enabled?(pool?{...pgDatabase(pool),end:()=>pool.end()} as unknown as postgres.Sql:postgres(runtimeUrl!,{max:1,prepare:false,onnotice:()=>{}})):undefined!;
  let version:PostgresMajor;
  const resources:Resources=Object.fromEntries([
    ['profile',['uid','superuser','birthday']],['badge',['id','owner_id','visible']],
    ['secured',['id','owner_id','visible']],['helper',['id','owner_id','visible']],
    ['atomic',['id','owner_id','visible']],['checked',['id','owner_id','visible']],
    ['roles',['id','owner_id','visible']],['owned',['id','owner_id','visible']],
    ['opaque',['id','owner_id','visible']],
  ].map(([table,columns])=>[table,{schema,table,idColumn:table==='profile'?'uid':'id',scopeColumn:null,columns}])) as Resources;
  const definition=(table:string,suffix='')=>({input,source:{text:`select id from "${schema}"."${table}" ${suffix}`},onUnresolved:'reject' as const});
  const compile=(definitions:Parameters<typeof compilePostgresArtifacts>[2],effectiveRole?:string)=>compilePostgresArtifacts(admin,resources,definitions,{version,searchPath:[schema,'public'],effectiveRole});
  beforeAll(async()=>{
    version=Math.floor(Number((await admin.unsafe("select current_setting('server_version_num')::int as n"))[0].n)/10000) as PostgresMajor;
    await admin.unsafe(`create schema "${schema}";
      create role "${roleA}"; create role "${roleB}"; create role "${roleC}" noinherit; create role "${owner}"; create role "${bypass}" bypassrls;
      grant "${roleA}" to "${roleB}";
      grant "${roleA}" to "${roleC}";
      grant "${roleB}","${owner}","${bypass}" to routine_runtime;
      create table "${schema}".profile(uid text primary key,superuser boolean,birthday text);
      ${['badge','secured','helper','atomic','checked','roles','owned','opaque'].map(table=>`create table "${schema}".${table}(id text primary key,owner_id text,visible boolean); insert into "${schema}".${table} values('one','caller',true); alter table "${schema}".${table} enable row level security;`).join('\n')}
      create function "${schema}".is_superuser() returns boolean language sql stable security definer
        as $$select exists(select 1 from "${schema}".profile p where p.uid='caller' and p.superuser)$$;
      create function "${schema}".is_superuser_atomic() returns boolean language sql stable security definer
        begin atomic select exists(select 1 from "${schema}".profile p where p.uid='caller' and p.superuser); end;
      create function "${schema}".opaque_read() returns boolean language plpgsql stable as $$begin return true; end$$;
      create policy public_read on "${schema}".badge for select using(true);
      create policy admin_update on "${schema}".badge for update using("${schema}".is_superuser()) with check("${schema}".opaque_read());
      create policy admin_insert on "${schema}".badge for insert with check("${schema}".opaque_read());
      create policy admin_delete on "${schema}".badge for delete using("${schema}".opaque_read());
      create policy selected on "${schema}".secured for select using(exists(select 1 from "${schema}".profile p where p.uid=secured.owner_id and p.superuser));
      create policy selected on "${schema}".helper for select using("${schema}".is_superuser());
      create policy selected on "${schema}".atomic for select using("${schema}".is_superuser_atomic());
      create policy checked on "${schema}".checked for all using(visible) with check("${schema}".is_superuser());
      create policy public_read on "${schema}".roles for select using(true);
      create policy role_read on "${schema}".roles for select to "${roleA}" using("${schema}".is_superuser());
      create policy restricted on "${schema}".roles as restrictive for select using(visible);
      create policy selected on "${schema}".owned for select using(false);
      alter table "${schema}".owned owner to "${owner}";
      create policy opaque on "${schema}".opaque for select using("${schema}".opaque_read());
      grant usage on schema "${schema}" to routine_runtime,"${roleA}","${roleB}","${owner}","${bypass}";
      grant select,insert,update,delete on all tables in schema "${schema}" to routine_runtime,"${roleA}","${roleB}","${bypass}";`);
  });
  afterAll(async()=>{
    await database.end();
    await admin.unsafe(`drop schema if exists "${schema}" cascade; drop role "${roleB}","${roleC}","${roleA}","${owner}","${bypass}"`);
    await admin.end();
  });
  it('excludes UPDATE and WITH CHECK reads, while locking SELECT retains UPDATE USING',async()=>{
    const artifact=await compile({badge:definition('badge'),checked:definition('checked'),locked:definition('badge','for share'),checkedLocked:definition('checked','for update')},'routine_runtime');
    expect(artifact.manifest.reads.badge).toEqual([{resource:'badge',columns:['id'],bindings:[]}]);
    expect(artifact.manifest.reads.checked).toEqual([{resource:'checked',columns:['id','visible'],bindings:[]}]);
    expect(artifact.manifest.reads.checkedLocked).toEqual([{resource:'checked',columns:['id','visible'],bindings:[]}]);
    expect(artifact.manifest.reads.locked).toContainEqual({resource:'profile',columns:['superuser','uid'],bindings:[]});
    await expect(validateCatalog(admin,resources,artifact.manifest)).resolves.toBeDefined();
    expect(await database.unsafe(`select id from "${schema}".badge`)).toHaveLength(1);
    expect(await database.unsafe(`select id from "${schema}".badge for share`)).toHaveLength(0);
    await expect(admin.unsafe(`create policy invalid on "${schema}".badge for select with check(true)`)).rejects.toMatchObject({code:'42601'});
    const minimal=await compilePostgresArtifacts(admin,{badge:resources.badge},{badge:definition('badge')},{version,searchPath:[schema],effectiveRole:'routine_runtime'});
    expect(Object.keys(minimal.resources)).toEqual(['badge']);
  });
  it('compares actual SELECT results and impacts for unrelated UPDATE, gate INSERT/UPDATE/DELETE and SQL helpers',async()=>{
    const artifact=await compile({badge:definition('badge'),secured:definition('secured'),helper:definition('helper'),atomic:definition('atomic')},'routine_runtime');
    for(const endpoint of ['secured','helper','atomic'])expect(artifact.manifest.reads[endpoint]).toContainEqual({resource:'profile',columns:['superuser','uid'],bindings:[]});
    expect(artifact.manifest.reads.secured).toContainEqual({resource:'secured',columns:['id','owner_id'],bindings:[]});
    await admin.unsafe(generateObserverMigration(resources,artifact.manifest,{runtimeRole:'routine_runtime'}));
    const engine=createImpact({adapter:postgresAdapter({database}),resources,queries:artifact.queries});
    await engine.validate();
    const context={scope:null};
    const names=['badge','secured','helper','atomic'];
    const snapshot=()=>Promise.all(names.map(name=>engine.query(name,{},context)));
    const check=async(statement:ReturnType<typeof sql>)=>{
      const before=await snapshot();const result=await engine.command(context,tx=>tx.execute(statement));const after=await snapshot();
      const changed=names.filter((_,index)=>JSON.stringify(before[index])!==JSON.stringify(after[index])).sort();
      expect(result.impact.targets.map(target=>target.endpoint).sort()).toEqual(changed);
      return changed;
    };
    expect(await check(sql`insert into ${identifier(schema)}.profile values('caller',true,'old')`)).toEqual(['atomic','helper','secured']);
    expect(await check(sql`update ${identifier(schema)}.profile set birthday='new'`)).toEqual([]);
    expect(await check(sql`update ${identifier(schema)}.profile set superuser=false`)).toEqual(['atomic','helper','secured']);
    expect(await check(sql`update ${identifier(schema)}.profile set superuser=true`)).toEqual(['atomic','helper','secured']);
    expect(await check(sql`delete from ${identifier(schema)}.profile`)).toEqual(['atomic','helper','secured']);
  });
  it('selects effective roles and inherited membership, retaining permissive and restrictive dependencies',async()=>{
    const inherited=await compile({roles:definition('roles')},roleB);
    expect(inherited.manifest.reads.roles).toContainEqual({resource:'profile',columns:['superuser','uid'],bindings:[]});
    expect(inherited.manifest.reads.roles).toContainEqual({resource:'roles',columns:['id','visible'],bindings:[]});
    const unrelated=await compile({roles:definition('roles')},owner);
    expect(unrelated.manifest.reads.roles).toEqual([{resource:'roles',columns:['id','visible'],bindings:[]}]);
    const nonInherited=await compile({roles:definition('roles')},roleC);
    expect(nonInherited.manifest.reads.roles).toEqual(unrelated.manifest.reads.roles);
    await admin.unsafe(generateObserverMigration(resources,inherited.manifest,{runtimeRole:'routine_runtime'}));
    const engine=createImpact({adapter:postgresAdapter({database,setup:async tx=>{await tx.unsafe(`set local role "${roleB}"`);}}),resources,queries:inherited.queries});
    await engine.validate();
    expect(await engine.query('roles',{}, {scope:null})).toEqual([{id:'one'}]);
    await admin.unsafe(`update "${schema}".roles set visible=false`);
    expect(await engine.query('roles',{}, {scope:null})).toEqual([]);
    await admin.unsafe(`update "${schema}".roles set visible=true`);
    const wrong=createImpact({adapter:postgresAdapter({database}),resources,queries:inherited.queries});
    await expect(wrong.query('roles',{}, {scope:null})).rejects.toThrow('POSTGRES_ARTIFACT_ROLE_MISMATCH');
  });
  it('honors owner, FORCE RLS and BYPASSRLS, and rejects stale definitions',async()=>{
    const readAs=(role:string)=>admin.begin(async tx=>{await tx.unsafe(`set local role "${role}"`);return [...await tx.unsafe(`select id from "${schema}".owned`)];});
    const ownerArtifact=await compile({owned:definition('owned')},owner);
    expect(ownerArtifact.queries.owned.plan.kind==='postgres-query' && ownerArtifact.queries.owned.plan.policyProof?.dependencies).toEqual([]);
    expect(await readAs(owner)).toEqual([{id:'one'}]);
    await admin.unsafe(`alter table "${schema}".owned force row level security`);
    await expect(validateCatalog(admin,resources,ownerArtifact.manifest)).rejects.toThrow('POSTGRES_ARTIFACT_DRIFT');
    const forced=await compile({owned:definition('owned')},owner);
    expect(forced.queries.owned.plan.kind==='postgres-query' && forced.queries.owned.plan.policyProof?.dependencies).toHaveLength(1);
    expect(await readAs(owner)).toEqual([]);
    for(const role of [bypass,'postgres']){
      const artifact=await compile({owned:definition('owned')},role);
      expect(artifact.queries.owned.plan.kind==='postgres-query' && artifact.queries.owned.plan.policyProof?.dependencies).toEqual([]);
      expect(await readAs(role)).toEqual([{id:'one'}]);
    }
    await admin.unsafe(`alter policy selected on "${schema}".owned using(visible)`);
    await expect(validateCatalog(admin,resources,forced.manifest)).rejects.toThrow('POSTGRES_ARTIFACT_DRIFT');
  });
  it('rejects unknown function resources or marks the query no-store',async()=>{
    await expect(compile({opaque:definition('opaque')})).rejects.toThrow('UNRESOLVED_FUNCTION_BODY');
    const artifact=await compile({opaque:{...definition('opaque'),onUnresolved:'no-store'}});
    expect(artifact.queries.opaque.plan.kind==='postgres-query' && artifact.queries.opaque.plan.cache).toBe('no-store');
  });
  it('uses the SECURITY DEFINER owner inside helpers and retains external INSERT/DELETE reads',async()=>{
    await admin.unsafe(`alter table "${schema}".profile enable row level security;
      create policy hidden_profile on "${schema}".profile for select using(false);
      insert into "${schema}".profile values('caller',true,'old')`);
    try{
      const artifact=await compile({secured:definition('secured'),helper:definition('helper')},'routine_runtime');
      await admin.unsafe(generateObserverMigration(resources,artifact.manifest,{runtimeRole:'routine_runtime'}));
      const engine=createImpact({adapter:postgresAdapter({database}),resources,queries:artifact.queries});
      await engine.validate();
      expect(await engine.query('secured',{}, {scope:null})).toEqual([]);
      expect(await engine.query('helper',{}, {scope:null})).toEqual([{id:'one'}]);
      const proof=artifact.queries.helper.plan.kind==='postgres-query'?artifact.queries.helper.plan.policyProof:undefined;
      expect(proof?.dependencies.filter(read=>read.resource==='profile')).toEqual([{resource:'profile',columns:['superuser','uid'],rowConstraint:'all'}]);
    }finally{await admin.unsafe(`delete from "${schema}".profile; drop policy hidden_profile on "${schema}".profile; alter table "${schema}".profile disable row level security`);}
  });
  it('does not mistake the runtime search_path for the deparser search_path',async()=>{
    await admin.begin(async tx=>{
      await tx.unsafe(`set local search_path="${schema}",public`);
      const artifact=await compilePostgresArtifacts(tx,resources,{secured:definition('secured')},{version,searchPath:['public'],effectiveRole:'routine_runtime'});
      expect(artifact.manifest.reads.secured).toContainEqual({resource:'profile',columns:['superuser','uid'],bindings:[]});
    });
  });
  it('does not reuse a definer proof for an independent structured read in a composed endpoint',async()=>{
    await admin.unsafe(`alter table "${schema}".profile enable row level security;
      create policy hidden_profile on "${schema}".profile for select using(exists(select 1 from "${schema}".badge where visible))`);
    try{
      const artifact=await compile({helper:definition('helper')},'routine_runtime');
      const children={native:artifact.queries.helper.plan,direct:q.select('profile',{columns:['uid']})};
      const mixed=compileManifest({mixed:{input,plan:q.combine(children)}},resources);
      await expect(validateCatalog(admin,resources,mixed)).rejects.toThrow('UNRESOLVED_RLS_DEPENDENCY');
      const covered=compileManifest({mixed:{input,plan:q.combine({...children,gate:q.select('badge',{columns:['visible']})})}},resources);
      await expect(validateCatalog(admin,resources,covered)).resolves.toBeDefined();
      await admin.unsafe(`create function "${schema}".profile_count() returns bigint language sql stable security definer
        as $$select count(*) from "${schema}".profile$$;
        alter function "${schema}".profile_count() owner to "${roleA}"`);
      const scoped={...resources,badge:{...resources.badge,scopeColumn:'owner_id'}};
      const mixedNative=await compilePostgresArtifacts(admin,scoped,{mixed:{input,source:{text:`select uid,"${schema}".profile_count() from "${schema}".profile`},onUnresolved:'reject'}},{version,searchPath:[schema,'public'],effectiveRole:bypass});
      await expect(validateCatalog(admin,scoped,mixedNative.manifest)).rejects.toThrow('UNRESOLVED_RLS_SCOPE_DEPENDENCY');
    }finally{await admin.unsafe(`drop policy hidden_profile on "${schema}".profile; alter table "${schema}".profile disable row level security`);}
  });
  it('widens known CTE and view reads while preserving resources',async()=>{
    await admin.unsafe(`create view "${schema}".profile_view as select uid,superuser from "${schema}".profile;
      create function "${schema}".complex_read() returns boolean language sql stable as
        $$with candidates as (select * from "${schema}".profile) select exists(select 1 from candidates where superuser)$$;
      create policy complex on "${schema}".checked for select using("${schema}".complex_read());
      create policy via_view on "${schema}".checked for select using(exists(select 1 from "${schema}".profile_view v where v.superuser));`);
    const artifact=await compile({checked:definition('checked')},'routine_runtime');
    expect(artifact.manifest.reads.checked).toContainEqual({resource:'profile',columns:'*',bindings:[]});
    await expect(validateCatalog(admin,resources,artifact.manifest)).resolves.toBeDefined();
  });
  it('does not replace session/time freshness with broad row dependencies',async()=>{
    await admin.unsafe(`create policy clock_policy on "${schema}".checked for select using(current_timestamp is not null)`);
    await expect(compile({checked:definition('checked')})).rejects.toThrow('POSTGRES_QUERY_REQUIRES_FRESHNESS_POLICY');
    const artifact=await compile({checked:{...definition('checked'),onUnresolved:'no-store'}});
    expect(artifact.queries.checked.plan.kind==='postgres-query' && artifact.queries.checked.plan.cache).toBe('no-store');
  });
});
