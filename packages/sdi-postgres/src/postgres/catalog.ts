import type { Transaction } from './tracked-db.js';
import { canonical } from '@server-driven-impact/core';
import { identityColumns, type QueryManifest, type Resources } from '@server-driven-impact/runtime/adapter';
import { createPostgresCatalogResolver, type CatalogPolicyDependency } from './catalog-resolver.js';
import { catalogFingerprint } from './catalog-fingerprint.js';

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
export async function validateCatalog(
  database: Transaction,
  resources: Resources,
  manifest?: QueryManifest,
  exactStringColumns?: Set<string>,
): Promise<ReadonlySet<string>> {
  const equalityResources = new Set<string>();
  const unsafeEqualityResources = new Set<string>();
  // This pass verifies that RLS does not hide row dependencies from the
  // manifest. Session/time values are handled when the Query itself is
  // compiled; they are not relations that need observers here.
  const stamp=manifest?.postgres?.catalog;
  if(stamp && await catalogFingerprint(database,stamp.schemas)!==stamp.fingerprint)throw new Error('POSTGRES_ARTIFACT_DRIFT');
  const [server]=await database.unsafe("select current_setting('server_version_num')::int as version");
  const parserVersion=Math.floor(Number(server.version)/10000) as 14|15|16|17|18;
  const resolver=createPostgresCatalogResolver(database,resources,{nonRowDependencies:'ignore',parserVersion});
  function verify(id:string,reads:QueryManifest['reads'][string],dependencies:readonly CatalogPolicyDependency[]):void {
    for(const dependency of dependencies){
      const resource=resources[dependency.resource];
      if(!resource || !reads.some(read=>read.resource===dependency.resource))throw new Error(`UNRESOLVED_RLS_DEPENDENCY:${id}`);
      const candidates=reads.filter(read=>read.resource===dependency.resource);
      if(dependency.rowConstraint==='all'){
        unsafeEqualityResources.add(dependency.resource);
        if(resource.scopeColumn!==null)throw new Error(`UNRESOLVED_RLS_SCOPE_DEPENDENCY:${id}`);
        if(!candidates.some(read=>read.bindings.length===0 && (read.columns==='*' || dependency.columns!=='*' && dependency.columns.every(column=>read.columns.includes(column)))))throw new Error(`UNRESOLVED_RLS_COLUMN_DEPENDENCY:${id}`);
      }else {
        const covers=(read:typeof candidates[number])=>read.columns==='*' || dependency.columns!=='*' && dependency.columns.every(column=>column===resource.scopeColumn || read.columns.includes(column));
        if(!candidates.some(read=>read.bindings.length===0 && !(read.filters?.length) && covers(read)) && !candidates.every(covers))throw new Error(`UNRESOLVED_RLS_COLUMN_DEPENDENCY:${id}`);
      }
    }
  }
  if(stamp)for(const [endpoint,proofs] of Object.entries(manifest?.postgres?.policyProofs ?? {})){
    const reads=manifest?.reads[endpoint];
    if(!reads)throw new Error('UNRESOLVED_RLS_DEPENDENCY');
    for(const proof of proofs)verify(endpoint,reads,proof.dependencies);
  }
  for (const [id,r] of Object.entries(resources)) {
    const rows = await database.unsafe(`select c.oid::text as oid,c.relkind,c.relispartition,c.relhasrules,c.relrowsecurity,
      exists(select 1 from pg_inherits where inhrelid=c.oid or inhparent=c.oid) as inherited,
      array(select a.attname::text from pg_attribute a where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped order by a.attname) as columns,
      array(select a.attname::text from pg_attribute a join pg_collation coll on coll.oid=a.attcollation
        where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped and not coll.collisdeterministic order by a.attname) as nondeterministic_collations,
      array(select a.attname::text from pg_attribute a join pg_type t on t.oid=a.atttypid left join pg_collation coll on coll.oid=a.attcollation
        where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped and t.typnamespace='pg_catalog'::regnamespace
          and t.typname in ('text','varchar') and (a.attcollation=0 or coll.collisdeterministic) order by a.attname) as exact_string_columns,
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
    const boundColumns=new Set(Object.values(manifest?.reads ?? {}).flat().filter(read=>read.resource===id).flatMap(read=>[...read.bindings.map(binding=>binding.column), ...(read.filters ?? []).map(filter=>filter.column)]));
    const unsupported=((row.nondeterministic_collations ?? []) as string[]).find((column:string)=>boundColumns.has(column));
    if(unsupported)throw new Error(`UNSUPPORTED_SELECTOR_COLLATION:${id}:${unsupported}`);
    for (const column of (row.exact_string_columns ?? []) as string[]) exactStringColumns?.add(canonical([id,column]));
    if (!row.relrowsecurity && !row.relhasrules) equalityResources.add(id);
    if (row.relrowsecurity) {
      const pending=Object.entries(manifest?.reads ?? {}).filter(([endpoint,reads])=>reads.some(read=>read.resource===id) &&
        !(stamp && manifest?.postgres?.policyProofs?.[endpoint]?.some(proof=>proof.resources.includes(id))));
      if(pending.length || !manifest){
        let dependencies:readonly CatalogPolicyDependency[];
        try{dependencies=await resolver.policyDependencies!({schema:r.schema ?? 'public',name:r.table});}
        catch(error){if(error instanceof Error && error.message.startsWith('UNTRACKED_QUERY_RELATION'))throw new Error(`UNRESOLVED_RLS_DEPENDENCY:${id}`,{cause:error});throw error;}
        if(!manifest && dependencies.some(read=>read.rowConstraint==='all'))throw new Error(`UNRESOLVED_RLS_DEPENDENCY:${id}`);
        for(const [,reads] of pending)verify(id,reads,dependencies);
      }
    }
  }
  for (const resource of unsafeEqualityResources) equalityResources.delete(resource);
  return equalityResources;
}
