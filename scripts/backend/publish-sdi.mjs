import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const expectedVersion = JSON.parse(await readFile(resolve(root, 'packages/sdi-core/package.json'), 'utf8')).version;
const artifactDirectory = resolve(root, '.local/artifacts/sdi', expectedVersion);
const release = JSON.parse(await readFile(resolve(artifactDirectory, 'release-manifest.json'), 'utf8'));
const channel = process.argv.slice(2).find(value => ['dry-run', 'next', 'latest'].includes(value));
if (!['dry-run', 'next', 'latest'].includes(channel)) throw new Error('Usage: node scripts/backend/publish-sdi.mjs <dry-run|next|latest>');
if (release.version !== expectedVersion) throw new Error('RELEASE_VERSION_MISMATCH');
if (channel === 'latest' && release.version.includes('-')) throw new Error('PRERELEASE_REQUIRES_NEXT_TAG');

const packages = [
  ['sdi-core', '@server-driven-impact/core'],
  ['sdi-cache-contract', '@server-driven-impact/cache-contract'],
  ['sdi-runtime', '@server-driven-impact/runtime'],
  ['sdi-postgres', '@server-driven-impact/postgres'],
  ['sdi-sqlite', '@server-driven-impact/sqlite'],
  ['sdi-tanstack-query', '@server-driven-impact/tanstack-query'],
];

function npm(args, options = {}) {
  return execFileSync('npm', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options }).trim();
}

function publishedIntegrity(specifier) {
  const result = spawnSync('npm', ['view', specifier, 'dist.integrity', '--json'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status === 0) return JSON.parse(result.stdout);
  if (/E404|404 Not Found/.test(result.stderr)) return null;
  throw new Error(result.stderr.trim() || `npm view failed for ${specifier}`);
}

for (const [key, name] of packages) {
  const filename = release.archives[key];
  if (!filename) throw new Error(`MISSING_RELEASE_ARCHIVE:${key}`);
  const path = resolve(artifactDirectory, filename);
  const localIntegrity = `sha512-${createHash('sha512').update(await readFile(path)).digest('base64')}`;
  if (localIntegrity !== release.integrity[key]) throw new Error(`ARTIFACT_INTEGRITY_MISMATCH:${filename}`);

  const specifier = `${name}@${release.version}`;
  const registryIntegrity = publishedIntegrity(specifier);
  if (channel === 'dry-run') {
    if (registryIntegrity !== null && registryIntegrity !== localIntegrity) throw new Error(`PUBLISHED_ARTIFACT_DIFFERS:${specifier}`);
    console.log(`${specifier}: ${registryIntegrity === null ? 'ready to publish' : 'published artifact matches'}`);
    continue;
  }
  if (registryIntegrity === null) {
    const result = spawnSync('npm', ['publish', path, '--access', 'public', '--tag', channel], {
      cwd: root,
      env: process.env,
      encoding: 'utf8',
      stdio: 'inherit',
    });
    if (result.status !== 0) process.exit(result.status ?? 1);
    continue;
  }
  if (registryIntegrity !== localIntegrity) throw new Error(`PUBLISHED_ARTIFACT_DIFFERS:${specifier}`);

  const tags = JSON.parse(npm(['view', name, 'dist-tags', '--json']));
  if (tags[channel] === release.version) {
    console.log(`${specifier} already has the ${channel} tag.`);
  } else {
    console.log(`${specifier} is already published; adding the ${channel} tag.`);
    const result = spawnSync('npm', ['dist-tag', 'add', specifier, channel], { cwd: root, env: process.env, stdio: 'inherit' });
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}
