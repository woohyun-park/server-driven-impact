import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { calculateImpact, matchesInputSelector, type WriteFact } from '@server-driven-impact/core';
import { compileManifest, createImpact, q, type Resources } from '@server-driven-impact/runtime';
import { sqliteAdapter } from '@server-driven-impact/sqlite';

const input={parse:(value:unknown)=>value};
const resources:Resources={
  orders:{table:'orders',idColumn:'id',scopeColumn:null,columns:['id','customer','note','sort']},
  items:{table:'items',idColumn:'id',scopeColumn:null,columns:['id','order_id','amount']},
};

describe('Query Plan precision with real SQLite result comparisons',()=>{
  it('ignores count-only projection, order and optional joins while retaining row membership',async()=>{
    const database=new DatabaseSync(':memory:');
    try {
      database.exec('create table orders(id text primary key,customer text,note text,sort integer); create table items(id text primary key,order_id text,amount integer);');
      const options={columns:['note'],where:[q.eq('customer',q.input('customer'))],order:[{field:'sort'}],joins:[{as:'items',resource:'items',local:'id',foreign:'order_id',many:true}]};
      const queries={count:{input,plan:q.count('orders',options)},required:{input,plan:q.count('orders',{...options,joins:options.joins.map(join=>({...join,required:true}))})}};
      const manifest=compileManifest(queries,resources);
      expect(manifest.sources.count).toEqual(['orders']);
      expect(manifest.reads.count).toEqual([{resource:'orders',columns:['customer'],bindings:[{column:'customer',input:'customer'}]}]);
      expect(manifest.sources.required).toEqual(['items','orders']);
      const engine=createImpact({adapter:sqliteAdapter({database}),resources,queries});
      const context={scope:null};
      expect(await engine.query('count',{customer:'a'},context)).toBe(0);
      const inserted=await engine.command(context,tx=>tx.execute("insert into orders values('one','a','old',1)"));
      expect(await engine.query('count',{customer:'a'},context)).toBe(1);
      expect(inserted.impact.targets.some(target=>target.endpoint==='count' && matchesInputSelector({customer:'a'},target.selector))).toBe(true);
      const unobserved=await engine.command(context,tx=>tx.execute("update orders set note='new',sort=2"));
      expect(await engine.query('count',{customer:'a'},context)).toBe(1);
      expect(unobserved.impact.targets).toEqual([]);
      expect(await engine.query('required',{customer:'a'},context)).toBe(0);
      const child=await engine.command(context,tx=>tx.execute("insert into items values('child','one',10)"));
      expect(await engine.query('required',{customer:'a'},context)).toBe(1);
      expect(child.impact.targets.map(target=>target.endpoint)).toEqual(['required']);
      const moved=await engine.command(context,tx=>tx.execute("update orders set customer='b'"));
      expect(await engine.query('count',{customer:'a'},context)).toBe(0);
      expect(await engine.query('count',{customer:'b'},context)).toBe(1);
      const selector=moved.impact.targets.find(target=>target.endpoint==='count')!.selector;
      expect(matchesInputSelector({customer:'a'},selector)).toBe(true);
      expect(matchesInputSelector({customer:'b'},selector)).toBe(true);
      expect(matchesInputSelector({customer:'c'},selector)).toBe(false);
    } finally { database.close(); }
  });
  it('propagates parent equality into nested joins without narrowing unrelated inputs',()=>{
    const manifest=compileManifest({detail:{input,plan:q.select('orders',{columns:['id'],where:[q.eq('id',q.input('order'))],joins:[{as:'items',resource:'items',local:'id',foreign:'order_id',columns:['amount']}]})}},resources);
    expect(manifest.reads.detail[1].bindings).toEqual([{column:'order_id',input:'order'}]);
    const changed:WriteFact={resource:'items',operation:'update',before:{kind:'known',scope:null,fields:{order_id:'a'}},after:{kind:'known',scope:null,fields:{order_id:'b'}},changedColumns:['order_id']};
    const impact=calculateImpact([changed],{resources,manifest,scope:null});
    expect(impact.targets[0].selector).toEqual({kind:'inputs',values:[{order:'a'},{order:'b'}]});
  });
});
