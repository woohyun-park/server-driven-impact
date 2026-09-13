import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

const targets = JSON.parse(readFileSync('spec/server-driven-impact/postgres-images.json', 'utf8')).images;
const directory = resolve('.local/runtime/postgres-release');
mkdirSync(directory, { recursive: true });
const results = [];
for (const { major, tag, digest } of targets) {
  const container = 'sdi-matrix-' + randomUUID().slice(0, 8);
  try {
    execFileSync('docker', [
      'run',
      '--detach',
      '--name',
      container,
      '--publish',
      '127.0.0.1::5432',
      '--env',
      'POSTGRES_PASSWORD=sdi',
      '--env',
      'POSTGRES_DB=sdi',
      `postgres:${tag}@${digest}`,
    ]);
    let ready = false;
    for (let attempt = 0; attempt < 600; attempt++) {
      if (
        spawnSync('docker', ['exec', container, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres', '-d', 'sdi'], {
          stdio: 'ignore',
        }).status === 0
      ) {
        ready = true;
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!ready) {
      spawnSync('docker', ['logs', container], { stdio: 'inherit' });
      throw new Error(`PostgreSQL ${major} did not become ready`);
    }
    const info = JSON.parse(execFileSync('docker', ['inspect', container], { encoding: 'utf8' }))[0];
    const port = info.NetworkSettings.Ports['5432/tcp'][0].HostPort;
    execFileSync('docker', [
      'exec',
      container,
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
    for (const driver of ['postgres', 'pg']) {
      const report = resolve(directory, `${major}-${driver}.json`);
      const started = Date.now();
      const child = spawnSync(process.execPath, ['scripts/backend/run-sdi-postgres-tests.mjs'], {
        env: {
          ...process.env,
          SDI_POSTGRES_ADMIN_URL: `postgresql://postgres:sdi@127.0.0.1:${port}/sdi`,
          SDI_POSTGRES_RUNTIME_URL: `postgresql://routine_runtime:runtime@127.0.0.1:${port}/sdi`,
          SDI_POSTGRES_MAJOR: String(major),
          SDI_POSTGRES_DRIVER: driver,
          SDI_POSTGRES_REPORT: report,
        },
        stdio: 'inherit',
      });
      if (child.status !== 0) throw new Error(`PostgreSQL ${major} / ${driver} failed`);
      const summary = JSON.parse(readFileSync(report, 'utf8'));
      results.push({
        major,
        tag,
        driver,
        image: info.Image,
        passed: summary.numPassedTests,
        skipped: summary.numPendingTests,
        elapsedMs: Date.now() - started,
      });
      writeFileSync(
        resolve(directory, 'matrix.json'),
        JSON.stringify({ executedAt: new Date().toISOString(), results }, null, 2) + '\n',
      );
    }
  } finally {
    execFileSync('docker', ['rm', '--force', '--volumes', container], { stdio: 'ignore' });
  }
}
console.log(JSON.stringify(results, null, 2));
