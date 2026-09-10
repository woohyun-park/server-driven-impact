import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

const statement='update public.tasks set done=true where id=1';
const samples=Number(process.env.SDI_COMMAND_SQL_SAMPLES ?? 1000);
if(!Number.isInteger(samples) || samples<100 || samples>100000)throw new Error('INVALID_BENCHMARK_SAMPLES');

if(process.argv.includes('--cold-child')) {
  const started=performance.now();
  const {assertCommandSql}=await import('../../packages/sdi-postgres/dist/postgres/command-sql.js');
  await assertCommandSql(statement);
  process.stdout.write(String((performance.now()-started)*1000));
  process.exit(0);
}

const {assertCommandSql}=await import('../../packages/sdi-postgres/dist/postgres/command-sql.js');
await assertCommandSql(statement);
const warm=[];
for(let index=0;index<samples;index++) {
  const started=performance.now();
  await assertCommandSql(statement);
  warm.push((performance.now()-started)*1000);
}
const cold=[];
for(let index=0;index<20;index++) {
  const child=spawnSync(process.execPath,[new URL(import.meta.url).pathname,'--cold-child'],{encoding:'utf8'});
  if(child.status!==0)throw new Error(child.stderr || 'COLD_BENCHMARK_FAILED');
  cold.push(Number(child.stdout));
}
const summarize=values=>{
  values.sort((a,b)=>a-b);
  return {samples:values.length,p50Us:Number(values[Math.ceil(values.length*.5)-1].toFixed(3)),p95Us:Number(values[Math.ceil(values.length*.95)-1].toFixed(3))};
};
const report={
  executedAt:new Date().toISOString(),
  node:process.version,
  parser:'@pgsql/parser@1.5.0/v18',
  statementBytes:Buffer.byteLength(statement),
  coldProcess:summarize(cold),
  warmParser:summarize(warm),
};
mkdirSync('.local/runtime/postgres-release',{recursive:true});
writeFileSync('.local/runtime/postgres-release/command-sql-benchmark.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
