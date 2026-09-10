import { assertWriteAccess, snapshotWriteAccess, validateWriteAccess, type PostgresWriteAccess } from './write-access.js';
export type { PostgresWriteAccess } from './write-access.js';
import { guardDatabase } from '@server-driven-impact/runtime/adapter';
import type postgres from 'postgres';
import type { WriteSet } from '@server-driven-impact/core';
import { canonical, type Scalar } from '@server-driven-impact/core';
import { bindAdapter, type ImpactAdapter, type QueryManifest, type Resources } from '@server-driven-impact/runtime/adapter';
import { predicates, validatePatch, type CommandDb } from '@server-driven-impact/runtime/adapter';
import { q, type ExecutableQueryPlan, type Input } from '@server-driven-impact/runtime';
import { TrackedDb, type Transaction } from './tracked-db.js';
import { compileSelect } from './select.js';
import { validateCatalog } from './catalog.js';
import { identifier, join, sql, Sql } from './sql.js';
import { generateObserverMigration, observationRelations, observerFingerprint, observerInternals, observerLayout, rowsToFacts, type ObserverRow } from './observer.js';
import { createOperationExecutor } from './managed-db.js';
import { remoteDb, type OperationsDb } from '@server-driven-impact/runtime/adapter';
import { randomUUID } from 'node:crypto';
import { CommitStateUnknownError, ImpactUnavailableError } from '@server-driven-impact/runtime/adapter';
import { createPostgresCatalogResolver } from './catalog-resolver.js';
import { catalogFingerprint } from './catalog-fingerprint.js';
import { lockSession, releaseSession } from './session.js';
import type { PostgresSetupTransaction } from './public-types.js';

export { sql, Sql, identifier, join } from './sql.js';
export { generateObserverMigration, observerFingerprint } from './observer.js';
export { compilePostgresQuery, type PostgresMajor, type PostgresQuerySource } from './query-compiler.js';
export { createPostgresCatalogResolver };
export type { PostgresCatalogResolver, CatalogRelationReference, CatalogFunctionReference } from './catalog-resolver.js';
export { resolvePostgresResources } from './catalog.js';
export { migratePostgresArtifacts, migratePostgresQueries } from './migration.js';
export { compilePostgresArtifacts, type PostgresArtifacts, type PostgresSourceDefinition, type PostgresArtifactOptions } from './artifact.js';
export type { PostgresMigrationDatabase } from './migration.js';
export type { Row, Patch, Transaction } from './tracked-db.js';
/** PostgreSQL-only trusted SQL operations, still tracked and transaction owned. */
export type PostgresSqlDb = Pick<TrackedDb, 'scope' | 'execute' | 'copyFrom' | 'copyTo' | 'cursor' | 'refreshMaterializedView' | 'select' | 'require' | 'lock' | 'insert' | 'insertSelect' | 'update' | 'delete'> & {
  savepoint<T>(work: (db: PostgresSqlDb) => Promise<T>): Promise<T>;
};
export interface PostgresRoutine {
  schema?: string;
  name: string;
  /** PostgreSQL input type names used to resolve an exact overload. */
  arguments: readonly string[];
}
export interface PostgresCommandDb extends CommandDb {
  readonly postgres: PostgresSqlDb;
  readonly operations: OperationsDb;
  call(routine: string, args?: readonly unknown[]): Promise<unknown[]>;
  savepoint<T>(work: (db: PostgresCommandDb) => Promise<T>): Promise<T>;
}
export interface PostgresOptions<T extends Record<string, unknown> = Record<string, never>> {
  database: postgres.Sql<T>;
  /** Explicit map defaults resources to read-only and restricts writes before SQL. */
  writeAccess?: PostgresWriteAccess;
  /** Explicit function capabilities executed on the observed physical session. */
  routines?: Readonly<Record<string, PostgresRoutine>>;
  /** Verified claims, RLS role and transaction settings. No business writes here. */
  setup?: (tx: PostgresSetupTransaction, scope: Scalar) => Promise<void>;
  /** Defaults to repeatable read for backward compatibility. */
  isolationLevel?: 'read uncommitted' | 'read committed' | 'repeatable read' | 'serializable';
  /** The collector survives COMMIT on the same backend. Transaction pools cannot honor that contract. */
  connectionMode?: 'direct' | 'session' | 'transaction';
}

