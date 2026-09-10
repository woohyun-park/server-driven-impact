import { compileManifest, type Manifest, type QueryDefinition, type PostgresQueryPlan, type Resources } from '@server-driven-impact/runtime';
import { createPostgresCatalogResolver } from './catalog-resolver.js';
import { catalogFingerprint } from './catalog-fingerprint.js';
import { resolvePostgresResources } from './catalog.js';
import { compilePostgresQuery, type PostgresMajor, type PostgresQuerySource } from './query-compiler.js';
import type { Transaction } from './tracked-db.js';

export interface PostgresSourceDefinition {
  input: QueryDefinition['input'];
  source: PostgresQuerySource;
  /** Unprovable dependencies execute through queryUncached; strict callers may reject activation. */
  onUnresolved?: 'no-store' | 'reject';
}
export interface PostgresArtifactOptions {
  version: PostgresMajor;
  searchPath?: readonly string[];
  discoverUnregisteredRelations?: boolean;
}
export interface PostgresArtifacts {
  resources: Resources;
  queries: Record<string, QueryDefinition>;
  manifest: Manifest;
  diagnostics: Record<string, string>;
}

/** Compile against the target catalog. Repeat inside the migration transaction after DDL. */
export async function compilePostgresArtifacts(
  database: Transaction, resources: Resources,
  definitions: Record<string, PostgresSourceDefinition>, options: PostgresArtifactOptions,
): Promise<PostgresArtifacts> {
  const catalog = createPostgresCatalogResolver(database, resources, {
    parserVersion: options.version, searchPath: options.searchPath,
    discoverUnregisteredRelations: options.discoverUnregisteredRelations ?? true,
  });
  const queries: Record<string, QueryDefinition> = Object.create(null);
  const diagnostics: Record<string, string> = Object.create(null);
  for (const [endpoint, definition] of Object.entries(definitions)) {
    let plan: PostgresQueryPlan;
    try {
      plan = await compilePostgresQuery(definition.source, catalog.resources, options.version, {catalog});
    } catch (error) {
      const reason = error instanceof Error ? error.message : '';
      if (definition.onUnresolved === 'reject' || !/^(UNRESOLVED_|UNTRACKED_|UNSUPPORTED_(QUERY|DISCOVERED)_|AMBIGUOUS_QUERY_|POSTGRES_QUERY_(REQUIRES_FRESHNESS_POLICY|HAS_NO_TRACKED_RELATION)|CATALOG_DEPENDENCY_LIMIT)/.test(reason)) throw error;
      plan = await compilePostgresQuery({...definition.source,cache:'no-store'}, catalog.resources, options.version);
      diagnostics[endpoint] = reason;
    }
    // Until cache keys and native input codecs share a proven normalization,
    // arbitrary native parameter types must not narrow to observer JSON values.
    queries[endpoint] = { input: definition.input, plan: {...plan, searchPath:[...(options.searchPath ?? ['public'])], reads: plan.reads.map(read => ({...read,bindings:[]}))} };
  }
  const resolved = await resolvePostgresResources(database, catalog.resources);
  const schemas = [...new Set([...Object.values(resolved).map(resource => resource.schema ?? 'public'), ...(catalog.schemas ?? []), ...(options.searchPath ?? ['public'])])].sort();
  const [semantics]=await database.unsafe(`select
    array(select distinct n.nspname||'.'||c.relname from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace join pg_type t on t.oid=a.atttypid
      where a.attnum>0 and not a.attisdropped and n.nspname||'.'||c.relname=any($2::text[]) and t.typnamespace<>'pg_catalog'::regnamespace) as custom_relations,
    exists(select 1 from pg_operator o where o.oprnamespace in (select oid from pg_namespace where nspname=any($1::text[]))) as custom_operators`,[schemas,Object.values(resolved).map(resource=>(resource.schema ?? 'public')+'.'+resource.table)]);
  const customRelations=new Set((semantics.custom_relations ?? []) as string[]);
  for(const [endpoint,query] of Object.entries(queries)){
    const usesCustomRelation=query.plan.kind==='postgres-query' && query.plan.reads.some(read=>{
      const resource=resolved[read.resource];
      return resource && customRelations.has((resource.schema ?? 'public')+'.'+resource.table);
    });
    if(!semantics.custom_operators && !usesCustomRelation)continue;
    if(definitions[endpoint].source.cache==='no-store')continue;
    if(definitions[endpoint].onUnresolved==='reject')throw new Error('UNRESOLVED_CUSTOM_TYPE_OR_OPERATOR');
    query.plan={...query.plan,cache:'no-store',reads:[]} as PostgresQueryPlan;
    diagnostics[endpoint]='UNRESOLVED_CUSTOM_TYPE_OR_OPERATOR';
  }
  const stamp = {schemas, fingerprint: await catalogFingerprint(database, schemas)};
  for (const query of Object.values(queries)) query.plan = {...query.plan, catalog:stamp} as PostgresQueryPlan;
  return {resources:resolved,queries,manifest:compileManifest(queries,resolved),diagnostics};
}
