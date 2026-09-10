import { createRequire } from 'node:module';
import { canonical, type ReadDependency } from '@server-driven-impact/core';
import { validateResources, type Resources } from '@server-driven-impact/runtime/adapter';
import type { PostgresQueryPlan } from '@server-driven-impact/runtime';
import type { PostgresCatalogResolver } from './catalog-resolver.js';
import { sqlReferences } from './sql-references.js';

const require=createRequire(import.meta.url);
export type PostgresMajor = 14 | 15 | 16 | 17 | 18;
export interface PostgresQuerySource {
  text: string;
  /** Input field for each PostgreSQL $1, $2, ... parameter. */
  parameters?: readonly string[];
  /** Execute through queryUncached; dependency analysis is intentionally unnecessary. */
  cache?: 'no-store';
}

type Json=Record<string,any>;
type DirectRelation={resource:string;alias:string};
type Binding={alias?:string;column:string;parameter:number};

function node(value: unknown,kind:string): Json|undefined {
  if(kind==='SelectStmt' && value && typeof value==='object' && 'op' in value && String((value as Json).op).startsWith('SETOP_'))return value as Json;
  return value && typeof value === 'object' && kind in value ? (value as Json)[kind] as Json : undefined;
}
function stringNode(value: unknown): string|undefined { const string=node(value,'String');return string?.sval ?? string?.str; }
function aliasOf(range:Json): string { return node(range.alias,'Alias')?.aliasname ?? range.alias?.aliasname ?? range.relname; }
function relationReference(range:Json): {schema?:string;name:string} {
  return range.schemaname ? {schema:range.schemaname,name:range.relname} : {name:range.relname};
}

/**
 * Compile static parameterized SQL with the parser for the target PostgreSQL major.
 * Direct relations retain proven bindings. A supplied catalog resolver expands
 * views, functions, and RLS helpers conservatively.
 */
