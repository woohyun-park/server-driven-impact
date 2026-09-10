import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { WriteSet } from '@server-driven-impact/core';
import { LIMITS, canonical, isScalar, type Scalar, type WriteFact, type RowState } from '@server-driven-impact/core';
import { bindAdapter, identityColumns, type ImpactAdapter, type QueryManifest, type Resources, type SelectExecutor } from '@server-driven-impact/runtime/adapter';
import { predicates, validatePatch, type CommandDb, type DataRow, type Where, type WriteResult } from '@server-driven-impact/runtime/adapter';
import { guardDatabase } from '@server-driven-impact/runtime/adapter';
import { q, type Input } from '@server-driven-impact/runtime';
import { compileSelect } from './select.js';
import { createHash } from 'node:crypto';
import { ImpactUnavailableError } from '@server-driven-impact/runtime/adapter';

export interface SqliteCommandDb extends CommandDb {
  readonly sqlite: {
    /** Execute one trusted native SQLite statement on the owned transaction. */
    execute(text: string, values?: readonly SQLInputValue[]): Promise<DataRow[]>;
  };
  savepoint<T>(work: (db: SqliteCommandDb) => Promise<T>): Promise<T>;
}
export interface SqliteOptions { database: DatabaseSync }
const queues = new WeakMap<DatabaseSync, Promise<unknown>>();
function serial<T>(database: DatabaseSync, work: () => Promise<T>): Promise<T> {
  const next = (queues.get(database) ?? Promise.resolve()).then(work, work);
  queues.set(database, next.then(() => undefined, () => undefined));
  return next;
}
function ident(name: string): string {
  if (!name || name.includes('\0')) throw new Error('INVALID_IDENTIFIER');
  return '"' + name.replaceAll('"','""') + '"';
}
function value(input: unknown): SQLInputValue {
  // SQLite returns INTEGER booleans as numbers. Require that explicit representation
  // rather than returning a falsely narrow boolean input selector.
  if (!isScalar(input) || typeof input === 'boolean') throw new Error('SQLITE_REQUIRES_TEXT_NUMBER_OR_NULL');
  if (typeof input === 'number' && Number.isInteger(input) && !Number.isSafeInteger(input)) throw new Error('UNSAFE_INTEGER');
  return input;
}
function bindings(values: unknown[]): Record<string, SQLInputValue> {
  return Object.fromEntries(values.map((v, i) => [String(i + 1), value(v)]));
}
function validateCatalog(database: DatabaseSync, resources: Resources): void {
  if (!database.prepare('pragma foreign_keys').get()?.foreign_keys) throw new Error('SQLITE_FOREIGN_KEYS_REQUIRED');
  for (const [id, resource] of Object.entries(resources)) {
    if (resource.schema && resource.schema !== 'main') throw new Error('SQLITE_MAIN_SCHEMA_ONLY');
    const entry = database.prepare("select type, sql from sqlite_schema where name=?").get(resource.table);
    if (!entry || entry.type !== 'table' || /CREATE\s+VIRTUAL\s+TABLE/i.test(String(entry.sql))) throw new Error('UNSUPPORTED_TABLE:' + id);
    const columns = database.prepare(`pragma table_xinfo(${ident(resource.table)})`).all();
    const pk = columns.filter(c => Number(c.pk) > 0);
    const identity = identityColumns(resource);
    if (identity.length !== 1 || pk.length !== 1 || pk[0].name !== identity[0] || columns.some(c => c.hidden)) throw new Error('UNSUPPORTED_TABLE:' + id);
    if (canonical(columns.map(c => c.name).sort()) !== canonical([...resource.columns].sort())) throw new Error('COLUMN_DRIFT:' + id);
    if (columns.some(c => !['TEXT', 'INTEGER', 'REAL'].includes(String(c.type).toUpperCase()))) throw new Error('SQLITE_UNSUPPORTED_COLUMN_TYPE:' + id);

  }

}

