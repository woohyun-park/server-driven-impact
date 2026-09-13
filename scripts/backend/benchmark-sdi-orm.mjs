import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { integer, pgSchema } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { createImpact, compileManifest, q } from '@server-driven-impact/runtime';
import { generateObserverMigration } from '@server-driven-impact/postgres';
import { pgAdapter } from '@server-driven-impact/postgres/pg';
import { drizzleAdapter } from '@server-driven-impact/postgres/drizzle';

for (const key of ['SDI_POSTGRES_ADMIN_URL', 'SDI_POSTGRES_RUNTIME_URL']) {
  if (!process.env[key] || !['127.0.0.1', 'localhost', '::1'].includes(new URL(process.env[key]).hostname))
    throw new Error('ISOLATED_LOCAL_BENCHMARK_REQUIRED');
}
const samples = Number(process.env.SDI_BENCHMARK_SAMPLES ?? 15);
if (!Number.isInteger(samples) || samples < 10 || samples > 1000)
  throw new Error('BENCHMARK_REQUIRES_10_TO_1000_SAMPLES');
const withPrisma = process.env.SDI_BENCHMARK_PRISMA !== '0';
const output = resolve(process.env.SDI_BENCHMARK_OUTPUT ?? '.local/runtime/orm-benchmark.json');
const schema = `sdi_orm_bench_${randomUUID().replaceAll('-', '')}`;
const scope = new AsyncLocalStorage();
const holds = new WeakMap();
class InstrumentedClient extends pg.Client {
  query(...args) {
    const sample = scope.getStore();
    if (sample) {
      const text = typeof args[0] === 'string' ? args[0] : (args[0]?.text ?? '');
      sample.sqlCalls++;
      if (/^\s*select\b/i.test(text) && new RegExp(`\\bfrom\\s+"?${schema}"?\\.`, 'i').test(text))
        sample.businessSelects++;
    }
    return super.query(...args);
  }
}
const pool = new pg.Pool({
  connectionString: process.env.SDI_POSTGRES_RUNTIME_URL,
  max: 4,
  Client: InstrumentedClient,
});
pool.on('acquire', client => {
  const sample = scope.getStore();
  if (sample) holds.set(client, { sample, start: performance.now() });
});
pool.on('release', (_error, client) => {
  const hold = holds.get(client);
  if (hold) {
    hold.sample.connectionHoldMs += performance.now() - hold.start;
    hold.sample.acquisitions++;
    holds.delete(client);
  }
});
const admin = new pg.Pool({ connectionString: process.env.SDI_POSTGRES_ADMIN_URL, max: 1 });
const definitions = [
  { name: 'native-plain', table: 'native_plain', kind: 'native', observed: false },
  { name: 'drizzle-plain', table: 'drizzle_plain', kind: 'drizzle', observed: false },
  { name: 'native-observed', table: 'native_observed', kind: 'native', observed: true },
  { name: 'drizzle-observed', table: 'drizzle_observed', kind: 'drizzle', observed: true },
];
if (withPrisma)
  definitions.push(
    { name: 'prisma-plain', table: 'prisma_plain', kind: 'prisma', observed: false },
    { name: 'prisma-observed', table: 'prisma_observed', kind: 'prisma', observed: true },
  );
let generatedDirectory;
let PrismaClient;
let PrismaPg;
let prismaAdapter;
let created = false;
const results = [];
const sqlShapes = {};
function serializationFailure(error) {
  // Drizzle preserves SQLSTATE in its cause; Prisma maps it to P2034.
  for (let cause = error, depth = 0; cause && depth < 8; cause = cause.cause, depth++) {
    if (cause.code === '40001' || cause.code === 'P2034') return true;
  }
  return false;
}
const percentile = (values, fraction) =>
  Number([...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1].toFixed(3));
