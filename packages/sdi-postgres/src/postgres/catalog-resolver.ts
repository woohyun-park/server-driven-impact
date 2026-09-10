import type { Resources } from '@server-driven-impact/runtime/adapter';
import type { Transaction } from './tracked-db.js';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { sqlReferences } from './sql-references.js';

const require=createRequire(import.meta.url);

export interface CatalogRelationReference { schema?: string; name: string }
export interface CatalogFunctionReference { schema?: string; name: string; arguments: number }
export interface PostgresCatalogResolver {
  /** Resource snapshot including any explicitly enabled catalog discoveries. */
  readonly resources: Resources;
  readonly schemas?: readonly string[];
  resolveRelation(reference: CatalogRelationReference): Promise<readonly string[]>;
  resolveFunction(reference: CatalogFunctionReference): Promise<readonly string[]>;
  /** True only after resolution proves a direct table has no hidden column reads. */
  canPruneColumns?(reference: CatalogRelationReference): boolean;
}

type ObjectReference = { kind: 'relation' | 'function'; oid: string };
type RelationRow = { oid: string; schema_name: string; object_name: string; relkind: string; relispartition?: boolean; relhasrules?: boolean; columns?: string[]; pk?: string[] };
type FunctionRow = { oid: string; schema_name: string; object_name: string; lanname: string; prosrc: string; provolatile: string; proconfig: string[]|null; sqlbody?:string|null; custom_types?:boolean };

function key(reference: CatalogRelationReference | CatalogFunctionReference): string {
  return `${reference.schema ?? ''}.${reference.name}${'arguments' in reference ? `/${reference.arguments}` : ''}`;
}

