import { expect, it, vi } from 'vitest';
import { createImpact, q } from '@server-driven-impact/runtime';
import { observerFingerprint, postgresAdapter } from '@server-driven-impact/postgres';
import { observerInternals } from '../../packages/sdi-postgres/src/postgres/observer.js';
import { compileManifest } from '@server-driven-impact/runtime';
import type postgres from 'postgres';

const resources = { parent: { table: 'parent', idColumn: 'id', scopeColumn: null, columns: ['id','title','secret'], selectorColumns: ['id'] } };
function fixture(commitError?: Error & {code?:string}, failures: {collection?:Error;rollback?:Error} = {}) {
  const queries = { list: {input:{parse:(v:unknown)=>v},plan:q.select('parent')} };
  const fingerprint = observerFingerprint(resources,compileManifest(queries,resources));
  const definitionHashes=Object.fromEntries(['delete','insert','truncate','update'].map(operation=>[observerInternals.functionName('parent',operation),'hash']));
  const catalogResult = async (text:string) => {
    if (text.includes('observer_manifest')) return [{fingerprint,definition_hashes:definitionHashes}];
    if (text.includes('from pg_trigger')) return ['delete','insert','truncate','update'].map(operation=>({
      schema_name:'public',table_name:'parent',tgname:`sdi_observe_${operation}`,tgenabled:'O',
      trigger_type:{insert:4,delete:8,update:16,truncate:32}[operation as 'insert'|'delete'|'update'|'truncate'],
      function_schema:`sdi_${fingerprint.slice(0,12)}`,function_name:observerInternals.functionName('parent',operation),
      row_level:false,before_trigger:false,instead_trigger:false,
      tgoldtable:['delete','update'].includes(operation)?'sdi_old_rows':null,
      tgnewtable:['insert','update'].includes(operation)?'sdi_new_rows':null,
      prosecdef:false,proconfig:['search_path=pg_catalog, pg_temp'],lanname:'plpgsql',function_hash:'hash',
    }));
    return [{oid:'1',relkind:'r',relispartition:false,relhasrules:false,relrowsecurity:false,inherited:false,pk:['id'],columns:['id','title','secret']}];
  };
  const tx = { unsafe: vi.fn(async (text: string) => {
    if (text === 'commit' && commitError) throw commitError;
    if(text==='rollback' && failures.rollback)throw failures.rollback;
    if(text.includes('delete from pg_temp.') && failures.collection)throw failures.collection;
    if (text.includes('pg_class') || text.includes('pg_trigger') || text.includes('observer_manifest')) return catalogResult(text);
    return [];
  }) };
  const release=vi.fn(async()=>undefined),discard=vi.fn(async()=>undefined);
  const database = {
    unsafe: vi.fn(catalogResult),
    begin: async (_mode: string, work: (tx: unknown) => Promise<unknown>) => work(tx),
    reserve: async () => ({...tx,release,discard}),
  };
  const engine = createImpact({ adapter: postgresAdapter({database: database as unknown as postgres.Sql}), resources, queries });
  return {engine,release,discard};
}

it('rejects removed CRUD policy and routine options instead of silently ignoring them',()=>{
  const database={begin:()=>undefined} as unknown as postgres.Sql;
  expect(()=>postgresAdapter({database,writeAccess:{}} as never)).toThrow('POSTGRES_LEGACY_COMMAND_OPTIONS_REMOVED');
  expect(()=>postgresAdapter({database,routines:{}} as never)).toThrow('POSTGRES_LEGACY_COMMAND_OPTIONS_REMOVED');
});

it('exposes one flat native PostgreSQL command surface',async()=>{
  await fixture().engine.command({scope:'u'},async db=>{
    expect(Object.keys(db).sort()).toEqual(['copyFrom','copyTo','cursor','execute','refreshMaterializedView','savepoint','scope']);
    expect(db).not.toHaveProperty('insert');
    expect(db).not.toHaveProperty('postgres');
  });
});

it('distinguishes server commit rejection from an unknown network outcome',async()=>{
  const network=Object.assign(new Error('connection lost'),{code:'ECONNRESET'});
  await expect(fixture(network).engine.command({scope:'u'},async()=>1)).rejects.toMatchObject({code:'COMMIT_STATE_UNKNOWN',commitState:'unknown'});
  const resolution=Object.assign(new Error('resolution unknown'),{code:'08007'});
  await expect(fixture(resolution).engine.command({scope:'u'},async()=>1)).rejects.toMatchObject({code:'COMMIT_STATE_UNKNOWN',commitState:'unknown'});
  const deferred=Object.assign(new Error('deferred constraint'),{code:'23505'});
  await expect(fixture(deferred).engine.command({scope:'u'},async()=>1)).rejects.toBe(deferred);
});

it('preserves committed data when collection fails and discards the failed session without retrying',async()=>{
  const {engine,discard,release}=fixture(undefined,{collection:new Error('collector unavailable')});
  const work=vi.fn(async()=>({id:'committed'}));
  await expect(engine.command({scope:'u'},work)).rejects.toMatchObject({code:'IMPACT_UNAVAILABLE',commitState:'committed',data:{id:'committed'}});
  expect(work).toHaveBeenCalledTimes(1);expect(discard).toHaveBeenCalledOnce();expect(release).not.toHaveBeenCalled();
});

it('discards a connection after rollback failure and preserves the original command failure',async()=>{
  const {engine,discard,release}=fixture(undefined,{rollback:new Error('rollback failed')});
  await expect(engine.command({scope:'u'},async()=>{throw new Error('business failed');})).rejects.toThrow('business failed');
  expect(discard).toHaveBeenCalledOnce();expect(release).not.toHaveBeenCalled();
});