function commandDb(tracked: TrackedDb, resources: Resources, writeAccess: PostgresWriteAccess | undefined, routines: Readonly<Record<string,PostgresRoutine>>): PostgresCommandDb {
  const assertTrustedSql = () => {
    if (writeAccess !== undefined) throw new Error('UNSAFE_SQL_NOT_ALLOWED_WITH_WRITE_ACCESS');
  };
  function where(resource: string, value: Parameters<typeof predicates>[0]): Sql {
    const compiled = compileSelect(q.select(resource, { columns: [], where: predicates(value) }), {}, resources);
    const clause = compiled.text.split(' WHERE ')[1];
    return clause ? new Sql(clause.replaceAll('t0.', 't.'), compiled.values) : sql`true`;
  }
  const extension: PostgresSqlDb = Object.freeze({
    scope: tracked.scope,
    execute: statement => { assertTrustedSql(); return tracked.execute(statement); },
    copyFrom: (statement,source) => { assertTrustedSql(); return tracked.copyFrom(statement,source); },
    copyTo: statement => { assertTrustedSql(); return tracked.copyTo(statement); },
    cursor: (statement,batchSize) => { assertTrustedSql(); return tracked.cursor(statement,batchSize); },
    refreshMaterializedView: (resource,refreshOptions) => { assertTrustedSql(); return tracked.refreshMaterializedView(resource,refreshOptions); },
    select: (...args) => { assertTrustedSql(); return tracked.select(...args); },
    require: (...args) => { assertTrustedSql(); return tracked.require(...args); },
    lock: (...args) => { assertTrustedSql(); return tracked.lock(...args); },
    insert: (resource, rows, options) => {
      assertWriteAccess(writeAccess, resource, 'insert');
      if (options?.conflict?.patch) assertWriteAccess(writeAccess, resource, 'update', Object.keys(options.conflict.patch));
      assertTrustedSql();
      return tracked.insert(resource, rows, options);
    },
    insertSelect: (resource, names, source, options) => {
      assertWriteAccess(writeAccess, resource, 'insert');
      if (options?.conflict?.patch) assertWriteAccess(writeAccess, resource, 'update', Object.keys(options.conflict.patch));
      assertTrustedSql();
      return tracked.insertSelect(resource, names, source, options);
    },
    update: (resource, patch, where, options) => {
      assertWriteAccess(writeAccess, resource, 'update', Object.keys(patch));
      assertTrustedSql();
      return tracked.update(resource, patch, where, options);
    },
    delete: (resource, where) => {
      assertWriteAccess(writeAccess, resource, 'delete');
      assertTrustedSql();
      return tracked.delete(resource, where);
    },
    savepoint: <T>(work: (db: PostgresSqlDb) => Promise<T>) => tracked.savepoint(child => work(commandDb(child, resources, writeAccess, routines).postgres)),
  });
  const executeOperations = createOperationExecutor(tracked.tx,tracked.writes,tracked.scope,resources,writeAccess);
  return Object.freeze({
    postgres: extension,
    operations: remoteDb(tracked.scope, executeOperations),
    call: async (routine, args = []) => {
      if (!Object.hasOwn(routines,routine)) throw new Error(`UNREGISTERED_ROUTINE:${routine}`);
      const definition=routines[routine];
      if (!Array.isArray(args) || args.length !== definition.arguments.length) throw new Error(`INVALID_ROUTINE_ARGUMENTS:${routine}`);
      const parameters=args.map((value,index)=>new Sql(`$1::${definition.arguments[index]}`,[value]));
      const statement=sql`select to_jsonb(result) as value from ${identifier(definition.schema ?? 'public')}.${identifier(definition.name)}(${join(parameters)}) result`;
      return (await tracked.tx.unsafe(statement.text,statement.values as never[])).map(row=>row.value);
    },
    select: async (resource, options = {}) => tracked.selectPlan(q.select(resource, options), resources),
    insert: (resource, rows, options) => {
      assertWriteAccess(writeAccess,resource,'insert');
      return tracked.insert(resource,rows,options);
    },
    update: (resource, options) => {
      validatePatch(resource, options.set, resources);
      assertWriteAccess(writeAccess,resource,'update',Object.keys(options.set));
      return tracked.update(resource, options.set, where(resource, options.where), { returnRows: options.returnRows });
    },
    delete: (resource, options) => {
      assertWriteAccess(writeAccess,resource,'delete');
      return tracked.delete(resource,where(resource, options.where));
    },
    savepoint: <T>(work: (db: PostgresCommandDb) => Promise<T>) => tracked.savepoint(child => work(commandDb(child, resources, writeAccess, routines))),
  } satisfies PostgresCommandDb);
}