const collectorTable='sdi_observed_facts';
const collectorResources='sdi_observed_resources';
function triggerName(resource:string,operation:string) {
  return `sdi_${createHash('sha256').update(resource).digest('hex').slice(0,12)}_${operation}`;
}
function quoted(value:string) { return "'"+value.replaceAll("'","''")+"'"; }
function stateSql(alias:'old'|'new',resource:Resources[string],fields:readonly string[]) {
  const scope=resource.scopeColumn===null?'null':`${alias}.${ident(resource.scopeColumn)}`;
  const values=fields.flatMap(field=>[quoted(field),`${alias}.${ident(field)}`]).join(',');
  return `json_object('kind','known','scope',${scope},'fields',json_object(${values}))`;
}
function installObservers(database:DatabaseSync,resources:Resources,manifest:QueryManifest) {
  database.exec(`create temp table if not exists ${ident(collectorTable)}(
    resource text not null,operation text not null,before_state text not null,after_state text not null,changed_columns text
  );create temp table if not exists ${ident(collectorResources)}(resource text primary key)`);
  for(const [resourceId,resource] of Object.entries(resources)) {
    const fields=[...new Set([
      ...(resource.scopeColumn===null?[]:[resource.scopeColumn]),
      ...identityColumns(resource),
      ...Object.values(manifest.reads).flat().filter(read=>read.resource===resourceId).flatMap(read=>read.bindings.map(binding=>binding.column)),
    ])].sort();
    for(const operation of ['insert','update','delete'] as const) {
      const name=ident(triggerName(resourceId,operation));
      database.exec(`drop trigger if exists temp.${name}`);
      const before=operation==='insert'?quoted(JSON.stringify({kind:'absent'})):stateSql('old',resource,fields);
      const after=operation==='delete'?quoted(JSON.stringify({kind:'absent'})):stateSql('new',resource,fields);
      const changed=operation==='update'
        ? `json_object(${resource.columns.flatMap(column=>[quoted(column),`old.${ident(column)} is not new.${ident(column)}`]).join(',')})`
        :'null';
      const when=operation==='update'?` when ${resource.columns.map(column=>`old.${ident(column)} is not new.${ident(column)}`).join(' or ')}`:'';
      database.exec(`create temp trigger ${name} after ${operation} on main.${ident(resource.table)}${when} begin
        insert or ignore into ${ident(collectorResources)}(resource) values(${quoted(resourceId)});
        insert into ${ident(collectorTable)}(resource,operation,before_state,after_state,changed_columns)
          select ${quoted(resourceId)},${quoted(operation)},${before},${after},${changed}
          where (select count(*) from ${ident(collectorTable)})<${LIMITS.facts+1};
      end`);
    }
  }
}
function observedFacts(database:DatabaseSync):WriteFact[] {
  const stats=database.prepare(`select count(*) as count,coalesce(sum(length(resource)+length(operation)+length(before_state)+length(after_state)+coalesce(length(changed_columns),0)),0) as bytes from ${ident(collectorTable)}`).get();
  if(Number(stats?.count)>LIMITS.facts || Number(stats?.bytes)>LIMITS.factBytes) {
    return database.prepare(`select resource from ${ident(collectorResources)} order by resource`).all().map(row=>({
      resource:String(row.resource),operation:'unknown',before:{kind:'unknown'},after:{kind:'unknown'},changedColumns:null,
    }));
  }
  const rows=database.prepare(`select resource,operation,before_state,after_state,changed_columns from ${ident(collectorTable)}`).all();
  return rows.map(row=>{
    const parseState=(value:unknown):RowState=>{
      try {
        const parsed=JSON.parse(String(value)) as RowState;
        if(parsed.kind==='absent')return parsed;
        if(parsed.kind==='known' && isScalar(parsed.scope) && parsed.fields && Object.values(parsed.fields).every(isScalar))return parsed;
      } catch {}
      return {kind:'unknown'};
    };
    let changedColumns:string[]|null=null;
    try {
      const changed=JSON.parse(String(row.changed_columns));
      if(changed && typeof changed==='object' && !Array.isArray(changed))changedColumns=Object.entries(changed).filter(([,value])=>value===1 || value===true).map(([column])=>column);
    } catch {}
    return {resource:String(row.resource),operation:row.operation as WriteFact['operation'],before:parseState(row.before_state),after:parseState(row.after_state),changedColumns};
  });
}
function assertNativeStatement(text:string) {
  if(!text.trim() || text.includes('\0') || /;\s*\S/.test(text.replace(/;\s*$/,'')))throw new Error('SQLITE_SINGLE_STATEMENT_REQUIRED');
  if(/^\s*(?:begin|commit|rollback|savepoint|release|attach|detach|pragma|vacuum|create|alter|drop)\b/i.test(text))throw new Error('SQLITE_TRANSACTION_OR_DDL_FORBIDDEN');
  // SQLite may omit DELETE triggers for REPLACE unless recursive_triggers is on.
  // Reject it instead of silently losing the OLD selector membership.
  if(/\binsert\s+or\s+replace\b/i.test(text) || /^\s*replace\b/i.test(text))throw new Error('SQLITE_REPLACE_UNSUPPORTED');
}

