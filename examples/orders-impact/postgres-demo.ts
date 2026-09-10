import postgres from 'postgres';
import { Pool } from 'pg';
import { pgAdapter } from '@server-driven-impact/postgres/pg';
import { randomUUID } from 'node:crypto';
import { createImpact } from '@server-driven-impact/runtime';
import { compileManifest } from '@server-driven-impact/runtime';
import { generateObserverMigration,postgresAdapter } from '@server-driven-impact/postgres';
import { ordersDomain } from './domain.js';

const isLoopback=(value:string|undefined)=>{if(!value)return false;const hostname=new URL(value).hostname;return hostname==='127.0.0.1'||hostname==='localhost'||hostname==='[::1]';};
const runtimeUrl=process.env.SDI_POSTGRES_RUNTIME_URL;
if(!isLoopback(process.env.SDI_POSTGRES_ADMIN_URL)||!isLoopback(runtimeUrl))throw new Error('LOCAL_CONSUMER_ONLY');
const url=new URL(process.env.SDI_POSTGRES_ADMIN_URL!);
const namespace='pack_'+randomUUID().replaceAll('-','');
const admin=postgres(url.toString(),{max:1,onnotice:()=>{}}),database=postgres(runtimeUrl!,{max:2,onnotice:()=>{}});
const nodePool=process.env.SDI_POSTGRES_DRIVER==='pg'?new Pool({connectionString:runtimeUrl,max:2}):undefined;
const definitions=ordersDomain(namespace),manifest=compileManifest(definitions.queries,definitions.resources);
try {
  await admin.unsafe(`create schema ${namespace};create table ${namespace}.orders(id text primary key,tenant_id text not null,customer_id text,status text not null,priority integer not null,note text);create table ${namespace}.order_items(id text primary key,tenant_id text not null,order_id text references ${namespace}.orders(id) on delete cascade,amount integer not null);grant usage on schema ${namespace} to routine_runtime;grant select,insert,update,delete on all tables in schema ${namespace} to routine_runtime;`);
  for(const name of ['orders','order_items'])await admin.unsafe(`alter table ${namespace}.${name} enable row level security;create policy own on ${namespace}.${name} for all to routine_runtime using(tenant_id=current_setting('sdi.scope')) with check(tenant_id=current_setting('sdi.scope'));`);
  await admin.unsafe(generateObserverMigration(definitions.resources,manifest,{runtimeRole:'routine_runtime'}));
  const setup:NonNullable<Parameters<typeof postgresAdapter>[0]['setup']>=async(tx,scope)=>{
    await tx.unsafe("select set_config('sdi.scope',$1,true)",[String(scope)]);
  };
  const engine=createImpact({adapter:nodePool?pgAdapter({database:nodePool,setup}):postgresAdapter({database,setup}),...definitions}),context={scope:'pack-user'};
  await engine.validate();
  const result=await engine.command(context,db=>db.insert('orders',[{id:'one',tenant_id:'pack-user',customer_id:'old',status:'ready',priority:1,note:null}]));
  if(!result.impact.targets.some(target=>target.endpoint==='orders.list'))throw new Error('MISSING_IMPACT');
  if((await engine.query('orders.list',{customer:'old'},context) as unknown[]).length!==1)throw new Error('MISSING_QUERY_RESULT');
  console.log(`Standalone ${nodePool?'pg':'postgres.js'} Query, Command, observer and impact passed.`);
} finally { await nodePool?.end();await database.end();await admin.unsafe(`drop schema if exists ${namespace} cascade`);await admin.end(); }