export function postgresAdapter<T extends Record<string, unknown>>(options: PostgresOptions<T>): ImpactAdapter<PostgresCommandDb> {
  if (!options?.database || typeof options.database.begin !== 'function') throw new Error('POSTGRES_CONNECTION_REQUIRED');
  const writeAccess = snapshotWriteAccess(options.writeAccess);
  const isolationLevel=options.isolationLevel ?? 'repeatable read';
  if(options.connectionMode==='transaction')throw new Error('POSTGRES_SESSION_CONNECTION_REQUIRED');
  if (!['read uncommitted','read committed','repeatable read','serializable'].includes(isolationLevel)) throw new Error('INVALID_ISOLATION_LEVEL');
  const routines = Object.freeze(Object.fromEntries(Object.entries(options.routines ?? {}).map(([id,value])=>{
    if (!id || id.length>128 || !(value.schema ?? 'public') || (value.schema ?? 'public').includes('\0') || !value.name || value.name.includes('\0') || !Array.isArray(value.arguments) || value.arguments.some(type=>!/^[a-z_][a-z0-9_.]*(?:\[\])?$/.test(type))) throw new Error(`INVALID_ROUTINE:${id}`);
    return [id,Object.freeze({...value,arguments:Object.freeze([...value.arguments])})];
  })));
  return Object.freeze({
    [bindAdapter](resources: Resources, manifest: QueryManifest) {
      validateWriteAccess(writeAccess, resources);
      let quarantined=false;
      const reserve=async()=>{
        if(quarantined)throw new Error('POSTGRES_SESSION_QUARANTINED');
        return options.database.reserve();
      };
      const release=async(session:Awaited<ReturnType<typeof reserve>>,broken:boolean)=>{
        if(!await releaseSession(session,broken))quarantined=true;
      };
      const fingerprint = observerFingerprint(resources,manifest);
      const layout = observerLayout(fingerprint);
      const performValidation = async (database: Transaction) => {
        if(manifest.postgres?.catalog && await catalogFingerprint(database,manifest.postgres.catalog.schemas)!==manifest.postgres.catalog.fingerprint)throw new Error('POSTGRES_ARTIFACT_DRIFT');
        await validateCatalog(database,resources,manifest);
        for (const [id,routine] of Object.entries(routines)) {
          const quote=(value:string)=>`"${value.replaceAll('"','""')}"`;
          const signature=`${quote(routine.schema ?? 'public')}.${quote(routine.name)}(${routine.arguments.join(',')})`;
          const rows=await database.unsafe(`select p.oid::text as oid,p.prokind from pg_proc p where p.oid=to_regprocedure($1)`,[signature]);
          if (!rows[0]?.oid || rows[0].prokind !== 'f') throw new Error(`ROUTINE_SIGNATURE_MISMATCH:${id}`);
        }
        const rows = await database.unsafe(`select fingerprint,definition_hashes from ${layout.internalSchema}.${layout.metadataTable} where singleton=true`);
        if (rows[0]?.fingerprint !== fingerprint || !rows[0]?.definition_hashes || typeof rows[0].definition_hashes !== 'object') throw new Error('OBSERVER_MANIFEST_MISMATCH');
        const definitionHashes=rows[0].definition_hashes as Record<string,string>;
        const resourceTables=Object.values(resources).flatMap(observationRelations);
        const installed = resourceTables.length ? await database.unsafe(`
          select ns.nspname as schema_name,c.relname as table_name,t.tgname,t.tgenabled,
                 fns.nspname as function_schema,p.proname as function_name,
                 t.tgtype as trigger_type,
                 (t.tgtype & 1) <> 0 as row_level,(t.tgtype & 2) <> 0 as before_trigger,
                 (t.tgtype & 64) <> 0 as instead_trigger,t.tgoldtable,t.tgnewtable,
                 p.prosecdef,p.proconfig,l.lanname,md5(pg_get_functiondef(p.oid)) as function_hash
          from pg_trigger t
          join pg_class c on c.oid=t.tgrelid
          join pg_namespace ns on ns.oid=c.relnamespace
          join pg_proc p on p.oid=t.tgfoid
          join pg_namespace fns on fns.oid=p.pronamespace
          join pg_language l on l.oid=p.prolang
          where not t.tgisinternal and t.tgname like 'sdi_observe_%'
            and (ns.nspname,c.relname) in (${resourceTables.map(resource => `('${(resource.schema ?? 'public').replaceAll("'","''")}','${resource.table.replaceAll("'","''")}')`).join(',')})
          order by ns.nspname,c.relname,t.tgname`) : [];
        const actual = new Map(installed.map(row => [`${row.schema_name}.${row.table_name}.${row.tgname}`,row]));
        for (const [resourceId,resource] of Object.entries(resources)) {
          for(const relation of observationRelations(resource)) {
            for (const operation of ['delete','insert','truncate','update']) {
              const key = `${relation.schema}.${relation.table}.sdi_observe_${operation}`;
              const row = actual.get(key);
              const expectedFunction=observerInternals.functionName(resourceId,operation);
              const expectedOld=operation === 'delete' || operation === 'update' ? 'sdi_old_rows' : null;
              const expectedNew=operation === 'insert' || operation === 'update' ? 'sdi_new_rows' : null;
              const expectedType={insert:4,delete:8,update:16,truncate:32}[operation];
              if (!row || !['O','A'].includes(row.tgenabled) || Number(row.trigger_type) !== expectedType || row.row_level || row.before_trigger || row.instead_trigger ||
                row.tgoldtable !== expectedOld || row.tgnewtable !== expectedNew || row.prosecdef || row.lanname !== 'plpgsql' ||
                !Array.isArray(row.proconfig) || !row.proconfig.includes('search_path=pg_catalog, pg_temp') ||
                row.function_schema !== layout.internalSchema || row.function_name !== expectedFunction || definitionHashes[expectedFunction] !== row.function_hash) {
                throw new Error(`OBSERVER_COVERAGE_MISMATCH:${key}`);
              }
              actual.delete(key);
            }
          }
        }
        if (actual.size) throw new Error(`OBSERVER_COVERAGE_MISMATCH:${actual.keys().next().value}`);
        const expectedFunctions = Object.entries(resources).filter(([,resource])=>resource.postgresKind!=='materialized-view').flatMap(([resource]) =>
          ['delete','insert','truncate','update'].map(operation => observerInternals.functionName(resource,operation))).sort();
        if (canonical(Object.keys(definitionHashes).sort()) !== canonical(expectedFunctions)) throw new Error('OBSERVER_DEFINITION_SET_MISMATCH');
      };
      const readTransaction = async <V>(work:(transaction:Transaction)=>Promise<V>):Promise<V> => {
        const session=await reserve();
        let broken=false;
        try {
          await lockSession(session);
          await session.unsafe(`begin isolation level ${isolationLevel} read only`);
          const data=await work(session);
          await session.unsafe('commit');
          return data;
        } catch(error) {
          try { await session.unsafe('rollback'); } catch { broken=true; }
          throw error;
        } finally { await release(session,broken); }
      };
      const validate = () => readTransaction(performValidation);
      return {
        artifact: fingerprint,
        validate,
        async query<V>(scope: Scalar, work: (select: (plan: ExecutableQueryPlan, input: Input) => Promise<unknown[]>) => Promise<V>): Promise<V> {
          const result = await readTransaction(async tx => {
            await options.setup?.(tx, scope);
            const data = await work(async (plan, input) => {
              if (plan.kind === 'postgres-query') {
                if(plan.searchPath)await tx.unsafe("select set_config('search_path',$1,true)",[plan.searchPath.map(schema=>'"'+schema.replaceAll('"','""')+'"').join(',')]);
                return [...await tx.unsafe(plan.text,plan.parameters.map(field => input[field]) as never[])];
              }
              const statement = compileSelect(plan, input, resources);
              return (await tx.unsafe(statement.text, statement.values as never[])).map(row => row.value);
            });
            return { data };
          });
          return result.data;
        },
        async command<V>(scope: Scalar, writes: WriteSet, work: (db: PostgresCommandDb) => Promise<V>): Promise<V> {
          const session = await reserve();
          const token = randomUUID();
          let committed = false;
          let broken = false;
          try {
            await lockSession(session);
            await session.unsafe(`do $sdi$
              begin
                if to_regclass('pg_temp.${observerInternals.collectorTable}') is null then
                  create temporary table ${observerInternals.collectorTable}(
                    token text not null,resource text not null,operation text not null,
                    before_state jsonb not null,after_state jsonb not null,changed_columns jsonb
                  ) on commit preserve rows;
                end if;
              end
            $sdi$`);
            await session.unsafe(`begin isolation level ${isolationLevel}`);
            await session.unsafe("select set_config('sdi.request_token',$1,true),set_config('sdi.scope',$2,true)",[token,String(scope)]);
            await options.setup?.(session,scope);
            const tracked = new TrackedDb(session,writes,scope,resources,undefined,true);
            const guarded = guardDatabase(commandDb(tracked,resources,writeAccess,routines));
            let data: V;
            try { data = await work(guarded.db); guarded.finish(); guarded.close(); }
            finally {
              guarded.close();
              try { await guarded.settle(); } catch(error) { broken=true; throw error; }
              finally { tracked.close(); }
            }
            try {
              await session.unsafe('commit');
              committed = true;
            } catch (cause) {
              const code = cause && typeof cause === 'object' && 'code' in cause ? String(cause.code) : '';
              // A PostgreSQL SQLSTATE means the server rejected COMMIT (for example,
              // a deferred constraint). Driver/network codes do not establish whether
              // the server committed before the connection was lost.
              if (/^[0-9A-Z]{5}$/.test(code) && !code.startsWith('08') && code !== '40003') throw cause;
              throw new CommitStateUnknownError({ cause });
            }
            let observed: ObserverRow[];
            try {
              observed = [...await session.unsafe(`delete from pg_temp.${observerInternals.collectorTable} where token=$1 returning resource,operation,before_state,after_state,changed_columns`,[token])] as unknown as ObserverRow[];
            } catch (cause) {
              throw new ImpactUnavailableError(data, { cause });
            }
            try { writes.add(rowsToFacts(observed)); }
            catch (cause) { throw new ImpactUnavailableError(data, { cause }); }
            return data;
          } catch (error) {
            if(error instanceof CommitStateUnknownError || error instanceof ImpactUnavailableError)broken=true;
            if (!committed) try { await session.unsafe('rollback'); } catch { broken=true; }
            throw error;
          } finally { await release(session,broken); }
        },
      };
    },
  });
}
