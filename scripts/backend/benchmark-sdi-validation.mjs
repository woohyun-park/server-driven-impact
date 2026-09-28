import postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createImpact } from '@server-driven-impact/runtime';
import { migratePostgresQueries, postgresAdapter, Sql } from '@server-driven-impact/postgres';

// Measures the cost a fresh isolate pays on its first Command, compared with a warm Command.
for (const name of ['SDI_POSTGRES_ADMIN_URL', 'SDI_POSTGRES_RUNTIME_URL'])
  if (!process.env[name] || !['127.0.0.1', 'localhost', '::1'].includes(new URL(process.env[name]).hostname))
    throw new Error('ISOLATED_LOCAL_BENCHMARK_REQUIRED');
const samples = Number(process.env.SDI_BENCHMARK_SAMPLES ?? 30);
if (!Number.isInteger(samples) || samples < 5 || samples > 1_000) throw new Error('INVALID_BENCHMARK_SAMPLES');
const tableCount = Number(process.env.SDI_BENCHMARK_TABLES ?? 10);
if (!Number.isInteger(tableCount) || tableCount < 1 || tableCount > 200) throw new Error('INVALID_BENCHMARK_TABLES');

const admin = postgres(process.env.SDI_POSTGRES_ADMIN_URL, { max: 1, prepare: false, onnotice: () => {} });
const schema = 'sdi_validation_bench_' + randomUUID().replaceAll('-', '');
const statementLog = [];
const database = postgres(process.env.SDI_POSTGRES_RUNTIME_URL, {
  max: 1,
  prepare: false,
  onnotice: () => {},
  debug: (_connection, text) => statementLog.push({ at: performance.now(), text }),
});
const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return Number(sorted[Math.ceil(p * sorted.length) - 1].toFixed(3));
};
const summary = values => ({ p50Ms: percentile(values, 0.5), p95Ms: percentile(values, 0.95) });
const classify = text =>
  text.includes('with namespaces as')
    ? 'catalogFingerprint'
    : text.includes('from pg_trigger t')
      ? 'observerTriggers'
      : text.includes('from pg_policy') || text.includes('polqual')
        ? 'policy'
        : text.includes('from pg_class c join pg_namespace n') && text.includes('pk')
          ? 'resourceCatalog'
          : 'other';

try {
  const version = Math.floor(
    Number((await admin.unsafe("select current_setting('server_version_num')::int as n"))[0].n) / 10000,
  );
  const tables = Array.from({ length: tableCount }, (_, index) => `t${index}`);
  await admin.unsafe(
    `create schema "${schema}";grant usage on schema "${schema}" to routine_runtime;` +
      tables
        .map(
          table =>
            `create table "${schema}".${table}(id integer primary key,value integer not null);` +
            `insert into "${schema}".${table} values(1,0);` +
            `grant select,insert,update,delete on "${schema}".${table} to routine_runtime;`,
        )
        .join(''),
  );
  const resources = Object.fromEntries(
    tables.map(table => [table, { schema, table, idColumn: 'id', scopeColumn: null, columns: ['id', 'value'] }]),
  );
  const definitions = Object.fromEntries(
    tables.map(table => [
      table,
      {
        input: { parse: value => value },
        source: { text: `select id,value from "${schema}".${table} where id = $1`, parameters: ['id'] },
      },
    ]),
  );
  const artifact = await migratePostgresQueries(admin, resources, definitions, {
    version,
    searchPath: [schema, 'public'],
    runtimeRole: 'routine_runtime',
  });
  const engine = () =>
    createImpact({ adapter: postgresAdapter({ database }), resources: artifact.resources, queries: artifact.queries });
  const command = target =>
    target.command({ scope: 'bench' }, db => db.execute(new Sql(`update "${schema}".t0 set value=value+1`)));

  const firstCommandOnFreshEngine = async (beforeSample = async () => {}) => {
    const durations = [];
    for (let sample = -2; sample < samples; sample++) {
      await beforeSample();
      const target = engine();
      const start = performance.now();
      await command(target);
      if (sample >= 0) durations.push(performance.now() - start);
    }
    return summary(durations);
  };
  const warm = engine();
  await command(warm);
  const warmDurations = [];
  for (let sample = -2; sample < samples; sample++) {
    const start = performance.now();
    await command(warm);
    if (sample >= 0) warmDurations.push(performance.now() - start);
  }
  // The migration recorded a snapshot, so this is the stored path.
  const storedFirstCommand = await firstCommandOnFreshEngine();
  // Without a matching snapshot the adapter validates live inside the first command. That validation
  // records a snapshot, so remove it before every sample to keep measuring the live path.
  const liveFirstCommand = await firstCommandOnFreshEngine(() => admin.unsafe('delete from sdi_control.validation'));

  const validateDurations = [];
  const breakdown = {};
  for (let sample = -2; sample < samples; sample++) {
    await admin.unsafe('delete from sdi_control.validation');
    const target = engine();
    statementLog.length = 0;
    const start = performance.now();
    await target.validate();
    const end = performance.now();
    if (sample < 0) continue;
    validateDurations.push(end - start);
    // One connection, sequential statements: the gap to the next send approximates each statement's cost.
    statementLog.forEach((entry, index) => {
      const next = statementLog[index + 1]?.at ?? end;
      const kind = classify(entry.text);
      breakdown[kind] = [...(breakdown[kind] ?? []), next - entry.at];
    });
  }
  const perSample = Object.fromEntries(
    Object.entries(breakdown).map(([kind, values]) => [
      kind,
      {
        statements: values.length / samples,
        totalMs: Number((values.reduce((a, b) => a + b, 0) / samples).toFixed(3)),
      },
    ]),
  );

  const report = {
    executedAt: new Date().toISOString(),
    server: (await admin.unsafe('select version() as version'))[0].version,
    driver: 'postgres@3.4.8',
    samples,
    tables: tableCount,
    liveValidate: { ...summary(validateDurations), perSampleByKind: perSample },
    storedFirstCommand,
    liveFirstCommand,
    warmCommand: summary(warmDurations),
  };
  mkdirSync('.local/runtime/postgres-release', { recursive: true });
  writeFileSync('.local/runtime/postgres-release/validation-benchmark.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  await database.end();
  await admin.unsafe(`drop schema if exists "${schema}" cascade`);
  await admin.end();
}
