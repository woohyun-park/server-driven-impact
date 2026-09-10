import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const destination = await mkdtemp(resolve(tmpdir(), 'sdi-consumer-'));
const artifactDirectory = resolve(root, '.local/artifacts/sdi');
await mkdir(artifactDirectory, { recursive: true });
const localEnvironment = resolve(root, '.local/runtime/postgres.env');
const verifyPostgres = process.env.SDI_PACK_POSTGRES === '1';
const useExistingArtifacts = process.env.SDI_PACK_USE_EXISTING === '1';
if (verifyPostgres && existsSync(localEnvironment)) process.loadEnvFile(localEnvironment);

function run(command, args, cwd = destination, env = process.env) {
  return execFileSync(command, args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

const packageDirectories = ['sdi-core', 'sdi-runtime', 'sdi-postgres', 'sdi-sqlite'];
const archives = {};
if (!useExistingArtifacts) {
  await rm(artifactDirectory, { recursive: true, force: true });
  await mkdir(artifactDirectory, { recursive: true });
}
for (const directory of packageDirectories) {
  const packageManifest = JSON.parse(await readFile(resolve(root, 'packages', directory, 'package.json'), 'utf8'));
  const filename = `${packageManifest.name.slice(1).replace('/', '-')}-${packageManifest.version}.tgz`;
  if (useExistingArtifacts) {
    await access(resolve(artifactDirectory, filename));
    await copyFile(resolve(artifactDirectory, filename), resolve(destination, filename));
  } else {
    const packed = JSON.parse(run('pnpm', ['pack', '--json', '--pack-destination', destination], resolve(root, 'packages', directory), { ...process.env, NPM_CONFIG_IGNORE_SCRIPTS: 'true' }));
    const result = Array.isArray(packed) ? packed[0] : packed;
    const paths = new Set(result.files.map(file => file.path));
    if (!paths.has('README.md') || !paths.has('README.ko.md')) throw new Error(`PACKAGE_READMES_REQUIRED:${directory}`);
    for (const file of result.files) {
      if (!/^(package.json|README(?:\.ko)?\.md|CHANGELOG.md|LICENSE|dist\/.*\.(js|d.ts))$/.test(file.path)) {
        throw new Error(`UNEXPECTED_PACK_FILE:${directory}:${file.path}`);
      }
    }
    if (basename(result.filename) !== filename) throw new Error(`UNEXPECTED_ARCHIVE_NAME:${directory}:${result.filename}`);
    await copyFile(resolve(destination, filename), resolve(artifactDirectory, filename));
  }
  archives[directory] = filename;
}

await writeFile(resolve(destination, 'package.json'), JSON.stringify({
  private: true,
  type: 'module',
  packageManager: 'pnpm@10.33.0',
  dependencies: {
    '@server-driven-impact/core': `file:./${archives['sdi-core']}`,
    '@server-driven-impact/runtime': `file:./${archives['sdi-runtime']}`,
    '@server-driven-impact/postgres': `file:./${archives['sdi-postgres']}`,
    '@server-driven-impact/sqlite': `file:./${archives['sdi-sqlite']}`,
    pg: '8.16.3',
    'pg-copy-streams': '7.0.0',
    postgres: '3.4.8'
  },
  pnpm: {
    overrides: {
      '@server-driven-impact/core': `file:./${archives['sdi-core']}`,
      '@server-driven-impact/runtime': `file:./${archives['sdi-runtime']}`,
      '@server-driven-impact/postgres': `file:./${archives['sdi-postgres']}`,
      '@server-driven-impact/sqlite': `file:./${archives['sdi-sqlite']}`
    }
  },
  devDependencies: { '@types/node': '25.9.1', '@types/pg': '8.15.5', typescript: '6.0.3' }
}));
run('pnpm', ['install', '--prefer-offline', '--ignore-scripts', '--ignore-workspace']);

for (const name of ['domain.ts', 'demo.ts', 'postgres-demo.ts']) {
  await copyFile(resolve(root, 'examples/orders-impact', name), resolve(destination, name));
}
await writeFile(resolve(destination, 'consumer.ts'), `import {calculateImpact} from '@server-driven-impact/core';
import {createImpact,defineQueries} from '@server-driven-impact/runtime';
import {describeQueries} from '@server-driven-impact/runtime/debug';
import * as postgresAdapter from '@server-driven-impact/postgres';
import {pgAdapter,type PgCommandDb} from '@server-driven-impact/postgres/pg';
import {sqliteAdapter,type SqliteCommandDb} from '@server-driven-impact/sqlite';
import type {StatementResultingChanges,SQLInputValue,SQLOutputValue} from 'node:sqlite';
for (const value of [calculateImpact,createImpact,defineQueries,describeQueries,postgresAdapter.postgresAdapter,pgAdapter,sqliteAdapter]) {
  if (typeof value !== 'function') throw new Error('MISSING_PUBLIC_API');
}
function resultTypes(nodePg:PgCommandDb,postgresJs:postgresAdapter.PostgresCommandDb,sqlite:SqliteCommandDb) {
  void nodePg.execute(postgresAdapter.sql\`select 1\`).then(result=>{const count:number|null=result.rowCount;const rows:Record<string,unknown>[]=result.rows;void count;void rows;});
  void postgresJs.execute(postgresAdapter.sql\`select 1\`).then(result=>{const count:number=result.count;const rows:Record<string,unknown>[]=result;void count;void rows;});
  void nodePg.query<{id:number}>('select $1::int as id',[1]).then(result=>{const id:number=result.rows[0].id;const count:number|null=result.rowCount;void id;void count;});
  void nodePg.query<{id:number}>({text:'select $1::int as id',values:[1],name:'typed-query'}).then(result=>{const id:number=result.rows[0].id;void id;});
  void nodePg.query<[number]>({text:'select $1::int',values:[1],rowMode:'array'}).then(result=>{const id:number=result.rows[0][0];void id;});
  void nodePg.savepoint(async tx=>{const result=await tx.query<{id:number}>('select 1 as id');return result.rows[0].id;});
  void postgresJs\`select \${1} as id\`.then(result=>{const count:number=result.count;const rows:Record<string,unknown>[]=result;void count;void rows;});
  void postgresJs.unsafe('select $1::int',[1]).execute().then(result=>{const count:number=result.count;void count;});
  void postgresJs.savepoint(async tx=>{const result=await tx\`select \${1} as id\`;return result.count;});
  const statement=sqlite.prepare('select ? as id');
  const values:SQLInputValue[]=[1];
  const rows:Record<string,SQLOutputValue>[]=statement.all(...values);
  const row:Record<string,SQLOutputValue>|undefined=statement.get(...values);
  const changed:StatementResultingChanges=sqlite.prepare('update todos set value=?').run('next');
  const changedCount:number|bigint=changed.changes;const id:number|bigint=changed.lastInsertRowid;
  void rows;void row;void changedCount;void id;
  void sqlite.savepoint(async tx=>tx.prepare('select 1 as id').get());
}
void resultTypes;
for (const path of ['@server-driven-impact/runtime/query','@server-driven-impact/postgres/dist/postgres/index.js','@server-driven-impact/core/contracts']) {
  try { await import(path); throw new Error('INTERNAL_SUBPATH_EXPOSED:'+path); }
  catch (error) { if ((error as {code?:string}).code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw error; }
}
console.log('public-api-ok');
`);
await writeFile(resolve(destination, 'tsconfig.json'), JSON.stringify({
  compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, types: ['node'], outDir: 'out' },
  include: ['*.ts']
}));
run('pnpm', ['exec', 'tsc', '-p', 'tsconfig.json']);
console.log(run('node', ['out/consumer.js']).trim());
console.log(run('node', ['out/demo.js']).trim());

if (verifyPostgres) {
  if (!process.env.SDI_POSTGRES_ADMIN_URL || !process.env.SDI_POSTGRES_RUNTIME_URL) throw new Error('PACK_POSTGRES_ENV_REQUIRED');
  for (const driver of ['postgres', 'pg']) {
    console.log(run('node', ['out/postgres-demo.js'], destination, { ...process.env, SDI_POSTGRES_DRIVER: driver }).trim());
  }
}

const manifests = {};
let releaseVersion;
for (const directory of packageDirectories) {
  const manifest = JSON.parse(await readFile(resolve(destination, 'node_modules/@server-driven-impact', directory.slice(4), 'package.json'), 'utf8'));
  manifests[manifest.name] = { version: manifest.version, dependencies: manifest.dependencies ?? {}, peerDependencies: manifest.peerDependencies ?? {}, peerDependenciesMeta: manifest.peerDependenciesMeta ?? {} };
  releaseVersion ??= manifest.version;
  if (manifest.version !== releaseVersion) throw new Error(`SDI_VERSION_MISMATCH:${manifest.name}:${manifest.version}:${releaseVersion}`);
}
if (Object.keys(manifests['@server-driven-impact/core'].dependencies).length) throw new Error('CORE_HAS_RUNTIME_DEPENDENCIES');
if (Object.keys(manifests['@server-driven-impact/runtime'].dependencies).join(',') !== '@server-driven-impact/core') throw new Error('RUNTIME_DEPENDENCY_LEAK');
if ('@pgsql/parser' in manifests['@server-driven-impact/sqlite'].dependencies) throw new Error('SQLITE_POSTGRES_DEPENDENCY_LEAK');
for (const adapter of ['@server-driven-impact/postgres', '@server-driven-impact/sqlite']) {
  if (!manifests[adapter].peerDependencies['@server-driven-impact/core'] || !manifests[adapter].peerDependencies['@server-driven-impact/runtime']) {
    throw new Error(`ADAPTER_RUNTIME_PEERS_REQUIRED:${adapter}`);
  }
}

const optionalOrmPeers = ['drizzle-orm', '@prisma/adapter-pg', '@prisma/driver-adapter-utils'];
for (const peer of optionalOrmPeers) {
  const postgresManifest = manifests['@server-driven-impact/postgres'];
  if (!postgresManifest.peerDependencies[peer] || postgresManifest.peerDependenciesMeta[peer]?.optional !== true || peer in postgresManifest.dependencies) {
    throw new Error(`ORM_PEER_MUST_BE_OPTIONAL:${peer}`);
  }
  for (const packageName of ['@server-driven-impact/core', '@server-driven-impact/runtime', '@server-driven-impact/sqlite']) {
    if (peer in manifests[packageName].dependencies || peer in manifests[packageName].peerDependencies) throw new Error(`ORM_DEPENDENCY_LEAK:${packageName}:${peer}`);
  }
}
async function assertNotInstalled(directory, packages) {
  for (const packageName of packages) {
    try { await access(resolve(directory, 'node_modules', packageName)); }
    catch (error) { if (error?.code === 'ENOENT') continue; throw error; }
    throw new Error(`UNEXPECTED_OPTIONAL_DEPENDENCY:${basename(directory)}:${packageName}`);
  }
}

async function isolatedConsumer(name, dependencies, sourceFiles, execute, compilerOptions = {}) {
  const directory = await mkdtemp(resolve(tmpdir(), `sdi-${name}-`));
  const local = Object.fromEntries(Object.entries(dependencies).map(([packageName, version]) => [
    packageName,
    version.endsWith('.tgz') ? `file:${resolve(destination, version)}` : version,
  ]));
  const overrides = Object.fromEntries(Object.entries(local).filter(([, version]) => version.startsWith('file:')));
  await writeFile(resolve(directory, 'package.json'), JSON.stringify({
    private: true,
    type: 'module',
    packageManager: 'pnpm@10.33.0',
    dependencies: local,
    pnpm: { overrides },
    devDependencies: { '@types/node': '25.9.1', typescript: '6.0.3' }
  }));
  for (const [name, contents] of Object.entries(sourceFiles)) await writeFile(resolve(directory, name), contents);
  await writeFile(resolve(directory, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, types: ['node'], outDir: 'out', ...compilerOptions }, include: ['*.ts'] }));
  run('pnpm', ['install', '--prefer-offline', '--ignore-scripts', '--ignore-workspace'], directory);
  run('pnpm', ['exec', 'tsc', '-p', 'tsconfig.json'], directory);
  if (execute) console.log(run('node', [`out/${execute}`], directory).trim());
  await assertNotInstalled(directory, optionalOrmPeers.filter(peer => !(peer in dependencies)));
  return directory;
}

