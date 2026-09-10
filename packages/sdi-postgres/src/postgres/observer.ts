import { createHash } from 'node:crypto';
import {
  canonical, isScalar, LIMITS,
  type RowState, type Scalar, type WriteFact,
} from '@server-driven-impact/core';
import { identityColumns, type QueryManifest, type Resources } from '@server-driven-impact/runtime/adapter';

export interface ObserverRow {
  resource: string;
  operation: WriteFact['operation'];
  before_state: unknown;
  after_state: unknown;
  changed_columns: unknown;
}

const metadataTable='observer_manifest';
const collectorTable='sdi_observed_facts';
export function observationRelations(resource: Resources[string]): readonly {schema:string;table:string}[] {
  if(resource.postgresKind==='materialized-view')return [];
  return resource.physicalRelations ?? [{schema:resource.schema ?? 'public',table:resource.table}];
}
export function observerLayout(fingerprint:string) {
  if(!/^[a-f0-9]{64}$/.test(fingerprint))throw new Error('INVALID_OBSERVER_FINGERPRINT');
  return Object.freeze({internalSchema:`sdi_${fingerprint.slice(0,12)}`,metadataTable,collectorTable});
}
function identifier(value:string):string {
  if(!value || value.includes('\0'))throw new Error('INVALID_IDENTIFIER');
  return `"${value.replaceAll('"','""')}"`;
}
function literal(value:string):string { return `'${value.replaceAll("'","''")}'`; }
function functionName(resourceId:string,operation:string):string {
  return `observe_${createHash('sha256').update(resourceId).digest('hex').slice(0,12)}_${operation}`;
}
export function observerFingerprint(resources:Resources,manifest:QueryManifest):string {
  return createHash('sha256').update(canonical({observerProtocol:8,resources,reads:manifest.reads,...(manifest.postgres?{postgres:manifest.postgres}:{})})).digest('hex');
}
function observedColumns(resourceId:string,resource:Resources[string],manifest:QueryManifest):string[] {
  const reads=Object.values(manifest.reads).flat().filter(read=>read.resource===resourceId);
  return [...new Set([
    ...(resource.scopeColumn===null?[]:[resource.scopeColumn]),
    ...identityColumns(resource),
    ...reads.flatMap(read=>read.bindings.map(binding=>binding.column)),
  ])].sort();
}
function rowState(alias:string,resource:Resources[string],columns:readonly string[]):string {
  const scope=resource.scopeColumn===null?'null':`to_jsonb(${alias}.${identifier(resource.scopeColumn)})`;
  const fields=columns.flatMap(column=>[literal(column),`to_jsonb(${alias}.${identifier(column)})`]).join(',');
  return `jsonb_build_object('kind','known','scope',${scope},'fields',jsonb_build_object(${fields}))`;
}
const unknownState=`'{"kind":"unknown"}'::jsonb`;
const absentState=`'{"kind":"absent"}'::jsonb`;
function triggerFunction(internalSchema:string,resourceId:string,operation:'insert'|'update'|'delete'|'truncate',resource:Resources[string],columns:readonly string[]):string {
  const insertUnknown=`insert into pg_temp.${collectorTable}(token,resource,operation,before_state,after_state,changed_columns)
    values(v_token,${literal(resourceId)},'unknown',${unknownState},${unknownState},null)`;
  let body:string;
  if(operation==='truncate')body=insertUnknown+';';
  else if(operation==='insert')body=`
    if (select count(*) from (select 1 from sdi_new_rows limit ${LIMITS.facts+1}) bounded)>${LIMITS.facts} then
      ${insertUnknown};
    else
      insert into pg_temp.${collectorTable}(token,resource,operation,before_state,after_state,changed_columns)
        select v_token,${literal(resourceId)},'insert',${absentState},${rowState('n',resource,columns)},null from sdi_new_rows n;
    end if;`;
  else if(operation==='delete')body=`
    if (select count(*) from (select 1 from sdi_old_rows limit ${LIMITS.facts+1}) bounded)>${LIMITS.facts} then
      ${insertUnknown};
    else
      insert into pg_temp.${collectorTable}(token,resource,operation,before_state,after_state,changed_columns)
        select v_token,${literal(resourceId)},'delete',${rowState('o',resource,columns)},${absentState},null from sdi_old_rows o;
    end if;`;
  else {
    const keys=identityColumns(resource);
    if(!keys.length)body=insertUnknown+';';
    else {
      const equality=keys.map(key=>`o.${identifier(key)} is not distinct from n.${identifier(key)}`).join(' and ');
      const changed=resource.columns.map(column=>`(o.${identifier(column)}::text collate "C") is distinct from (n.${identifier(column)}::text collate "C")`).join(' or ');
      const changedColumns=resource.columns.map(column=>`case when (o.${identifier(column)}::text collate "C") is distinct from (n.${identifier(column)}::text collate "C") then ${literal(column)} end`).join(',');
      body=`
        if (select count(*) from (select 1 from sdi_new_rows limit ${LIMITS.facts+1}) bounded)>${LIMITS.facts} then
          ${insertUnknown};
        else
          insert into pg_temp.${collectorTable}(token,resource,operation,before_state,after_state,changed_columns)
            select v_token,${literal(resourceId)},'update',${rowState('o',resource,columns)},${rowState('n',resource,columns)},
              to_jsonb(array_remove(array[${changedColumns}],null))
            from sdi_old_rows o join sdi_new_rows n on ${equality} where ${changed};
          insert into pg_temp.${collectorTable}(token,resource,operation,before_state,after_state,changed_columns)
            select v_token,${literal(resourceId)},'update',${rowState('o',resource,columns)},${absentState},null
            from sdi_old_rows o where not exists(select 1 from sdi_new_rows n where ${equality});
          insert into pg_temp.${collectorTable}(token,resource,operation,before_state,after_state,changed_columns)
            select v_token,${literal(resourceId)},'update',${absentState},${rowState('n',resource,columns)},null
            from sdi_new_rows n where not exists(select 1 from sdi_old_rows o where ${equality});
        end if;`;
    }
  }
  return `
    create or replace function ${internalSchema}.${functionName(resourceId,operation)}() returns trigger
    language plpgsql security invoker set search_path=pg_catalog,pg_temp as $$
    declare v_token text;
    begin
      v_token := current_setting('sdi.request_token', true);
      if v_token is null or v_token = '' then return null; end if;
      ${body}
      if (select count(*) from pg_temp.${collectorTable} where token=v_token)>${LIMITS.facts}
         or coalesce((select sum(octet_length(before_state::text)+octet_length(after_state::text)+coalesce(octet_length(changed_columns::text),0)) from pg_temp.${collectorTable} where token=v_token),0)>${LIMITS.factBytes} then
        with affected as materialized (
          select distinct resource from pg_temp.${collectorTable} where token=v_token
        ), removed as (
          delete from pg_temp.${collectorTable} where token=v_token returning 1
        )
        insert into pg_temp.${collectorTable}(token,resource,operation,before_state,after_state,changed_columns)
          select v_token,resource,'unknown',${unknownState},${unknownState},null from affected;
      end if;
      return null;
    exception when undefined_table then raise exception 'SDI_COLLECTOR_NOT_INITIALIZED';
    end $$;`;
}