export function sqliteAdapter(options: SqliteOptions): ImpactAdapter<SqliteCommandDb> {
  const database = options?.database;
  if (!database || typeof database.prepare !== 'function') throw new Error('SQLITE_CONNECTION_REQUIRED');
  return Object.freeze({
    [bindAdapter](resources: Resources, manifest: QueryManifest) {
      let prepared=false;
      const prepare = () => { if(!prepared) { installObservers(database,resources,manifest);prepared=true; } };
      const validate = () => serial(database,async()=>{
        validateCatalog(database,resources);
        installObservers(database,resources,manifest);
        prepared=true;
      });
      const select: SelectExecutor = async (plan, input: Input) => {
        if (plan.kind !== 'select') throw new Error('POSTGRES_QUERY_REQUIRES_POSTGRES_ADAPTER');
        const statement = compileSelect(plan, input, resources);
        return database.prepare(statement.text).all(bindings(statement.values)).map(row => JSON.parse(String(row.value)) as DataRow);
      };
      function table(resource: string): string {
        if (!Object.hasOwn(resources, resource)) throw new Error('UNREGISTERED_RESOURCE');
        return ident(resources[resource].table);
      }
      function condition(resource: string, where: Where) {
        const statement = compileSelect(q.select(resource, { columns: [], where: predicates(where) }), {}, resources);
        return { text: statement.text.split(' WHERE ')[1] ?? '1', values: statement.values };
      }
      function dbFor(): SqliteCommandDb {
        let savepointId = 0;
        function beforeRows(resource: string, where: Where) {
          const predicate = condition(resource, where);
          return database.prepare(`select t0.* from ${table(resource)} as t0 where ${predicate.text} limit ${LIMITS.facts + 1}`).all(bindings(predicate.values));
        }
        const db: SqliteCommandDb = {
          sqlite:{
            async execute(text,values=[]) {
              assertNativeStatement(text);
              return database.prepare(text).all(...values) as DataRow[];
            },
          },
          select: async (resource, opts = {}) => select(q.select(resource, opts), {}) as Promise<DataRow[]>,
          async insert(resource, rows, options = {}) {
            table(resource);
            if (options.returnRows && rows.length > LIMITS.facts) throw new Error('USE_BATCH_WRITE_WITHOUT_ROWS');
            const returned: DataRow[] = [];
            for (const row of rows) {
              const names = Object.keys(row);
              if (!names.length || names.some(c => !resources[resource].columns.includes(c))) throw new Error('UNREGISTERED_COLUMN');
              const result = database.prepare(`insert into ${table(resource)} (${names.map(ident).join(',')}) values (${names.map(() => '?').join(',')}) returning *`).get(...names.map(c => value(row[c])))!;
              if (options.returnRows) returned.push({ ...result });
            }
            return { count: rows.length, rows: returned };
          },
          async update(resource, options) {
            validatePatch(resource, options.set, resources);
            if (options.returnRows && beforeRows(resource, options.where).length > LIMITS.facts) throw new Error('USE_BATCH_WRITE_WITHOUT_ROWS');
            const predicate = condition(resource, options.where);
            const names = Object.keys(options.set);
            const assignments = names.map((name, i) => `${ident(name)}=$${predicate.values.length + i + 1}`).join(',');
            const values=bindings([...predicate.values, ...names.map(c => options.set[c])]);
            if(options.returnRows) {
              const rows=database.prepare(`update ${table(resource)} as t0 set ${assignments} where ${predicate.text} returning *`).all(values) as DataRow[];
              return {count:rows.length,rows:rows.map(row=>({...row}))};
            }
            const result = database.prepare(`update ${table(resource)} as t0 set ${assignments} where ${predicate.text}`).run(values);
            return { count:Number(result.changes), rows:[] };
          },
          async delete(resource, options): Promise<WriteResult> {
            const predicate = condition(resource, options.where);
            const result = database.prepare(`delete from ${table(resource)} as t0 where ${predicate.text}`).run(bindings(predicate.values));
            const count = Number(result.changes);
            return { count, rows: [] };
          },
          async savepoint<T>(work: (child: SqliteCommandDb) => Promise<T>): Promise<T> {
            const name = ident('sdi_' + (++savepointId));
            database.exec('savepoint ' + name);
            try {
              const data = await work(db);
              database.exec('release savepoint ' + name);
              return data;
            } catch (error) {
              database.exec('rollback to savepoint ' + name);
              database.exec('release savepoint ' + name);
              throw error;
            }
          },
        };
        return db;
      }
      async function transaction<T>(readOnly: boolean, work: () => Promise<T>): Promise<T> {
        return serial(database, async () => {
          if (database.isTransaction) throw new Error('SQLITE_CONNECTION_ALREADY_IN_TRANSACTION');
          database.exec(readOnly ? 'begin' : 'begin immediate');
          try {
            const data = await work();
            database.exec('commit');
            return data;
          } catch (error) { if (database.isTransaction) database.exec('rollback'); throw error; }
        });
      }
      return {
        validate,
        query: <T>(_scope: Scalar, work: (execute: SelectExecutor) => Promise<T>) => transaction(true, () => work(select)),
        command: <T>(_scope: Scalar, writes: WriteSet, work: (db: SqliteCommandDb) => Promise<T>) => serial(database, async () => {
          prepare();
          if(database.isTransaction)throw new Error('SQLITE_CONNECTION_ALREADY_IN_TRANSACTION');
          database.exec(`delete from ${ident(collectorTable)};delete from ${ident(collectorResources)}`);
          database.exec('begin immediate');
          let committed=false;
          let data!:T;
          try {
            const guarded=guardDatabase(dbFor());
            try { data=await work(guarded.db);guarded.finish(); }
            finally { guarded.close();await guarded.settle(); }
            database.exec('commit');committed=true;
            try { writes.add(observedFacts(database));database.exec(`delete from ${ident(collectorTable)};delete from ${ident(collectorResources)}`); }
            catch(cause) { throw new ImpactUnavailableError(data,{cause}); }
            return data;
          } catch(error) {
            if(!committed && database.isTransaction)database.exec('rollback');
            if(!committed)database.exec(`delete from ${ident(collectorTable)};delete from ${ident(collectorResources)}`);
            throw error;
          }
        }),
      };
    },
  });
}