const summarize = records => ({
  p50Ms: percentile(
    records.map(r => r.durationMs),
    0.5,
  ),
  p95Ms: percentile(
    records.map(r => r.durationMs),
    0.95,
  ),
  connectionHoldP50Ms: percentile(
    records.map(r => r.connectionHoldMs),
    0.5,
  ),
  connectionHoldP95Ms: percentile(
    records.map(r => r.connectionHoldMs),
    0.95,
  ),
  sqlCallsMin: Math.min(...records.map(r => r.sqlCalls)),
  sqlCallsMax: Math.max(...records.map(r => r.sqlCalls)),
  acquisitionsMin: Math.min(...records.map(r => r.acquisitions)),
  acquisitionsMax: Math.max(...records.map(r => r.acquisitions)),
  maxImpactBytes: Math.max(...records.map(r => r.impactBytes)),
  maxResponseBytes: Math.max(...records.map(r => r.responseBytes)),
  selectorKinds: [...new Set(records.flatMap(r => r.selectorKinds))].sort(),
  businessSelects: records.reduce((total, record) => total + record.businessSelects, 0),
});
async function measure(definition) {
  const record = { sqlCalls: 0, businessSelects: 0, connectionHoldMs: 0, acquisitions: 0 };
  return scope.run(record, async () => {
    const start = performance.now();
    const response = await definition.run();
    record.durationMs = performance.now() - start;
    const count = definition.observed ? response.data : response;
    assert.equal(count, definition.rowCount);
    record.impactBytes = definition.observed ? Buffer.byteLength(JSON.stringify(response.impact)) : 0;
    record.responseBytes = Buffer.byteLength(JSON.stringify(response));
    record.selectorKinds = definition.observed ? response.impact.targets.map(target => target.selector.kind) : [];
    if (definition.observed) assert(response.impact.targets.length > 0, 'MISSING_OBSERVED_IMPACT');
    assert.equal(record.acquisitions, 1, 'COMMAND_DID_NOT_HOLD_EXACTLY_ONE_CONNECTION');
    assert.equal(record.businessSelects, 0, 'INVERSE_BUSINESS_SELECT_DETECTED');
    return record;
  });
}
try {
  if (withPrisma) {
    ({ PrismaPg } = await import('@prisma/adapter-pg'));
    ({ prismaAdapter } = await import('@server-driven-impact/postgres/prisma'));
    mkdirSync(resolve('.local'), { recursive: true });
    generatedDirectory = mkdtempSync(resolve('.local/prisma-benchmark-'));
    writeFileSync(
      resolve(generatedDirectory, 'schema.prisma'),
      `generator client {
  provider = "prisma-client-js"
  output = "./generated"
}
datasource db {
  provider = "postgresql"
}
model PlainRow {
  id Int @id
  value Int
  @@map("prisma_plain")
}
model ObservedRow {
  id Int @id
  value Int
  @@map("prisma_observed")
}
`,
    );
    execFileSync(
      process.execPath,
      ['node_modules/prisma/build/index.js', 'generate', '--schema', resolve(generatedDirectory, 'schema.prisma')],
      { stdio: 'pipe' },
    );
    ({ PrismaClient } = await import(pathToFileURL(resolve(generatedDirectory, 'generated/index.js')).href));
  }
  await admin.query(`CREATE SCHEMA "${schema}"; GRANT USAGE ON SCHEMA "${schema}" TO routine_runtime`);
  created = true;
  for (const definition of definitions) {
    await admin.query(
      `CREATE TABLE "${schema}".${definition.table}(id integer PRIMARY KEY,value integer NOT NULL); GRANT SELECT,INSERT,UPDATE,DELETE ON "${schema}".${definition.table} TO routine_runtime`,
    );
    const table = pgSchema(schema).table(definition.table, {
      id: integer('id').primaryKey(),
      value: integer('value').notNull(),
    });
    const change = db => db.update(table).set({ value: sql`${table.value} + ${1}` });
    const nativeStatement = change(drizzle(pool)).toSQL();
    if (definition.kind !== 'prisma') sqlShapes[definition.name] = nativeStatement.sql.replaceAll(schema, '<schema>');
    if (definition.observed) {
      const resources = {
        rows: { schema, table: definition.table, idColumn: 'id', scopeColumn: null, columns: ['id', 'value'] },
      };
      const queries = {
        detail: { input: { parse: value => value }, plan: q.select('rows', { where: [q.eq('id', q.input('id'))] }) },
      };
      await admin.query(
        generateObserverMigration(resources, compileManifest(queries, resources), { runtimeRole: 'routine_runtime' }),
      );
      const adapter =
        definition.kind === 'native'
          ? pgAdapter({ database: pool })
          : definition.kind === 'drizzle'
            ? drizzleAdapter({ database: pool })
            : prismaAdapter({ database: pool, schema, createClient: adapter => new PrismaClient({ adapter }) });
      const engine = createImpact({ adapter, resources, queries });
      await engine.validate();
      definition.run = () =>
        engine.command({ scope: 'benchmark' }, async db => {
          if (definition.kind === 'prisma')
            return (await db.observedRow.updateMany({ data: { value: { increment: 1 } } })).count;
          const result =
            definition.kind === 'native'
              ? await db.query(nativeStatement.sql, nativeStatement.params)
              : await change(db);
          return result.rowCount;
        });
    } else if (definition.kind === 'prisma') {
      definition.run = async () => {
        const client = new PrismaClient({ adapter: new PrismaPg(pool, { schema }) });
        try {
          return await client.$transaction(
            async tx => (await tx.plainRow.updateMany({ data: { value: { increment: 1 } } })).count,
            { isolationLevel: 'RepeatableRead' },
          );
        } finally {
          await client.$disconnect();
        }
      };
    } else {
      definition.run = async () => {
        const client = await pool.connect();
        try {
          await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
          const result =
            definition.kind === 'native'
              ? await client.query(nativeStatement.sql, nativeStatement.params)
              : await change(drizzle(client));
          await client.query('COMMIT');
          return result.rowCount;
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }
      };
    }
  }
  for (const rows of [1, 1000, 10000]) {
    for (const definition of definitions) {
      definition.rowCount = rows;
      await admin.query(
        `TRUNCATE "${schema}".${definition.table}; INSERT INTO "${schema}".${definition.table} SELECT n,0 FROM generate_series(1,${rows}) n`,
      );
      await measure(definition);
      await measure(definition);
    }
    const measurements = new Map(definitions.map(definition => [definition.name, []]));
    // Rotate the first mode to reduce fixed-order temperature/cache bias.
    for (let sample = 0; sample < samples; sample++) {
      for (let offset = 0; offset < definitions.length; offset++) {
        const definition = definitions[(sample + offset) % definitions.length];
        measurements.get(definition.name).push(await measure(definition));
      }
    }
    for (const definition of definitions) {
      const records = measurements.get(definition.name);
      results.push({ mode: definition.name, rows, concurrency: 1, samples, ...summarize(records) });
      const verified = await admin.query(
        `SELECT count(*)::int AS count,min(value)::int AS min,max(value)::int AS max FROM "${schema}".${definition.table}`,
      );
      assert.deepEqual(verified.rows[0], { count: rows, min: samples + 2, max: samples + 2 });
    }
  }
  // Four simultaneous commands update the same single row. All modes retry 40001
  // because the common REPEATABLE READ level may reject conflicting transactions.
  const batches = samples;
  for (const definition of definitions) {
    definition.rowCount = 1;
    await admin.query(
      `TRUNCATE "${schema}".${definition.table}; INSERT INTO "${schema}".${definition.table} VALUES(1,0)`,
    );
    await measure(definition);
    const records = [];
    const requestDurations = [];
    let retries = 0;
    const start = performance.now();
    for (let batch = 0; batch < batches; batch++) {
      await Promise.all(
        Array.from({ length: 4 }, async () => {
          const requestStart = performance.now();
          for (let attempt = 0; attempt < 20; attempt++) {
            try {
              records.push(await measure(definition));
              requestDurations.push(performance.now() - requestStart);
              return;
            } catch (error) {
              if (!serializationFailure(error)) throw error;
              retries++;
            }
          }
          throw new Error('CONCURRENT_RETRY_LIMIT');
        }),
      );
    }
    const elapsedMs = performance.now() - start;
    results.push({
      mode: definition.name,
      rows: 1,
      concurrency: 4,
      samples: records.length,
      retries,
      elapsedMs: Number(elapsedMs.toFixed(3)),
      commandsPerSecond: Number(((records.length * 1000) / elapsedMs).toFixed(1)),
      requestP50Ms: percentile(requestDurations, 0.5),
      requestP95Ms: percentile(requestDurations, 0.95),
      ...summarize(records),
    });
    const verified = await admin.query(`SELECT value FROM "${schema}".${definition.table}`);
    assert.equal(verified.rows[0].value, records.length + 1);
  }
  const report = {
    executedAt: new Date().toISOString(),
    node: process.version,
    server: (await admin.query('SELECT version() AS version')).rows[0].version,
    versions: { pg: '8.16.3', drizzle: '0.45.2', ...(withPrisma ? { prisma: '7.10.0', adapterPg: '7.10.0' } : {}) },
    isolation: 'repeatable read',
    poolSize: 4,
    samples,
    notes: [
      'Plain fixtures have no observer triggers. All observed modes use identical resource/Query definitions and the built-in observer.',
      'All mutations increment value by one for every fixture row, return affected row count, and commit before completion.',
      'Native SQL is the exact SQL and parameters compiled from the same Drizzle update builder, apart from fixture table names.',
      'Prisma updateMany uses its own generated SQL with equivalent semantics; its Client is created/disconnected per command in both plain and observed modes.',
      'sqlShapes records the native/Drizzle SQL templates only; Prisma-generated SQL text is not captured.',
      'SQL calls count pg.Client.query invocations, including BEGIN/COMMIT and collector control queries; this is a protocol roundtrip proxy, not packet-level network measurement.',
      'Connection hold time is measured from pool acquire to release; total duration additionally includes connection wait, ORM initialization and ImpactSet calculation.',
      'Impact/response byte serialization and out-of-band correctness SELECTs happen after the timed operation.',
      'Concurrency uses four writers contending on the same row, with bounded retry on serialization failure; throughput and requestP50/P95 include failed attempts. Other latency, hold, and SQL-call percentiles describe successful attempts only.',
      'No validation or artifact generation is included in timed operations. Two warmups precede each serial scenario; one warmup precedes concurrency.',
    ],
    sqlShapes,
    results,
  };
  mkdirSync(resolve(output, '..'), { recursive: true });
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  await pool.end();
  if (created) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
  await admin.end();
  if (generatedDirectory) rmSync(generatedDirectory, { recursive: true, force: true });
}
