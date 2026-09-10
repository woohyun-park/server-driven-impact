import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe,it,expect } from 'vitest';
import { readFileSync,readdirSync } from 'node:fs';
import { calculateImpact,createImpact,WriteSet,LIMITS,canonical,matchesInputSelector,type WriteFact } from '@server-driven-impact/core';
import type {Resources,QueryManifest} from '@server-driven-impact/runtime';
import { q,compileManifest } from '@server-driven-impact/runtime';
import { generateObserverMigration,rowsToFacts } from '../../packages/sdi-postgres/src/postgres/observer.js';
const resources: Resources={records:{table:'records',idColumn:'id',scopeColumn:'tenant',columns:['id','tenant','filter','value','sort'],selectorColumns:['id','filter']}};
const manifest: QueryManifest={protocolVersion:1,reads:{list:[{resource:'records',columns:['value','filter','sort'],bindings:[{column:'filter',input:'filter'}]}]}};
const known=(filter: string|number|boolean|null,scope='a')=>({kind:'known' as const,scope,fields:{filter}});
const fact=(filter: string|number|boolean|null):WriteFact=>({resource:'records',operation:'insert',before:{kind:'absent'},after:known(filter),changedColumns:null});
it('converts PostgreSQL observer rows into database-neutral facts',()=>{
  expect(rowsToFacts([{resource:'records',operation:'update',before_state:{kind:'known',scope:'a',fields:{filter:'old'}},after_state:{kind:'known',scope:'a',fields:{filter:'new'}},changed_columns:['filter']}])).toEqual([
    {resource:'records',operation:'update',before:{kind:'known',scope:'a',fields:{filter:'old'}},after:{kind:'known',scope:'a',fields:{filter:'new'}},changedColumns:['filter']},
  ]);
});
const engine=createImpact({resources,manifest});
describe('language neutral conformance',()=>{
  const ajv=new Ajv2020({allowUnionTypes:true});
  const schema=(name:string)=>ajv.compile(JSON.parse(readFileSync(new URL('../../spec/server-driven-impact/schemas/'+name+'.schema.json',import.meta.url),'utf8')));
  const validFact=schema('write-fact'),validManifest=schema('query-manifest'),validImpact=schema('impact-set');
  for(const file of readdirSync(new URL('../../spec/server-driven-impact/fixtures/',import.meta.url))) {
    const fixture=JSON.parse(readFileSync(new URL('../../spec/server-driven-impact/fixtures/'+file,import.meta.url),'utf8'));
    it(file,()=>{expect(validManifest(fixture.manifest)).toBe(true);for(const fact of fixture.writes)expect(validFact(fact)).toBe(true);expect(validImpact(fixture.impact)).toBe(true);const result=createImpact({resources:fixture.resources,manifest:fixture.manifest}).explain(fixture.writes,fixture.scope);expect(validImpact(result.impact)).toBe(true);expect(result.impact).toEqual(fixture.impact);for(const reason of fixture.reasons)expect(result.decisions.some(d=>d.reason===reason)).toBe(true);});
  }
});
describe('bounded facts and conservative impact',()=>{
  it.each([null,false,true,0,19,'x'])('matches JSON scalar %s',value=>{
    const impact=engine.calculate([fact(value)],'a');
    expect(matchesInputSelector({filter:value},impact.targets[0].selector)).toBe(true);
    expect(matchesInputSelector({filter:typeof value==='string'?19:'different'},impact.targets[0].selector)).toBe(false);
    expect(matchesInputSelector({},impact.targets[0].selector)).toBe(true);
  });
  it('conservatively matches database numeric coercion and SQLite built-in collations',()=>{
    const selector={kind:'inputs' as const,values:[{filter:1}]};
    expect(matchesInputSelector({filter:'1'},selector)).toBe(true);
    expect(matchesInputSelector({filter:'01'},selector)).toBe(true);
    expect(matchesInputSelector({filter:'one'},selector)).toBe(false);
    expect(matchesInputSelector({filter:'WORK'},{kind:'inputs',values:[{filter:'work'}]})).toBe(true);
    expect(matchesInputSelector({filter:'work   '},{kind:'inputs',values:[{filter:'work'}]})).toBe(true);
  });
  it('unknown OLD widens but absent OLD does not; cross-tenant fields never escape',()=>{
    expect(engine.calculate([fact('old')],'b').targets).toEqual([]);
    const impact=engine.calculate([{...fact('new'),before:{kind:'unknown'}}],'a');
    expect(impact.targets[0].selector).toEqual({kind:'all'});
    expect(canonical(impact)).not.toContain('new');
  });
  it('scope membership changes matter even if projected columns did not change',()=>{
    expect(engine.calculate([{...fact('x'),operation:'update',before:known('x','b'),changedColumns:['tenant']}],'a').targets).toHaveLength(1);
  });
  it('known empty changed columns skip while unknown changes invalidate',()=>{
    expect(engine.calculate([{...fact('x'),operation:'update',changedColumns:[]}],'a').targets).toEqual([]);
    expect(engine.calculate([{...fact('x'),operation:'update'}],'a').targets).toHaveLength(1);
  });
  it('captures old and new filters and visited intermediate states',()=>{
    const writes=[{...fact(2),operation:'update' as const,before:known(1),changedColumns:['filter']},{...fact(3),operation:'update' as const,before:known(2),changedColumns:['filter']}];
    expect(engine.calculate(writes,'a').targets[0].selector).toEqual({kind:'inputs',values:[{filter:1},{filter:2},{filter:3}]});
  });
  it('copies input and output, closes contexts, isolates requests, caps facts and bytes',()=>{
    const writes=new WriteSet();const original=fact('x');writes.add([original]);original.after=known('mutated');
    expect(writes.snapshot()[0].after).toEqual(known('x'));
    const snapshot=writes.snapshot();snapshot[0].after=known('changed');expect(writes.snapshot()[0].after).toEqual(known('x'));
    writes.add(Array.from({length:LIMITS.facts},(_,i)=>fact(i)));
    expect(writes.snapshot()).toHaveLength(1);expect(engine.calculate(writes.snapshot(),'a').targets[0].selector.kind).toBe('all');
    const bytes=new WriteSet();bytes.add([fact('x'.repeat(LIMITS.factBytes))]);expect(bytes.snapshot()[0].after).toEqual({kind:'known',scope:'a',fields:{}});
    expect(new WriteSet().snapshot()).toEqual([]);writes.close();expect(()=>writes.add([])).toThrow('WRITE_CONTEXT_CLOSED');
  });
  it('selector and response byte budgets widen without dropping endpoints',()=>{
    expect(engine.explain(Array.from({length:101},(_,i)=>fact(i)),'a').decisions.some(d=>d.reason==='selector-limit')).toBe(true);
    const result=engine.explain([fact('x'.repeat(LIMITS.impactBytes))],'a');expect(result.impact.targets[0].selector.kind).toBe('all');expect(result.decisions.some(d=>d.reason==='byte-limit')).toBe(true);
  });
  it.each([NaN,Infinity,1n,new Date(),{nested:true}])('rejects unsupported scalar values %s',value=>{
    const writes=new WriteSet();expect(()=>writes.add([fact(value as unknown as string)])).toThrow();
  });
  it('validates unsupported manifest versions and columns before serving commands',()=>{
    expect(()=>createImpact({resources,manifest:{...manifest,protocolVersion:2 as 1}})).toThrow('UNSUPPORTED_MANIFEST_VERSION');
    expect(()=>calculateImpact([],{resources,manifest:{...manifest,protocolVersion:2 as 1},scope:'a'})).toThrow('UNSUPPORTED_MANIFEST_VERSION');
    expect(()=>compileManifest({bad:{input:{parse:(v:unknown)=>v},plan:q.select('records',{columns:['missing']})}},resources)).toThrow('UNREGISTERED_COLUMN');
  });
  it('canonicalization is independent of object insertion order and preserves missing/null',()=>{
    expect(canonical({b:1,a:null})).toBe(canonical({a:null,b:1}));expect(canonical({})).not.toBe(canonical({a:null}));
  });
  it('query compilation includes predicate, order, and join membership; opaque mapping widens',()=>{
    const queries={source:{input:{parse:(v:unknown)=>v},plan:q.select('records',{columns:['value'],where:[q.eq('filter',q.input('filter'))],order:[{field:'sort'}]})},mapped:{input:{parse:(v:unknown)=>v},plan:q.call('source',()=>({filter:1}))}};
    const graph=compileManifest(queries,resources);
    expect(graph.reads.source[0].columns).toEqual(['filter','sort','value']);expect(graph.reads.mapped[0].bindings).toEqual([]);
  });
  it('preserves bindings through an identity call and widens an arbitrary call mapping',()=>{
    const source={input:{parse:(v:unknown)=>v},plan:q.select('records',{where:[q.eq('filter',q.input('filter'))]})};
    const graph=compileManifest({source,identity:{input:source.input,plan:q.call('source')},mapped:{input:source.input,plan:q.call('source',()=>({filter:1}))}},resources);
    expect(graph.reads.identity[0].bindings).toEqual([{column:'filter',input:'filter'}]);
    expect(graph.reads.mapped[0].bindings).toEqual([]);
  });
  it('keeps only input bindings guaranteed by every OR branch',()=>{
    const input={parse:(value:unknown)=>value};
    const graph=compileManifest({
      exact:{input,plan:q.select('records',{where:[q.or(
        q.and(q.eq('filter',q.input('filter')),q.eq('value',q.literal('a'))),
        q.and(q.eq('filter',q.input('filter')),q.eq('value',q.literal('b'))),
      )]})},
      broad:{input,plan:q.select('records',{where:[q.or(
        q.eq('filter',q.input('filter')),
        q.eq('value',q.literal('public')),
      )]})},
    },resources);
    expect(graph.reads.exact[0].bindings).toEqual([{column:'filter',input:'filter'}]);
    expect(graph.reads.broad[0].bindings).toEqual([]);
  });
  it('merges observed columns from duplicate read bindings',()=>{
    const sql=generateObserverMigration(resources,{protocolVersion:1,reads:{detail:[
      {resource:'records',columns:['value'],bindings:[{column:'filter',input:'filter'}]},
      {resource:'records',columns:['sort'],bindings:[{column:'filter',input:'filter'}]},
    ]}});
    expect(sql).toMatch(/o\."value".*is distinct from.*n\."value"/);
    expect(sql).toMatch(/o\."sort".*is distinct from.*n\."sort"/);
  });
});