await isolatedConsumer('core-only', { '@server-driven-impact/core': archives['sdi-core'] }, {
  'core.ts': `import {calculateImpact} from '@server-driven-impact/core'; if(typeof calculateImpact!=='function')throw new Error('CORE_IMPORT_FAILED'); console.log('core-only-ok');`
}, 'core.js');
await isolatedConsumer('runtime-only', {
  '@server-driven-impact/core': archives['sdi-core'], '@server-driven-impact/runtime': archives['sdi-runtime']
}, {
  'runtime.ts': `import {createImpact,defineQueries} from '@server-driven-impact/runtime'; import {describeQueries} from '@server-driven-impact/runtime/debug'; for(const value of [createImpact,defineQueries,describeQueries])if(typeof value!=='function')throw new Error('RUNTIME_IMPORT_FAILED'); console.log('runtime-only-ok');`
}, 'runtime.js');
const sqliteOnly = await isolatedConsumer('sqlite-only', {
  '@server-driven-impact/core': archives['sdi-core'], '@server-driven-impact/runtime': archives['sdi-runtime'], '@server-driven-impact/sqlite': archives['sdi-sqlite']
}, {
  'domain.ts': await readFile(resolve(root, 'examples/orders-impact/domain.ts'), 'utf8'),
  'demo.ts': await readFile(resolve(root, 'examples/orders-impact/demo.ts'), 'utf8'),
  'native.ts': `import type {SqliteCommandDb} from '@server-driven-impact/sqlite'; import type {StatementResultingChanges,SQLOutputValue} from 'node:sqlite'; function types(db:SqliteCommandDb){const statement=db.prepare('select ? as id');const rows:Record<string,SQLOutputValue>[]=statement.all(1);const row:Record<string,SQLOutputValue>|undefined=statement.get(1);const result:StatementResultingChanges=statement.run(1);void rows;void row;void result;} void types;`
}, 'demo.js');
try { await access(resolve(sqliteOnly, 'node_modules/@pgsql/parser')); throw new Error('SQLITE_INSTALLED_POSTGRES_PARSER'); }
catch (error) { if (error?.code !== 'ENOENT') throw error; }

