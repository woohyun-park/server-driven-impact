import { expect, it, vi } from 'vitest';
import { createImpact, q } from '@server-driven-impact/runtime';
import { observerFingerprint,postgresAdapter, sql, type PostgresCommandDb, type PostgresWriteAccess } from '@server-driven-impact/postgres';
import { observerInternals } from '../../packages/sdi-postgres/src/postgres/observer.js';
import { compileManifest } from '@server-driven-impact/runtime';
import type postgres from 'postgres';

const resources = { parent: { table: 'parent', idColumn: 'id', scopeColumn: null, columns: ['id','title','secret'], selectorColumns: ['id'] } };
function fixture(access?: PostgresWriteAccess, commitError?: Error & {code?:string}, failures: {collection?:Error;rollback?:Error} = {}) {
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
    if (text.includes('from changed')) return [{count:1,rows:[]}];
    if (text.includes('pg_class') || text.includes('pg_trigger') || text.includes('observer_manifest')) return catalogResult(text);
    return [];
  }) };
  const release=vi.fn(async()=>undefined),discard=vi.fn(async()=>undefined);
  const database = {
    unsafe: vi.fn(catalogResult),
    begin: async (_mode: string, work: (tx: unknown) => Promise<unknown>) => work(tx),
    reserve: async () => ({...tx,release,discard}),
  };
  const engine = createImpact({ adapter: postgresAdapter({database: database as unknown as postgres.Sql, writeAccess: access}), resources,
    queries });
  return {engine,tx,database,release,discard};
}
it('native cascades require observer coverage instead of a manual cascade declaration',async()=>{
  await expect(fixture().engine.validate()).resolves.toBeUndefined();
  const {engine,tx}=fixture({parent:{update:['title']}});
  await engine.validate();
  expect(tx.unsafe.mock.calls.some(([sql])=>sql.includes('observer_manifest'))).toBe(true);
});
const denied: [string,(db:PostgresCommandDb)=>Promise<unknown>][] = [
  ['insert',db=>db.insert('parent',[{id:'1'}])],
  ['delete',db=>db.delete('parent',{where:{id:'1'}})],
  ['column',db=>db.update('parent',{where:{id:'1'},set:{secret:'x'}})],
  ['extension insert',db=>db.postgres.insert('parent',[{id:'1'}])],
  ['extension insertSelect',db=>db.postgres.insertSelect('parent',['id'],sql`select '1'`)],
  ['extension delete',db=>db.postgres.delete('parent',sql`true`)],
  ['extension column',db=>db.postgres.update('parent',{secret:'x'},sql`true`)],
  ['operations insert',db=>db.operations.insert('parent',[{id:'1'}])],
  ['operations delete',db=>db.operations.delete('parent')],
  ['operations column',db=>db.operations.update('parent',{secret:'x'},qFilter())],
  ['operations savepoint column',db=>db.savepoint(child=>child.operations.update('parent',{secret:'x'},qFilter()))],
  ['savepoint',db=>db.savepoint(child=>child.update('parent',{where:{id:'1'},set:{secret:'x'}}))],
];
function qFilter() { return {expr:'=',args:[{expr:'column',args:['id']},'1']}; }
it.each(denied)('rejects %s before business SQL',async(_name,work)=>{
  const {engine,tx}=fixture({parent:{update:['title']}});
  await expect(engine.command({scope:'u'},work)).rejects.toThrow('WRITE_NOT_ALLOWED');
  expect(tx.unsafe.mock.calls.some(([text])=>/\b(insert into|update "|delete from)\b/i.test(String(text)))).toBe(false);
});
it('snapshots the policy so later mutation cannot enable deletes',async()=>{
  const access={parent:{update:['title'],delete:false}};
  const {engine}=fixture(access); access.parent.delete=true;
  await expect(engine.command({scope:'u'},db=>db.delete('parent',{where:{id:'1'}}))).rejects.toThrow('WRITE_NOT_ALLOWED');
});
it('rejects unknown update columns at registration',()=>{
  expect(()=>fixture({parent:{update:['missing']}})).toThrow('INVALID_UPDATE_COLUMN');
});
it('allows declared columns through structured CRUD',async()=>{
  const {engine,tx}=fixture({parent:{update:['title']}});
  await engine.command({scope:'u'},db=>db.update('parent',{where:{id:'1'},set:{title:'ok'}}));
  expect(tx.unsafe.mock.calls.some(([text])=>/update "public"\."parent"/i.test(String(text)))).toBe(true);
});
it('rejects trusted SQL predicates in restricted mode before a function can write',async()=>{
  const {engine,tx}=fixture({parent:{update:['title']}});
  await expect(engine.command({scope:'u'},db=>db.postgres.select('parent',sql`dangerous_write()`))).rejects.toThrow('UNSAFE_SQL_NOT_ALLOWED_WITH_WRITE_ACCESS');
  await expect(engine.command({scope:'u'},db=>db.postgres.execute(sql`delete from parent`))).rejects.toThrow('UNSAFE_SQL_NOT_ALLOWED_WITH_WRITE_ACCESS');
  expect(tx.unsafe.mock.calls.some(([text])=>String(text).includes('dangerous_write'))).toBe(false);
});
it('distinguishes server commit rejection from an unknown network outcome',async()=>{
  const network=Object.assign(new Error('connection lost'),{code:'ECONNRESET'});
  await expect(fixture(undefined,network).engine.command({scope:'u'},async()=>1)).rejects.toMatchObject({code:'COMMIT_STATE_UNKNOWN',commitState:'unknown'});
  const resolution=Object.assign(new Error('resolution unknown'),{code:'08007'});
  await expect(fixture(undefined,resolution).engine.command({scope:'u'},async()=>1)).rejects.toMatchObject({code:'COMMIT_STATE_UNKNOWN',commitState:'unknown'});
  const deferred=Object.assign(new Error('deferred constraint'),{code:'23505'});
  await expect(fixture(undefined,deferred).engine.command({scope:'u'},async()=>1)).rejects.toBe(deferred);
});
it('preserves committed data when collection fails and discards the failed session without retrying',async()=>{
  const {engine,discard,release}=fixture(undefined,undefined,{collection:new Error('collector unavailable')});
  const work=vi.fn(async()=>({id:'committed'}));
  await expect(engine.command({scope:'u'},work)).rejects.toMatchObject({code:'IMPACT_UNAVAILABLE',commitState:'committed',data:{id:'committed'}});
  expect(work).toHaveBeenCalledTimes(1);expect(discard).toHaveBeenCalledOnce();expect(release).not.toHaveBeenCalled();
});
it('discards a connection after rollback failure and preserves the original command failure',async()=>{
  const {engine,discard,release}=fixture(undefined,undefined,{rollback:new Error('rollback failed')});
  await expect(engine.command({scope:'u'},async()=>{throw new Error('business failed');})).rejects.toThrow('business failed');
  expect(discard).toHaveBeenCalledOnce();expect(release).not.toHaveBeenCalled();
});
