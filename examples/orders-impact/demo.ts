import { DatabaseSync } from 'node:sqlite';
import { matchesInputSelector } from '@server-driven-impact/core';
import { createImpact } from '@server-driven-impact/runtime';
import { sqliteAdapter } from '@server-driven-impact/sqlite';
import { ordersDomain } from './domain.js';

const database=new DatabaseSync(':memory:');
database.exec(`pragma foreign_keys=on;create table orders(id text primary key,tenant_id text not null,customer_id text,status text not null,priority integer not null,note text);create table order_items(id text primary key,tenant_id text not null,order_id text references orders(id) on delete cascade,amount integer not null);`);
try {
  const engine=createImpact({adapter:sqliteAdapter({database}),...ordersDomain('main')});
  const context={scope:'tenant-one'};
  await engine.command(context,db=>db.insert('orders',[{id:'one',tenant_id:'tenant-one',customer_id:'old',status:'ready',priority:1,note:null}]));
  const result=await engine.command(context,db=>db.update('orders',{where:{id:'one'},set:{customer_id:'new'}}));
  for(const customer of ['old','new'])if(!result.impact.targets.some(target=>target.endpoint==='orders.list'&&matchesInputSelector({customer},target.selector)))throw new Error('MISSING_CUSTOMER_IMPACT');
  console.log(JSON.stringify({data:await engine.query('orders.list',{customer:'new'},context),impact:result.impact},null,2));
} finally { database.close(); }
