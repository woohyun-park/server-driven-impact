import type { Transaction } from './tracked-db.js';
import { canonical } from '@server-driven-impact/core';
import { identityColumns, type QueryManifest, type Resources } from '@server-driven-impact/runtime/adapter';
import { createPostgresCatalogResolver } from './catalog-resolver.js';

type PhysicalRelation = { schema: string; table: string };

/** Snapshot the current partition/inheritance topology into resource configuration. */
export async function resolvePostgresResources(database: Transaction, resources: Resources): Promise<Resources> {
  const result: Resources={};
  const claimed=new Map<string,string>();
  for(const [id,resource] of Object.entries(resources)) {
    const rows=await database.unsafe(`with recursive tree(oid) as (
        select c.oid from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname=$1 and c.relname=$2
        union
        select inheritance.inhrelid from pg_inherits inheritance join tree on inheritance.inhparent=tree.oid
      )
      select n.nspname as schema,c.relname as table,c.relkind,c.relispartition,
        exists(select 1 from pg_inherits inheritance where inheritance.inhrelid=c.oid) as has_parent
      from tree join pg_class c on c.oid=tree.oid join pg_namespace n on n.oid=c.relnamespace
      order by n.nspname,c.relname`,[resource.schema ?? 'public',resource.table]) as unknown as (PhysicalRelation&{relkind:string;relispartition:boolean;has_parent:boolean})[];
    if(!rows.length)throw new Error(`UNSUPPORTED_TABLE:${id}`);
    const hierarchy=rows.length>1 || rows[0].relkind==='p' || rows[0].relispartition || rows[0].has_parent;
    const physical=rows.map(({schema,table})=>({schema,table}));
    for(const relation of physical){
      const name=`${relation.schema}.${relation.table}`;
      const owner=claimed.get(name);
      if(owner && owner!==id)throw new Error(`OVERLAPPING_PHYSICAL_RELATION:${owner}:${id}:${name}`);
      claimed.set(name,id);
    }
    result[id]={...resource,...(hierarchy?{physicalRelations:physical}:{})};
  }
  return result;
}
/** Explicit startup compatibility check; requires catalog visibility, no DDL or writes. */
export async function validateCatalog(database: Transaction, resources: Resources, manifest?: QueryManifest): Promise<void> {
  // This pass verifies that RLS does not hide row dependencies from the
  // manifest. Session/time values are handled when the Query itself is
  // compiled; they are not relations that need observers here.
  const resolver=manifest ? createPostgresCatalogResolver(database,resources,{nonRowDependencies:'ignore'}) : undefined;
  for (const [id,r] of Object.entries(resources)) {
    const rows = await database.unsafe(`select c.oid::text as oid,c.relkind,c.relispartition,c.relhasrules,c.relrowsecurity,
      exists(select 1 from pg_inherits where inhrelid=c.oid or inhparent=c.oid) as inherited,
      array(select a.attname::text from pg_attribute a where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped order by a.attname) as columns,
      array(select a.attname::text from pg_attribute a join pg_collation coll on coll.oid=a.attcollation
        where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped and not coll.collisdeterministic order by a.attname) as nondeterministic_collations,
      array(select a.attname::text from pg_index i cross join lateral unnest(i.indkey) k join pg_attribute a on a.attrelid=c.oid and a.attnum=k where i.indrelid=c.oid and i.indisprimary) as pk
      from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname=$1 and c.relname=$2`,[r.schema ?? 'public',r.table]);
    const row=rows[0];
    const expectedKind=r.postgresKind==='materialized-view'?'m':undefined;
    if (!row || (expectedKind ? row.relkind!==expectedKind : !['r','p'].includes(row.relkind)) || (row.relhasrules && row.relkind!=='m')) throw new Error(`UNSUPPORTED_TABLE:${id}`);
    if ((row.relispartition || row.inherited || row.relkind==='p')) {
      if(!r.physicalRelations)throw new Error(`UNSUPPORTED_TABLE:${id}`);
      const resolved=await resolvePostgresResources(database,{[id]:{...r,physicalRelations:undefined}});
      if(canonical(resolved[id].physicalRelations) !== canonical(r.physicalRelations))throw new Error(`RELATION_TOPOLOGY_DRIFT:${id}`);
    } else if(r.physicalRelations) throw new Error(`RELATION_TOPOLOGY_DRIFT:${id}`);
    if (canonical([...row.pk].sort()) !== canonical([...identityColumns(r)].sort())) throw new Error(`IDENTITY_DRIFT:${id}`);
    if (canonical([...row.columns].sort()) !== canonical([...r.columns].sort())) throw new Error(`COLUMN_DRIFT:${id}`);
    const boundColumns=new Set(Object.values(manifest?.reads ?? {}).flat().filter(read=>read.resource===id).flatMap(read=>read.bindings.map(binding=>binding.column)));
    const unsupported=((row.nondeterministic_collations ?? []) as string[]).find((column:string)=>boundColumns.has(column));
    if(unsupported)throw new Error(`UNSUPPORTED_SELECTOR_COLLATION:${id}:${unsupported}`);
    if (row.relrowsecurity) {
      const hidden=await database.unsafe(`select exists(
        select 1 from pg_policy policy
        join pg_depend dependency on dependency.classid='pg_policy'::regclass and dependency.objid=policy.oid
        left join pg_proc function on dependency.refclassid='pg_proc'::regclass and function.oid=dependency.refobjid
        left join pg_namespace function_schema on function_schema.oid=function.pronamespace
        where policy.polrelid=$1::oid and (
          (dependency.refclassid='pg_class'::regclass and dependency.refobjid<>$1::oid)
          or (dependency.refclassid='pg_proc'::regclass and function_schema.nspname<>'pg_catalog')
        )) as hidden`,[row.oid]);
      if (hidden[0]?.hidden) {
        if (!manifest || !resolver) throw new Error(`UNRESOLVED_RLS_DEPENDENCY:${id}`);
        const required=await resolver.resolveRelation({schema:r.schema ?? 'public',name:r.table});
        for (const reads of Object.values(manifest.reads)) {
          if (!reads.some(read=>read.resource===id)) continue;
          if (required.some(resource=>!reads.some(read=>read.resource===resource))) throw new Error(`UNRESOLVED_RLS_DEPENDENCY:${id}`);
        }
      }
    }
  }
}