/** Resolve dependencies PostgreSQL recorded when an object was defined. */
export function createPostgresCatalogResolver(
  database: Transaction,
  resources: Resources,
  options: {
    searchPath?: readonly string[];
    parserVersion?: 14|15|16|17|18;
    discoverUnregisteredRelations?: boolean;
    /** Dependency-only validation may ignore non-row values while cached Query compilation rejects them. */
    nonRowDependencies?: 'reject'|'ignore';
  } = {},
): PostgresCatalogResolver {
  const searchPath = [...(options.searchPath ?? ['public'])];
  if (!searchPath.length || searchPath.some(schema => !schema || schema.includes('\0'))) throw new Error('INVALID_SEARCH_PATH');
  const nonRowDependencies=options.nonRowDependencies ?? 'reject';
  if(!['reject','ignore'].includes(nonRowDependencies))throw new Error('INVALID_NON_ROW_DEPENDENCY_POLICY');
  const relationCache = new Map<string, Promise<readonly string[]>>();
  const functionCache = new Map<string, Promise<readonly string[]>>();
  const prunableRelations = new Set<string>();
  const columnPruning = new Map<string, boolean>();
  const resolvedResources:Resources={...resources};
  const schemas=new Set(searchPath);
  let expansions=0;
  const resourceByName = new Map(Object.entries(resolvedResources).map(([id, resource]) => [`${resource.schema ?? 'public'}.${resource.table}`, id]));

  function discoveredResource(current:RelationRow):string|undefined {
    const name=`${current.schema_name}.${current.object_name}`;
    const existing=resourceByName.get(name);
    if(existing)return existing;
    if(current.relkind==='v')return undefined;
    if(!options.discoverUnregisteredRelations)return undefined;
    // Foreign tables and partition topologies need a dedicated observer strategy;
    // ordinary tables can safely use a global broad resource until an app supplies
    // a tenant scope contract.
    if(current.relkind!=='r' || current.relispartition)throw new Error(`UNSUPPORTED_DISCOVERED_RELATION:${name}:${current.relkind}`);
    const readable=`postgres:${name}`;
    const id=readable.length<=128 && !Object.hasOwn(resolvedResources,readable)
      ? readable
      : `postgres:${createHash('sha256').update(name).digest('hex')}`;
    if(Object.hasOwn(resolvedResources,id))throw new Error(`INVALID_DISCOVERED_RESOURCE:${name}`);
    const pk=current.pk ?? [];
    resolvedResources[id]={schema:current.schema_name,table:current.object_name,idColumn:pk.length===0?null:pk.length===1?pk[0]:pk,scopeColumn:null,columns:current.columns ?? []};
    resourceByName.set(name,id);
    return id;
  }

  async function relation(reference: CatalogRelationReference, path: Set<string>): Promise<readonly string[]> {
    const cacheKey=key(reference);
    if (!path.size && relationCache.has(cacheKey)) return relationCache.get(cacheKey)!;
    const pending=(async()=>{
      const rows=await database.unsafe(`select c.oid::text,n.nspname as schema_name,c.relname as object_name,c.relkind,c.relispartition,c.relhasrules,
        array(select a.attname::text from pg_attribute a where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped order by a.attnum) as columns,
        array(select a.attname::text from pg_index i cross join lateral unnest(i.indkey) with ordinality keys(k,ordinal) join pg_attribute a on a.attrelid=c.oid and a.attnum=keys.k where i.indrelid=c.oid and i.indisprimary order by keys.ordinal) as pk
        from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where c.relname=$1 and ($2::text is not null and n.nspname=$2 or $2::text is null and n.nspname=any($3::text[]))
        order by case when $2::text is not null then 0 else array_position($3::text[],n.nspname) end`,
        [reference.name,reference.schema ?? null,searchPath]) as unknown as RelationRow[];
      if (!rows.length) throw new Error(`UNRESOLVED_QUERY_RELATION:${reference.schema ? `${reference.schema}.` : ''}${reference.name}`);
      const resolved = await expand({kind:'relation',oid:rows[0].oid},new Set(path));
      columnPruning.set(cacheKey, prunableRelations.has(`${rows[0].schema_name}.${rows[0].object_name}`));
      return resolved;
    })();
    if (!path.size) relationCache.set(cacheKey,pending);
    return pending;
  }

  async function routine(reference: CatalogFunctionReference, path: Set<string>): Promise<readonly string[]> {
    const cacheKey=key(reference);
    if (!path.size && functionCache.has(cacheKey)) return functionCache.get(cacheKey)!;
    const pending=(async()=>{
      const rows=await database.unsafe(`select p.oid::text,n.nspname as schema_name,p.proname as object_name,l.lanname,p.prosrc,p.provolatile,p.proconfig
        from pg_proc p join pg_namespace n on n.oid=p.pronamespace join pg_language l on l.oid=p.prolang
        where p.proname=$1 and (p.pronargs-p.pronargdefaults<=$2 and (p.pronargs>=$2 or p.provariadic<>0)) and ($3::text is not null and n.nspname=$3 or $3::text is null and n.nspname=any($4::text[]))
        order by case when $3::text is not null then 0 else array_position($4::text[],n.nspname) end`,
        [reference.name,reference.arguments,reference.schema ?? null,['pg_catalog',...searchPath]]) as unknown as FunctionRow[];
      if (!rows.length) throw new Error(`UNRESOLVED_QUERY_FUNCTION:${reference.schema ? `${reference.schema}.` : ''}${reference.name}/${reference.arguments}`);
      const first=rows[0];
      const candidates=rows;
      // A non-immutable builtin can change without any observed table write
      // (`now`, `random`, sequence/session helpers, and similar functions).
      // It therefore needs an explicit freshness policy before the query can be
      // cached under the row-impact contract.
      if (candidates.every(candidate=>candidate.schema_name==='pg_catalog' && Number(candidate.oid)<16384)) {
        if(nonRowDependencies==='reject' && candidates.some(candidate=>candidate.provolatile!=='i'))throw new Error('POSTGRES_QUERY_REQUIRES_FRESHNESS_POLICY');
        return [];
      }
      return [...new Set((await Promise.all(candidates.map(candidate=>expand({kind:'function',oid:candidate.oid},new Set(path))))).flat())].sort();
    })();
    if (!path.size) functionCache.set(cacheKey,pending);
    return pending;
  }

  async function expand(object: ObjectReference, path: Set<string>): Promise<readonly string[]> {
    const objectKey=`${object.kind}:${object.oid}`;
    if (path.has(objectKey)) return [];
    if(path.size>=128 || ++expansions>4096)throw new Error('CATALOG_DEPENDENCY_LIMIT');
    path.add(objectKey);
    let directResource: string | undefined;
    let bodyReads: string[] = [];
    if (object.kind==='relation') {
      const rows=await database.unsafe(`select c.oid::text,n.nspname as schema_name,c.relname as object_name,c.relkind,c.relispartition,c.relhasrules,
        array(select a.attname::text from pg_attribute a where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped order by a.attnum) as columns,
        array(select a.attname::text from pg_index i cross join lateral unnest(i.indkey) with ordinality keys(k,ordinal) join pg_attribute a on a.attrelid=c.oid and a.attnum=keys.k where i.indrelid=c.oid and i.indisprimary order by keys.ordinal) as pk
        from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.oid=$1::oid`,[object.oid]) as unknown as RelationRow[];
      const current=rows[0];
      if (!current) throw new Error(`UNRESOLVED_CATALOG_OBJECT:relation:${object.oid}`);
      schemas.add(current.schema_name);
      const policies=await database.unsafe('select pg_get_expr(polqual,polrelid) as expression from pg_policy where polrelid=$1::oid',[current.oid]);
      // RLS may inspect unprojected columns of this very table. A list of
      // resource IDs cannot express those hidden reads, so only proven plain
      // tables permit the SQL compiler to prune observed columns.
      if (['r','p'].includes(current.relkind) && current.relhasrules === false && policies.length === 0) {
        prunableRelations.add(`${current.schema_name}.${current.object_name}`);
      }
      for(const policy of policies)if(policy.expression){
        const parser=require(`@pgsql/parser/v${options.parserVersion ?? 18}`) as {parse(text:string):Promise<unknown>};
        const references=sqlReferences(await parser.parse(`select 1 where (${policy.expression})`));
        if(nonRowDependencies==='reject' && references.nonRow)throw new Error('POSTGRES_QUERY_REQUIRES_FRESHNESS_POLICY');
        if(references.unresolvedExpression)throw new Error('UNRESOLVED_QUERY_EXPRESSION');
        bodyReads.push(...(await Promise.all(references.functions.map(reference=>routine(reference,new Set(path))))).flat());
      }
      if(current.relkind==='v'){
        const [definition]=await database.unsafe('select pg_get_viewdef($1::oid,true) as body',[current.oid]);
        const parser=require(`@pgsql/parser/v${options.parserVersion ?? 18}`) as {parse(text:string):Promise<unknown>};
        const references=sqlReferences(await parser.parse(definition.body));
        if(nonRowDependencies==='reject' && references.nonRow)throw new Error('POSTGRES_QUERY_REQUIRES_FRESHNESS_POLICY');
        if(references.unresolvedExpression)throw new Error('UNRESOLVED_QUERY_EXPRESSION');
        bodyReads.push(...(await Promise.all(references.functions.map(reference=>routine(reference,new Set(path))))).flat());
      }
      const registered=discoveredResource(current);
      if (registered && ['r','p','f','m'].includes(current.relkind)) directResource=registered;
      if (current.relkind==='m' && directResource) return [directResource];
      if (['r','p','f','m'].includes(current.relkind) && !directResource) {
        throw new Error(`UNTRACKED_QUERY_RELATION:${current.schema_name}.${current.object_name}`);
      }
      if (!['v','r','p'].includes(current.relkind)) throw new Error(`UNSUPPORTED_QUERY_RELATION_KIND:${current.schema_name}.${current.object_name}:${current.relkind}`);
    }
    const dependencies=await database.unsafe(`
      with selected as (
        select d.refclassid,d.refobjid from pg_depend d
        where $1='function' and d.classid='pg_proc'::regclass and d.objid=$2::oid
        union
        select d.refclassid,d.refobjid
        from pg_rewrite rewrite join pg_depend d on d.classid='pg_rewrite'::regclass and d.objid=rewrite.oid
        where $1='relation' and rewrite.ev_class=$2::oid and d.refobjid<>rewrite.ev_class
        union
        select d.refclassid,d.refobjid
        from pg_policy policy join pg_depend d on d.classid='pg_policy'::regclass and d.objid=policy.oid
        where $1='relation' and policy.polrelid=$2::oid and not (d.refclassid='pg_class'::regclass and d.refobjid=policy.polrelid)
      )
      select case when refclassid='pg_class'::regclass then 'relation' when refclassid='pg_proc'::regclass then 'function' end as kind,
        refobjid::text as oid
      from selected where refclassid in ('pg_class'::regclass,'pg_proc'::regclass)`,[object.kind,object.oid]) as unknown as ObjectReference[];
    if (object.kind==='function') {
      const rows=await database.unsafe(`select p.oid::text,n.nspname as schema_name,p.proname as object_name,l.lanname,p.prosrc,p.provolatile,p.proconfig,p.prosqlbody::text as sqlbody,
        exists(select 1 from pg_type t where t.oid=any(p.proargtypes::oid[] || array[p.prorettype]) and t.typnamespace<>'pg_catalog'::regnamespace) as custom_types
        from pg_proc p join pg_namespace n on n.oid=p.pronamespace join pg_language l on l.oid=p.prolang where p.oid=$1::oid`,[object.oid]) as unknown as FunctionRow[];
      const fn=rows[0];
      if (!fn) throw new Error(`UNRESOLVED_CATALOG_OBJECT:function:${object.oid}`);
      if(fn.schema_name==='pg_catalog' && Number(fn.oid)<16384){
        if(nonRowDependencies==='reject' && fn.provolatile!=='i')throw new Error('POSTGRES_QUERY_REQUIRES_FRESHNESS_POLICY');
        return [];
      }
      schemas.add(fn.schema_name);
      if(fn.custom_types)throw new Error('UNRESOLVED_FUNCTION_TYPES');
      if(fn.lanname!=='sql')throw new Error(`UNRESOLVED_FUNCTION_BODY:${fn.schema_name}.${fn.object_name}:${fn.lanname}`);
      if(fn.sqlbody){
        if(nonRowDependencies==='reject' && /SQLVALUEFUNCTION|NEXTVALUEEXPR/.test(fn.sqlbody))throw new Error('POSTGRES_QUERY_REQUIRES_FRESHNESS_POLICY');
        const functions=[...fn.sqlbody.matchAll(/:(?:funcid|opfuncid) (\d+)/g)].map(match=>({kind:'function' as const,oid:match[1]})).filter(reference=>reference.oid!=='0');
        return [...new Set((await Promise.all([...dependencies,...functions].map(dependency=>expand(dependency,new Set(path))))).flat())].sort();
      }
      const configuredPath=fn.proconfig?.find(value=>value.startsWith('search_path='));
      if(configuredPath) {
        const declared=configuredPath.slice('search_path='.length).split(',').map(value=>value.trim().replace(/^"|"$/g,''));
        if(declared.some((value,index)=>value!==searchPath[index]) || declared.length!==searchPath.length)throw new Error(`UNRESOLVED_FUNCTION_SEARCH_PATH:${fn.schema_name}.${fn.object_name}`);
      }
      let parser:{parse(text:string):Promise<Record<string,unknown>>};
      try{parser=require(`@pgsql/parser/v${options.parserVersion ?? 18}`) as typeof parser;}
      catch(cause){throw new Error(`POSTGRES_PARSER_UNAVAILABLE:${options.parserVersion ?? 18}`,{cause});}
      let tree:Record<string,unknown>;
      try{tree=await parser.parse(fn.prosrc);}
      catch(cause){throw new Error(`UNRESOLVED_FUNCTION_BODY:${fn.schema_name}.${fn.object_name}:sql`,{cause});}
      const references=sqlReferences(tree);
      if(references.unresolvedExpression)throw new Error('UNRESOLVED_QUERY_EXPRESSION');
      if(nonRowDependencies==='reject' && references.nonRow)throw new Error('POSTGRES_QUERY_REQUIRES_FRESHNESS_POLICY');
      const parsed=[
        ...(await Promise.all(references.relations.map(reference=>relation(reference,new Set(path))))).flat(),
        ...(await Promise.all(references.functions.map(reference=>routine(reference,new Set(path))))).flat(),
        ...(await Promise.all(dependencies.map(dependency=>expand(dependency,new Set(path))))).flat(),
      ];
      if(nonRowDependencies==='reject' && !parsed.length && fn.provolatile!=='i')throw new Error('POSTGRES_QUERY_REQUIRES_FRESHNESS_POLICY');
      return [...new Set(parsed)].sort();
    }
    const resolved=[...bodyReads,...(directResource ? [directResource] : []),...(await Promise.all(dependencies.map(dependency=>expand(dependency,new Set(path))))).flat()];
    return [...new Set(resolved)].sort();
  }

  return Object.freeze({
    resources: resolvedResources,
    get schemas() { return [...schemas].sort(); },
    resolveRelation: (reference: CatalogRelationReference) => relation(reference,new Set()),
    resolveFunction: (reference: CatalogFunctionReference) => routine(reference,new Set()),
    canPruneColumns: (reference: CatalogRelationReference) => columnPruning.get(key(reference)) === true,
  });
}
