import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/index.js';
const url = process.env.SDI_PRISMA_DATABASE_URL;
if (!url || !['127.0.0.1','localhost','[::1]'].includes(new URL(url).hostname)) throw new Error('LOCAL_DATABASE_REQUIRED');
const schema = `sdi_prisma_${randomUUID().replaceAll('-', '')}`;
const pool = new pg.Pool({connectionString:url,max:4,options:`-c search_path=${schema}`});
const evidence = [];
class BoundPool extends pg.Pool {
  constructor(db) { super({max:1}); this.db=db; }
  query(...args) { return this.db.query(...args); }
  connect() { throw new Error('BOUND_POOL_CANNOT_RESERVE'); }
}
function factory(db) {
  return {
    provider:'postgres', adapterName:'sdi-prisma-feasibility',
    async connect() {
      const pool = new BoundPool(db);
      const inner = await new PrismaPg(pool,{schema}).connect();
      return {
        provider:'postgres',adapterName:'sdi-prisma-feasibility',
        queryRaw:q=>inner.queryRaw(q), executeRaw:q=>inner.executeRaw(q),
        executeScript:()=>{throw new Error('SCRIPT_UNSUPPORTED');},
        getConnectionInfo:()=>inner.getConnectionInfo(),
        dispose:()=>inner.dispose(),
        async startTransaction() {
          let open, fail, resolveGate, rejectGate;
          const ready = new Promise((a,b)=>{open=a;fail=b;});
          const gate = new Promise((a,b)=>{resolveGate=a;rejectGate=b;});
          const marker = new Error('SAVEPOINT_ROLLBACK');
          const completion = db.savepoint(async child=>{
            const adapter = await factory(child).connect();
            open(adapter);
            try {await gate;} finally {await adapter.dispose();}
          });
          completion.catch(fail);
          const adapter = await ready;
          evidence.push('prisma-savepoint-open');
          return {
            provider:'postgres',adapterName:'sdi-prisma-feasibility',options:{usePhantomQuery:true},
            queryRaw:q=>adapter.queryRaw(q),executeRaw:q=>adapter.executeRaw(q),
            async commit(){resolveGate();await completion;evidence.push('prisma-savepoint-commit');},
            async rollback(){rejectGate(marker);try {await completion;}catch(e){if(e!==marker)throw e;}evidence.push('prisma-savepoint-rollback');},
          };
        },
      };
    },
  };
}
let savepointNumber=0;
function dbFor(client) {
  let active=true;
  return {
    close(){active=false;},
    query(...args){if(!active)throw new Error('COMMAND_CLOSED');return client.query(...args);},
    async savepoint(fn){
      if(!active)throw new Error('COMMAND_CLOSED');
      const name=`sdi_prisma_sp_${++savepointNumber}`;
      await client.query(`SAVEPOINT ${name}`);
      const child=dbFor(client);
      try {const result=await fn(child);child.close();await client.query(`RELEASE SAVEPOINT ${name}`);return result;}
      catch(e){child.close();await client.query(`ROLLBACK TO SAVEPOINT ${name}`);await client.query(`RELEASE SAVEPOINT ${name}`);throw e;}
    }
  };
}
async function command(token, fn, failDrain=false) {
  const client=await pool.connect();
  const record={token, phases:[], facts:[]};
  evidence.push(record);
  let began=false,committed=false;
  const db=dbFor(client);
  let prisma;
  try {
    await client.query('CREATE TEMP TABLE IF NOT EXISTS sdi_prisma_collector(token text, kind text, id int) ON COMMIT PRESERVE ROWS');
    record.phases.push(['prepare',(await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid]);
    await client.query('BEGIN');began=true;
    await client.query("SELECT set_config('sdi.prisma_token',$1,true)",[token]);
    prisma=new PrismaClient({adapter:factory(db)});
    const result=await fn(prisma,db);
    record.phases.push(['callback',(await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid]);
    record.beforeCommit=(await client.query('SELECT kind,id FROM sdi_prisma_collector WHERE token=$1 ORDER BY kind,id',[token])).rows;
    db.close();
    await client.query('COMMIT');committed=true;
    record.phases.push(['commit',(await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid]);
    if(failDrain)throw new Error('INJECTED_DRAIN_FAILURE');
    record.facts=(await client.query('DELETE FROM sdi_prisma_collector WHERE token=$1 RETURNING kind,id',[token])).rows;
    record.phases.push(['drain',(await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid]);
    assert.equal(new Set(record.phases.map(p=>p[1])).size,1);
    return {result,record};
  } catch(e) {
    db.close();record.error=e.message;record.committed=committed;
    if(began&&!committed)await client.query('ROLLBACK');
    throw e;
  } finally {
    await prisma?.$disconnect();
    // The fixture discards failed connections instead of returning dirty collectors.
    client.release(record.error?true:undefined);
  }
}
try {
  await pool.query(`CREATE SCHEMA "${schema}"`);
  await pool.query(`
    CREATE TABLE sdi_prisma_effect(id int PRIMARY KEY, value text NOT NULL);
    CREATE TABLE sdi_prisma_child(id int PRIMARY KEY, "effectId" int NOT NULL REFERENCES sdi_prisma_effect(id) ON DELETE CASCADE);
    CREATE TABLE sdi_prisma_audit(id int PRIMARY KEY REFERENCES sdi_prisma_effect(id) DEFERRABLE INITIALLY DEFERRED);
    CREATE FUNCTION sdi_prisma_observe() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF current_setting('sdi.prisma_token',true) IS NOT NULL THEN
        INSERT INTO pg_temp.sdi_prisma_collector VALUES(current_setting('sdi.prisma_token',true),TG_TABLE_NAME,NEW.id);
      END IF;
      RETURN NEW;
    END $$;
    CREATE FUNCTION sdi_prisma_defer() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN INSERT INTO sdi_prisma_audit VALUES(NEW.id); RETURN NEW; END $$;
    CREATE TRIGGER observe AFTER INSERT ON sdi_prisma_effect FOR EACH ROW EXECUTE FUNCTION sdi_prisma_observe();
    CREATE TRIGGER observe AFTER INSERT ON sdi_prisma_child FOR EACH ROW EXECUTE FUNCTION sdi_prisma_observe();
    CREATE TRIGGER observe AFTER INSERT ON sdi_prisma_audit FOR EACH ROW EXECUTE FUNCTION sdi_prisma_observe();
    CREATE CONSTRAINT TRIGGER deferred_write AFTER INSERT ON sdi_prisma_effect DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION sdi_prisma_defer();
  `);
  let leaked,lazy;
  const success=await command('success',async prisma=>{
    leaked=prisma;
    lazy=prisma.effect.findMany();
    return prisma.effect.create({data:{id:1,value:'direct',children:{create:{id:101}}},include:{children:true}});
  });
  assert.equal(success.result.children[0].id,101);
  assert.equal(success.record.beforeCommit.some(f=>f.kind==='sdi_prisma_audit'),false);
  assert.deepEqual(success.record.facts.map(f=>`${f.kind}:${f.id}`).sort(),['sdi_prisma_audit:1','sdi_prisma_child:101','sdi_prisma_effect:1']);
  await assert.rejects(async()=>leaked.effect.findMany(),/COMMAND_CLOSED/);
  await assert.rejects(async()=>await lazy,/COMMAND_CLOSED/);
  await command('savepoint',async prisma=>{
    await assert.rejects(()=>prisma.effect.create({data:{id:2,value:'cancelled',children:{create:{id:101}}}}));
    await prisma.effect.create({data:{id:3,value:'retained'}});
  }).then(({record})=>assert.deepEqual(record.facts.map(f=>`${f.kind}:${f.id}`).sort(),['sdi_prisma_audit:3','sdi_prisma_effect:3']));
  await assert.rejects(()=>command('rollback',async prisma=>{await prisma.effect.create({data:{id:4,value:'rollback'}});throw new Error('ROLLBACK_REQUEST');}),/ROLLBACK_REQUEST/);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM sdi_prisma_effect WHERE id IN (2,4)')).rows[0].count,0);
  await assert.rejects(()=>command('commit-failure',async prisma=>{await prisma.$executeRawUnsafe('INSERT INTO sdi_prisma_audit VALUES (999)');}),/foreign key/);
  await assert.rejects(()=>command('drain-failure',async prisma=>{await prisma.effect.create({data:{id:5,value:'committed'}});},true),/INJECTED_DRAIN_FAILURE/);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM sdi_prisma_effect WHERE id=5')).rows[0].count,1);
  const concurrent=await Promise.all([6,7].map(id=>command(`parallel-${id}`,p=>p.effect.create({data:{id,value:'parallel'}}))));
  for(const {result,record} of concurrent)assert(record.facts.every(f=>f.id===result.id));
  console.log(JSON.stringify({versions:{prisma:'7.10.0',adapterPg:'7.10.0',pg:'8.16.3',node:process.version,postgres:(await pool.query('SHOW server_version')).rows[0].server_version},checks:'PASS',evidence},null,2));
} finally {
  await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await pool.end();
}
