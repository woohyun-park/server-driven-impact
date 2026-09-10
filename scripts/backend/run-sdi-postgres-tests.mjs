import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const required = ['SDI_POSTGRES_ADMIN_URL', 'SDI_POSTGRES_RUNTIME_URL', 'SDI_POSTGRES_MAJOR'];
for (const name of required) {
  if (!process.env[name]) throw new Error(`Missing required PostgreSQL test setting: ${name}`);
}

for (const name of ['SDI_POSTGRES_ADMIN_URL', 'SDI_POSTGRES_RUNTIME_URL']) {
  const url = new URL(process.env[name]);
  if (!['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) {
    throw new Error(`${name} must point to an isolated loopback PostgreSQL instance`);
  }
}

const major = Number(process.env.SDI_POSTGRES_MAJOR);
if(!['postgres','pg'].includes(process.env.SDI_POSTGRES_DRIVER ?? 'postgres'))throw new Error('Unsupported PostgreSQL driver');
if (!Number.isInteger(major) || major < 14 || major > 18) {
  throw new Error(`Unsupported PostgreSQL test major: ${process.env.SDI_POSTGRES_MAJOR}`);
}

const reportDirectory=mkdtempSync(join(tmpdir(),'sdi-conformance-'));
const report=process.env.SDI_POSTGRES_REPORT ?? join(reportDirectory,'report.json');
const child = spawn(
  process.execPath,
  [
    'node_modules/vitest/vitest.mjs',
    'run',
    '--config', 'sdi.vitest.config.ts',
    'tests/server-driven-impact/postgres.integration.test.ts',
    'tests/server-driven-impact/postgres-release.integration.test.ts',
    '--reporter=default', '--reporter=json', `--outputFile.json=${report}`,
  ],
  {
    cwd: new URL('../..', import.meta.url),
    env: { ...process.env, SDI_POSTGRES_REQUIRED: '1' },
    stdio: 'inherit',
  },
);

child.on('error', error => { throw error; });
child.on('exit', (code, signal) => {
  try {
    if (signal) process.kill(process.pid, signal);
    else {
      const result=JSON.parse(readFileSync(report,'utf8'));
      if(result.numPendingTests || result.numPendingTestSuites || !result.numPassedTests) {
        console.error('Required PostgreSQL conformance cannot skip fixtures.');
        process.exitCode=1;
      } else process.exitCode=code ?? 1;
    }
  } catch(error) { console.error(error);process.exitCode=1; }
  finally { rmSync(reportDirectory,{recursive:true,force:true}); }
});