await isolatedConsumer('postgres-js-only', {
  '@server-driven-impact/core': archives['sdi-core'], '@server-driven-impact/runtime': archives['sdi-runtime'], '@server-driven-impact/postgres': archives['sdi-postgres'], postgres: '3.4.8'
}, {
  'driver.ts': `import postgres from 'postgres'; import {postgresAdapter,type PostgresCommandDb} from '@server-driven-impact/postgres'; function types(db:PostgresCommandDb){void db\`select \${1} as id\`.then(rows=>{const count:number=rows.count;void count;});void db.unsafe('select $1::int',[1]).execute();} void types; const database=postgres('postgresql://localhost/test',{max:1}); postgresAdapter({database}); await database.end(); console.log('postgres-js-only-ok');`
}, 'driver.js');
await isolatedConsumer('pg-only', {
  '@server-driven-impact/core': archives['sdi-core'], '@server-driven-impact/runtime': archives['sdi-runtime'], '@server-driven-impact/postgres': archives['sdi-postgres'], pg: '8.16.3', '@types/pg': '8.15.5'
}, {
  'driver.ts': `import {Pool} from 'pg'; import {pgAdapter,type PgCommandDb} from '@server-driven-impact/postgres/pg'; function types(db:PgCommandDb){void db.query<{id:number}>('select $1::int as id',[1]).then(result=>{const id:number=result.rows[0].id;void id;});void db.query<[number]>({text:'select $1::int',values:[1],rowMode:'array'}).then(result=>{const id:number=result.rows[0][0];void id;});} void types; const database=new Pool({connectionString:'postgresql://localhost/test'}); pgAdapter({database}); await database.end(); console.log('pg-only-ok');`
}, 'driver.js');