export async function compilePostgresQuery(source: PostgresQuerySource, resources: Resources, version: PostgresMajor, options: {catalog?: PostgresCatalogResolver} = {}): Promise<PostgresQueryPlan> {
  validateResources(resources);
  if (!source || typeof source.text !== 'string' || !source.text.trim() || source.text.length>1_048_576) throw new Error('INVALID_POSTGRES_QUERY');
  const parameters=[...(source.parameters ?? [])];
  if (parameters.some(field=>!field || field.length>128)) throw new Error('INVALID_POSTGRES_QUERY_PARAMETER');
  let parser: {parse(text:string):Promise<Json>};
  try { parser=require(`@pgsql/parser/v${version}`) as typeof parser; }
  catch (cause) { throw new Error(`POSTGRES_PARSER_UNAVAILABLE:${version}`,{cause}); }
  const tree=await parser.parse(source.text);
  if (!Array.isArray(tree.stmts) || tree.stmts.length!==1) throw new Error('POSTGRES_QUERY_REQUIRES_ONE_STATEMENT');
  const root=node(tree.stmts[0]?.stmt,'SelectStmt');
  if (!root) throw new Error('POSTGRES_QUERY_REQUIRES_SELECT');
  const usedParameters=new Set<number>();
  (function inspect(value:unknown):void {
    if(Array.isArray(value)){value.forEach(inspect);return;}
    if(!value || typeof value!=='object')return;
    const parameter=node(value,'ParamRef')?.number;
    if(typeof parameter==='number')usedParameters.add(parameter);
    Object.values(value).forEach(inspect);
  })(root);
  if(usedParameters.size!==parameters.length || parameters.some((_,index)=>!usedParameters.has(index+1)))throw new Error('POSTGRES_QUERY_PARAMETER_MISMATCH');
  if(source.cache !== undefined && source.cache !== 'no-store')throw new Error('INVALID_POSTGRES_CACHE_POLICY');
  if(source.cache==='no-store')return Object.freeze({kind:'postgres-query',text:source.text,parameters:Object.freeze(parameters),reads:Object.freeze([]),cache:'no-store'});
  if(sqlReferences(tree).unresolvedExpression)throw new Error('UNRESOLVED_QUERY_EXPRESSION');

  const byTable=new Map<string,string[]>();
  for (const [id,resource] of Object.entries(resources)) {
    const key=`${resource.schema ?? 'public'}.${resource.table}`;
    byTable.set(key,[...(byTable.get(key) ?? []),id]);
  }
  const reads:ReadDependency[]=[];
  let unresolvedFunction=false;
  let nonDataDependency=false;
  const relationReferences=new Map<string,{schema?:string;name:string}>();
  const functionReferences=new Map<string,{schema?:string;name:string;arguments:number}>();
  function collectReferences(value:unknown,ctes:Set<string>):void {
    if(Array.isArray(value)){value.forEach(child=>collectReferences(child,ctes));return;}
    if(!value || typeof value!=='object')return;
    const select=node(value,'SelectStmt');
    if(select){collectSelectReferences(select,ctes);return;}
    const range=node(value,'RangeVar');
    if(range && (range.schemaname || !ctes.has(range.relname))) {
      const reference=relationReference(range);relationReferences.set(canonical(reference),reference);
    }
    const call=node(value,'FuncCall');
    if(call && Array.isArray(call.funcname)) {
      const names=call.funcname.map(stringNode);
      if(names.every(Boolean) && names.length<=2) {
        const reference={...(names.length===2?{schema:names[0]}:{}),name:names.at(-1)!,arguments:Array.isArray(call.args)?call.args.length:0};
        functionReferences.set(canonical(reference),reference);
      }
    }
    Object.values(value).forEach(child=>collectReferences(child,ctes));
  }
  function collectSelectReferences(select:Json,inherited:Set<string>):void {
    const withClause=select.withClause?.WithClause ?? select.withClause;
    const entries=withClause?.ctes ?? [];
    const names=entries.map((entry:unknown)=>node(entry,'CommonTableExpr')?.ctename).filter(Boolean) as string[];
    const recursive=withClause?.recursive === true;
    const visible=new Set(inherited);
    for(const entry of entries){
      const cte=node(entry,'CommonTableExpr');
      collectReferences(cte?.ctequery,recursive ? new Set([...inherited,...names]) : new Set(visible));
      if(cte?.ctename)visible.add(cte.ctename);
    }
    for(const [key,child] of Object.entries(select))if(key!=='withClause')collectReferences(child,visible);
  }
  collectSelectReferences(root,new Set());
  const catalogRelations=new Map<string,{resources:readonly string[];direct?:string}>();
  for(const reference of relationReferences.values()) {
    const direct=reference.schema
      ? Object.entries(resources).filter(([,resource])=>(resource.schema??'public')===reference.schema && resource.table===reference.name).map(([id])=>id)
      : Object.entries(resources).filter(([,resource])=>resource.table===reference.name).map(([id])=>id);
    if(direct.length>1)throw new Error(`AMBIGUOUS_QUERY_RELATION:${reference.name}`);
    if(!options.catalog){
      if(direct.length===1)continue;
      throw new Error(`UNRESOLVED_QUERY_RELATION:${reference.schema ? `${reference.schema}.` : ''}${reference.name}`);
    }
    const resolved=[...await options.catalog.resolveRelation(reference)];
    if(!resolved.length)throw new Error(`POSTGRES_QUERY_HAS_NO_TRACKED_RELATION:${reference.name}`);
    catalogRelations.set(canonical(reference),{resources:resolved,...(direct.length===1?{direct:direct[0]}:{})});
  }
  for(const reference of functionReferences.values()) {
    if(!options.catalog){unresolvedFunction=true;continue;}
    for(const resource of await options.catalog.resolveFunction(reference)) reads.push({resource,columns:'*',bindings:[]});
  }

  function resourceFor(range:Json):string {
    if (range.schemaname) {
      const ids=byTable.get(`${range.schemaname}.${range.relname}`) ?? [];
      if (ids.length!==1) throw new Error(`UNRESOLVED_QUERY_RELATION:${range.schemaname}.${range.relname}`);
      return ids[0];
    }
    const ids=Object.entries(resources).filter(([,resource])=>resource.table===range.relname).map(([id])=>id);
    if (ids.length!==1) throw new Error(`${ids.length ? 'AMBIGUOUS' : 'UNRESOLVED'}_QUERY_RELATION:${range.relname}`);
    return ids[0];
  }
  function direct(value:unknown,ctes:Set<string>,relations:DirectRelation[]):void {
    const range=node(value,'RangeVar');
    if (range) {
      if (!range.schemaname && ctes.has(range.relname)) return;
      const resolved=catalogRelations.get(canonical(relationReference(range)));
      if(resolved){
        for(const resource of resolved.resources)if(resource!==resolved.direct)reads.push({resource,columns:'*',bindings:[]});
        if(!resolved.direct)return;
      }
      relations.push({resource:resourceFor(range),alias:aliasOf(range)}); return;
    }
    const join=node(value,'JoinExpr');
    if (join) { direct(join.larg,ctes,relations);direct(join.rarg,ctes,relations); }
  }
  function unwrapParameter(value:unknown):number|undefined {
    const parameter=node(value,'ParamRef')?.number;
    if (typeof parameter==='number') return parameter;
    // A cast can change the wire value used by the cache key (`1` versus
    // `$1::text` => `"1"`). Until a shared input/observer codec proves the
    // round-trip, widening is the only selector-safe behavior.
    return undefined;
  }
  function column(value:unknown):{alias?:string;column:string}|undefined {
    const fields=node(value,'ColumnRef')?.fields;
    if (!Array.isArray(fields)) return undefined;
    const names=fields.map(stringNode);
    if (names.length===1 && names[0]) return {column:names[0]};
    if (names.length===2 && names[0] && names[1]) return {alias:names[0],column:names[1]};
    return undefined;
  }
  function atomic(value:unknown):Binding|undefined {
    const expression=node(value,'A_Expr');
    if (!expression || expression.kind!=='AEXPR_OP' || stringNode(expression.name?.[0])!=='=') return undefined;
    const leftColumn=column(expression.lexpr),rightColumn=column(expression.rexpr);
    const leftParameter=unwrapParameter(expression.lexpr),rightParameter=unwrapParameter(expression.rexpr);
    if (leftColumn && rightParameter) return {...leftColumn,parameter:rightParameter};
    if (rightColumn && leftParameter) return {...rightColumn,parameter:leftParameter};
    return undefined;
  }
  function guaranteed(value:unknown):Binding[] {
    const bool=node(value,'BoolExpr');
    if (bool) {
      if (bool.boolop==='NOT_EXPR') return [];
      const branches:Binding[][]=(bool.args ?? []).map(guaranteed);
      if (bool.boolop==='AND_EXPR') return branches.flat();
      if (bool.boolop==='OR_EXPR' && branches.length) return branches[0].filter(binding=>branches.slice(1).every(branch=>branch.some(candidate=>canonical(candidate)===canonical(binding))));
      return [];
    }
    const binding=atomic(value); return binding ? [binding] : [];
  }
  function nested(value:unknown,ctes:Set<string>):void {
    if (Array.isArray(value)) { for (const item of value) nested(item,ctes); return; }
    if (!value || typeof value!=='object') return;
    if ((!options.catalog && 'FuncCall' in value) || 'RangeFunction' in value || 'TableFunc' in value) unresolvedFunction=true;
    if ('SQLValueFunction' in value || 'NextValueExpr' in value) nonDataDependency=true;
    const select=node(value,'SelectStmt');
    if (select) { visitSelect(select,ctes);return; }
    for (const child of Object.values(value)) nested(child,ctes);
  }
  function visitSelect(select:Json,inherited:Set<string>):void {
    const withClause=select.withClause?.WithClause ?? select.withClause;
    const entries=withClause?.ctes ?? [];
    const names=entries.map((entry:unknown)=>node(entry,'CommonTableExpr')?.ctename).filter(Boolean) as string[];
    const recursive=withClause?.recursive === true;
    const ctes=new Set(inherited);
    for(const entry of entries){
      const cte=node(entry,'CommonTableExpr');
      nested(cte?.ctequery,recursive ? new Set([...inherited,...names]) : new Set(ctes));
      if(cte?.ctename)ctes.add(cte.ctename);
    }
    const relations:DirectRelation[]=[];
    for (const entry of select.fromClause ?? []) direct(entry,ctes,relations);
    const aliases=new Map<string,DirectRelation[]>();
    for (const relation of relations) aliases.set(relation.alias,[...(aliases.get(relation.alias) ?? []),relation]);
    const bindings=guaranteed(select.whereClause);
    for (const relation of relations) {
      const resource=resources[relation.resource];
      const resolved=bindings.flatMap(binding=>{
        if (binding.parameter<1 || binding.parameter>parameters.length) return [];
        if (binding.alias) {
          if (binding.alias!==relation.alias || aliases.get(binding.alias)?.length!==1 || !resource.columns.includes(binding.column)) return [];
        } else {
          const owners=relations.filter(candidate=>resources[candidate.resource].columns.includes(binding.column));
          if (owners.length!==1 || owners[0]!==relation) return [];
        }
        return [{column:binding.column,input:parameters[binding.parameter-1]}];
      });
      reads.push({resource:relation.resource,columns:'*',bindings:[...new Map(resolved.map(binding=>[canonical(binding),binding])).values()]});
    }
    for (const [key,value] of Object.entries(select)) if (!['fromClause','whereClause','withClause'].includes(key)) nested(value,ctes);
    for (const entry of select.fromClause ?? []) nested(entry,ctes);
    nested(select.whereClause,ctes);
  }
  visitSelect(root,new Set());
  if (nonDataDependency) throw new Error('POSTGRES_QUERY_REQUIRES_FRESHNESS_POLICY');
  if (unresolvedFunction) throw new Error('UNRESOLVED_QUERY_FUNCTION');
  const allParameters=new Set<number>();
  (function collect(value:unknown):void {
    if (Array.isArray(value)) { value.forEach(collect);return; }
    if (!value || typeof value!=='object') return;
    const parameter=node(value,'ParamRef')?.number;if(typeof parameter==='number')allParameters.add(parameter);
    Object.values(value).forEach(collect);
  })(root);
  if (allParameters.size!==parameters.length || parameters.some((_,index)=>!allParameters.has(index+1))) throw new Error('POSTGRES_QUERY_PARAMETER_MISMATCH');
  if (!reads.length) throw new Error('POSTGRES_QUERY_HAS_NO_TRACKED_RELATION');
  // Reads are alternatives, not fragments of one predicate. In particular, a
  // self-join can read the same resource as `left=$1` and `right=$2`; merging
  // those bindings would invent `left=$1 AND right=$2` for a single changed row
  // and miss both original query inputs. Only identical binding paths may share
  // their observed-column union.
  const merged=new Map<string,ReadDependency>();
  for(const read of reads){
    const bindings=[...read.bindings].sort((a,b)=>canonical(a).localeCompare(canonical(b)));
    const key=canonical([read.resource,bindings]);
    const previous=merged.get(key);
    if(!previous){merged.set(key,{...read,bindings});continue;}
    previous.columns=previous.columns==='*'||read.columns==='*'?'*':[...new Set([...previous.columns,...read.columns])].sort();
  }
  return Object.freeze({kind:'postgres-query',text:source.text,parameters:Object.freeze(parameters),reads:Object.freeze([...merged.values()].map(read=>Object.freeze({...read,bindings:Object.freeze(read.bindings)})))}) as PostgresQueryPlan;
}
