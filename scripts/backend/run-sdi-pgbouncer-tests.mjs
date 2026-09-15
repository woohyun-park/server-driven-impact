import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const postgresImage = 'postgres:16.15@sha256:f1c3376c26f2609ab9f29f71f824103fe2fcd8ee0346485cb6122a4f93df6f94';
const pgbouncerImage =
  'edoburu/pgbouncer:v1.24.1-p0@sha256:53d98b3174b0842c475b9842fb0a733b2d9f7ec9da834ec42252aa553f48c628';
const suffix = randomUUID().slice(0, 8);
const network = `sdi-pool-${suffix}`;
const postgresContainer = `sdi-pool-postgres-${suffix}`;
const pgbouncerContainer = `sdi-pool-pgbouncer-${suffix}`;
const runtimeDirectory = resolve('.local/runtime');
mkdirSync(runtimeDirectory, { recursive: true });
const directory = mkdtempSync(join(runtimeDirectory, 'sdi-pgbouncer-'));

function inspectPort(container, port) {
  const info = JSON.parse(execFileSync('docker', ['inspect', container], { encoding: 'utf8' }))[0];
  return info.NetworkSettings.Ports[`${port}/tcp`][0].HostPort;
}

async function waitFor(container, command) {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (spawnSync('docker', ['exec', container, ...command], { stdio: 'ignore' }).status === 0) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  spawnSync('docker', ['logs', container], { stdio: 'inherit' });
  throw new Error(`${container} did not become ready`);
}

try {
  writeFileSync(
    join(directory, 'pgbouncer.ini'),
    `[databases]\nsdi = host=${postgresContainer} port=5432 dbname=sdi\n\n[pgbouncer]\nlisten_addr = 0.0.0.0\nlisten_port = 5432\nauth_type = plain\nauth_file = /etc/pgbouncer/userlist.txt\npool_mode = transaction\ndefault_pool_size = 5\nmax_client_conn = 100\nignore_startup_parameters = extra_float_digits\n`,
  );
  writeFileSync(join(directory, 'userlist.txt'), '"postgres" "sdi"\n"routine_runtime" "runtime"\n');
  chmodSync(directory, 0o755);
  chmodSync(join(directory, 'pgbouncer.ini'), 0o644);
  chmodSync(join(directory, 'userlist.txt'), 0o644);
  execFileSync('docker', ['network', 'create', network], { stdio: 'ignore' });
  execFileSync('docker', [
    'run',
    '--detach',
    '--name',
    postgresContainer,
    '--network',
    network,
    '--publish',
    '127.0.0.1::5432',
    '--env',
    'POSTGRES_PASSWORD=sdi',
    '--env',
    'POSTGRES_DB=sdi',
    postgresImage,
  ]);
  await waitFor(postgresContainer, ['psql', '-U', 'postgres', '-d', 'sdi', '-Atqc', 'select 1']);
  execFileSync('docker', [
    'exec',
    postgresContainer,
    'psql',
    '-U',
    'postgres',
    '-d',
    'sdi',
    '-v',
    'ON_ERROR_STOP=1',
    '-c',
    "create role routine_runtime login password 'runtime' nobypassrls",
  ]);
  execFileSync('docker', [
    'run',
    '--detach',
    '--name',
    pgbouncerContainer,
    '--network',
    network,
    '--publish',
    '127.0.0.1::5432',
    '--volume',
    `${directory}:/etc/pgbouncer:ro`,
    '--entrypoint',
    'pgbouncer',
    pgbouncerImage,
    '/etc/pgbouncer/pgbouncer.ini',
  ]);
  await waitFor(pgbouncerContainer, [
    'env',
    'PGPASSWORD=sdi',
    'psql',
    '-h',
    '127.0.0.1',
    '-U',
    'postgres',
    '-d',
    'sdi',
    '-Atqc',
    'select 1',
  ]);
  const adminPort = inspectPort(postgresContainer, 5432);
  const transactionPort = inspectPort(pgbouncerContainer, 5432);
  for (const driver of ['postgres', 'pg']) {
    const result = spawnSync(
      process.execPath,
      [
        'node_modules/vitest/vitest.mjs',
        'run',
        '--config',
        'sdi.vitest.config.ts',
        'tests/server-driven-impact/postgres-transaction-pool.integration.test.ts',
      ],
      {
        env: {
          ...process.env,
          SDI_POSTGRES_ADMIN_URL: `postgresql://postgres:sdi@127.0.0.1:${adminPort}/sdi`,
          SDI_POSTGRES_TRANSACTION_URL: `postgresql://postgres:sdi@127.0.0.1:${transactionPort}/sdi`,
          SDI_POSTGRES_TRANSACTION_REQUIRED: '1',
          SDI_POSTGRES_DRIVER: driver,
        },
        stdio: 'inherit',
      },
    );
    if (result.status !== 0) throw new Error(`PgBouncer transaction pool / ${driver} failed`);
  }
  const orm = spawnSync(
    process.execPath,
    [
      'node_modules/vitest/vitest.mjs',
      'run',
      '--config',
      'sdi.vitest.config.ts',
      '--no-file-parallelism',
      'tests/server-driven-impact/native-orm.integration.test.ts',
      'tests/server-driven-impact/prisma.integration.test.ts',
    ],
    {
      env: {
        ...process.env,
        SDI_POSTGRES_ADMIN_URL: `postgresql://postgres:sdi@127.0.0.1:${adminPort}/sdi`,
        SDI_POSTGRES_RUNTIME_URL: `postgresql://routine_runtime:runtime@127.0.0.1:${transactionPort}/sdi`,
        SDI_POSTGRES_REQUIRED: '1',
        SDI_POSTGRES_DRIVER: 'pg',
      },
      stdio: 'inherit',
    },
  );
  if (orm.status !== 0) throw new Error('PgBouncer transaction pool / ORM adapters failed');
} finally {
  spawnSync('docker', ['rm', '--force', '--volumes', pgbouncerContainer], { stdio: 'ignore' });
  spawnSync('docker', ['rm', '--force', '--volumes', postgresContainer], { stdio: 'ignore' });
  spawnSync('docker', ['network', 'rm', network], { stdio: 'ignore' });
  rmSync(directory, { recursive: true, force: true });
}