// Drizzle 0.45.2 declarations reference unrelated optional database drivers and
// contain upstream TS6 declaration errors. Keep consumer source strict, while
// skipping that dependency's declaration checking only in this ORM consumer.
await isolatedConsumer('drizzle-pg-only', {
  '@server-driven-impact/core': archives['sdi-core'], '@server-driven-impact/runtime': archives['sdi-runtime'], '@server-driven-impact/postgres': archives['sdi-postgres'],
  pg: '8.16.3', '@types/pg': '8.15.5', 'drizzle-orm': '0.45.2'
}, {
  'drizzle.ts': `import {Pool} from 'pg';
import {pgTable,text} from 'drizzle-orm/pg-core';
import {drizzleAdapter,type DrizzleCommandDb} from '@server-driven-impact/postgres/drizzle';
import type {ImpactAdapter} from '@server-driven-impact/runtime/adapter';
const todos=pgTable('todos',{id:text('id').primaryKey(),value:text('value').notNull()});
const database=new Pool({connectionString:'postgresql://localhost/test'});
const adapter:ImpactAdapter<DrizzleCommandDb<{todos:typeof todos}>>=drizzleAdapter({database,drizzle:{schema:{todos}}});
function types(db:DrizzleCommandDb<{todos:typeof todos}>) {
  const insert:PromiseLike<{id:string}[]>=db.insert(todos).values({id:'one',value:'value'}).returning({id:todos.id});
  void db.query.todos.findMany().then(rows=>{const id:string=rows[0].id;const value:string=rows[0].value;void id;void value;});
  const transaction:Promise<string>=db.transaction(async tx=>{const rows=await tx.select({id:todos.id}).from(todos);return rows[0].id;});
  const savepoint:Promise<{id:string}[]>=db.savepoint(async tx=>await tx.insert(todos).values({id:'two',value:'next'}).returning({id:todos.id}));
  // @ts-expect-error Model field types must remain specific across the adapter boundary.
  db.insert(todos).values({id:123,value:'invalid'});
  void insert;void transaction;void savepoint;
}
void adapter;void types;await database.end();console.log('drizzle-pg-only-ok');`
}, 'drizzle.js', {skipLibCheck:true});
await isolatedConsumer('prisma-pg-only', {
  '@server-driven-impact/core': archives['sdi-core'], '@server-driven-impact/runtime': archives['sdi-runtime'], '@server-driven-impact/postgres': archives['sdi-postgres'],
  pg: '8.16.3', '@types/pg': '8.15.5', '@prisma/adapter-pg': '7.10.0', '@prisma/driver-adapter-utils': '7.10.0'
}, {
  'prisma.ts': `import {Pool} from 'pg';
import type {SqlDriverAdapterFactory} from '@prisma/driver-adapter-utils';
import {prismaAdapter,type PrismaOptions} from '@server-driven-impact/postgres/prisma';
import type {ImpactAdapter} from '@server-driven-impact/runtime/adapter';
// Generated clients are application-owned. This structural client checks the public
// factory contract without installing a generator or generating application models.
interface Client { $disconnect():Promise<void>; todos:{findUnique(args:{where:{id:string}}):Promise<{id:string}>} }
const database=new Pool({connectionString:'postgresql://localhost/test'});
const options:PrismaOptions<Client>={database,createClient(factory){
  const driver:SqlDriverAdapterFactory=factory;void driver;
  return {$disconnect:async()=>{},todos:{findUnique:async args=>({id:args.where.id})}};
}};
const adapter:ImpactAdapter<Client>=prismaAdapter(options);
void adapter;await database.end();console.log('prisma-pg-only-ok');`
}, 'prisma.js');

const integrity = Object.fromEntries(await Promise.all(Object.entries(archives).map(async ([directory, filename]) => {
  const contents = await readFile(resolve(artifactDirectory, filename));
  return [directory, `sha512-${createHash('sha512').update(contents).digest('base64')}`];
})));
const releaseManifest = { version: releaseVersion, archives, integrity, manifests };
await writeFile(resolve(artifactDirectory, 'release-manifest.json'), JSON.stringify(releaseManifest, null, 2) + '\n');
const report = { destination, artifactDirectory, ...releaseManifest };
await mkdir(resolve(root, '.local/runtime'), { recursive: true });
await writeFile(resolve(root, '.local/runtime/sdi-pack.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
