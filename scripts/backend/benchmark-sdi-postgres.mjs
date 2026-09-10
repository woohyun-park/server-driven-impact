import postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import { mkdirSync,writeFileSync } from 'node:fs';
import { createImpact,q,compileManifest } from '@server-driven-impact/runtime';
import { generateObserverMigration,postgresAdapter,Sql } from '@server-driven-impact/postgres';

for(const name of ['SDI_POSTGRES_ADMIN_URL','SDI_POSTGRES_RUNTIME_URL'])if(!process.env[name] || !['127.0.0.1','localhost','::1'].includes(new URL(process.env[name]).hostname))throw new Error('ISOLATED_LOCAL_BENCHMARK_REQUIRED');
const admin=postgres(process.env.SDI_POSTGRES_ADMIN_URL,{max:1,prepare:false,onnotice:()=>{}});
const schema='sdi_bench_'+randomUUID().replaceAll('-','');
let businessSelects=0;
const database=postgres(process.env.SDI_POSTGRES_RUNTIME_URL,{max:1,prepare:false,onnotice:()=>{},debug:(_connection,text)=>{
  if(/^\s*select\b/i.test(text) && text.includes(`from "${schema}".`))businessSelects++;
}});
const samples=Number(process.env.SDI_BENCHMARK_SAMPLES ?? 30);
if(!Number.isInteger(samples)||samples<5||samples>1_000)throw new Error('INVALID_BENCHMARK_SAMPLES');
const results=[];
try {
  await admin.unsafe(`create schema "${schema}";grant usage on schema "${schema}" to routine_runtime`);
  const engines={};
  for(const mode of ['native','broad','narrow']){
    await admin.unsafe(`create table "${schema}".${mode}(id integer primary key,value integer not null);grant select,insert,update,delete on "${schema}".${mode} to routine_runtime`);
    if(mode==='native')continue;
    const resources={rows:{schema,table:mode,idColumn:'id',scopeColumn:null,columns:['id','value']}};
    const queries={list:{input:{parse:value=>value},plan:q.select('rows',mode==='narrow'?{where:[q.eq('id',q.input('id'))]}:{})}};
    await admin.unsafe(generateObserverMigration(resources,compileManifest(queries,resources),{runtimeRole:'routine_runtime'}));
    engines[mode]=createImpact({adapter:postgresAdapter({database}),resources,queries});
  }
  for(const rows of [1,1000,10000])for(const mode of ['native','broad','narrow']){
    await admin.unsafe(`truncate "${schema}".${mode};insert into "${schema}".${mode} select n,0 from generate_series(1,${rows}) n`);
    const durations=[];let bytes=0;
    for(let sample=-2;sample<samples;sample++){
      const start=performance.now();const statement=`update "${schema}".${mode} set value=value+1`;
      const response=mode==='native'?await database.begin('isolation level repeatable read',tx=>tx.unsafe(statement)):await engines[mode].command({scope:'bench'},db=>db.postgres.execute(new Sql(statement)));
      if(sample>=0){durations.push(performance.now()-start);bytes=Math.max(bytes,Buffer.byteLength(JSON.stringify(response)));}
    }
    durations.sort((a,b)=>a-b);const percentile=p=>Number(durations[Math.ceil(p*durations.length)-1].toFixed(3));
    results.push({rows,mode,samples,p50Ms:percentile(.5),p95Ms:percentile(.95),p99Ms:percentile(.99),maxResponseBytes:bytes});
  }
  mkdirSync('.local/runtime/postgres-release',{recursive:true});
  if(businessSelects!==0)throw new Error('INVERSE_BUSINESS_SELECT_DETECTED');
  const report={executedAt:new Date().toISOString(),server:(await admin.unsafe('select version() as version'))[0].version,driver:'postgres@3.4.8',validation:'explicit-not-run-in-samples',samples,businessSelects,results};
  writeFileSync('.local/runtime/postgres-release/benchmark.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
} finally {await database.end();await admin.unsafe(`drop schema if exists "${schema}" cascade`);await admin.end();}