/** Generate migration SQL. Run it with schema-owner privileges, never per request. */
export function generateObserverMigration(resources:Resources,manifest:QueryManifest,options:{runtimeRole?:string}={}):string {
  const fingerprint=observerFingerprint(resources,manifest);
  const {internalSchema}=observerLayout(fingerprint);
  const statements=[`create schema if not exists ${internalSchema};`,
    `create table if not exists ${internalSchema}.${metadataTable}(singleton boolean primary key default true check(singleton),fingerprint text not null,definition_hashes jsonb not null default '{}'::jsonb);`,
    `insert into ${internalSchema}.${metadataTable}(singleton,fingerprint) values(true,${literal(fingerprint)}) on conflict(singleton) do update set fingerprint=excluded.fingerprint;`];
  for(const [resourceId,resource] of Object.entries(resources)) {
    if(resource.postgresKind==='materialized-view')continue;
    const columns=observedColumns(resourceId,resource,manifest);
    for(const operation of ['insert','update','delete','truncate'] as const) {
      const trigger=`sdi_observe_${operation}`;
      statements.push(triggerFunction(internalSchema,resourceId,operation,resource,columns));
      const referencing=operation==='insert'?'referencing new table as sdi_new_rows '
        :operation==='delete'?'referencing old table as sdi_old_rows '
        :operation==='update'?'referencing old table as sdi_old_rows new table as sdi_new_rows ':'';
      for(const relation of observationRelations(resource)) {
        const table=`${identifier(relation.schema)}.${identifier(relation.table)}`;
        statements.push(`drop trigger if exists ${trigger} on ${table};`);
        statements.push(`create trigger ${trigger} after ${operation} on ${table} ${referencing}for each statement execute function ${internalSchema}.${functionName(resourceId,operation)}();`);
      }
    }
  }
  statements.push(`update ${internalSchema}.${metadataTable} set definition_hashes=(
    select coalesce(jsonb_object_agg(p.proname,md5(pg_get_functiondef(p.oid))),'{}'::jsonb)
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname=${literal(internalSchema)} and p.proname like 'observe\\_%' escape '\\'
  ) where singleton=true;`);
  statements.push(`comment on table ${internalSchema}.${metadataTable} is ${literal(`server-driven-impact:${fingerprint}`)};`);
  if(options.runtimeRole)statements.push(
    `grant usage on schema ${internalSchema} to ${identifier(options.runtimeRole)};`,
    `grant select on ${internalSchema}.${metadataTable} to ${identifier(options.runtimeRole)};`,
  );
  return statements.join('\n');
}
function state(value:unknown):RowState {
  if(!value || typeof value!=='object' || !('kind' in value))return {kind:'unknown'};
  const row=value as {kind:unknown;scope?:unknown;fields?:unknown};
  if(row.kind==='absent')return {kind:'absent'};
  if(row.kind!=='known' || !isScalar(row.scope) || !row.fields || typeof row.fields!=='object' || Array.isArray(row.fields) || !Object.values(row.fields).every(isScalar))return {kind:'unknown'};
  return {kind:'known',scope:row.scope,fields:row.fields as Record<string,Scalar>};
}
export function rowsToFacts(rows:readonly ObserverRow[]):WriteFact[] {
  return rows.map(row=>{
    if(!row || typeof row.resource!=='string' || !['insert','update','delete','unknown'].includes(row.operation))throw new Error('INVALID_OBSERVER_ROW');
    return {resource:row.resource,operation:row.operation,before:state(row.before_state),after:state(row.after_state),
      changedColumns:Array.isArray(row.changed_columns) && row.changed_columns.every(value=>typeof value==='string')?row.changed_columns:null};
  });
}
export const observerInternals=Object.freeze({metadataTable,collectorTable,functionName});
