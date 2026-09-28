import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { compileManifest, createImpact, q } from '@server-driven-impact/runtime';
import {
  compilePostgresArtifacts,
  generateObserverMigration,
  installPostgresTransactionGate,
  migratePostgresArtifacts,
  migratePostgresQueries,
  observerFingerprint,
  postgresAdapter,
  refreshPostgresValidation,
  Sql,
  type PostgresCommandDb,
  type PostgresExecuteResult,
  type PostgresMajor,
  type PostgresSourceDefinition,
} from '@server-driven-impact/postgres';
import { pgAdapter, type PgExecuteResult } from '@server-driven-impact/postgres/pg';
import type { ImpactAdapter } from '@server-driven-impact/runtime/adapter';

const adminUrl = process.env.SDI_POSTGRES_ADMIN_URL;
const runtimeUrl = process.env.SDI_POSTGRES_RUNTIME_URL;
const enabled = !!adminUrl && !!runtimeUrl;
if (process.env.SDI_POSTGRES_REQUIRED === '1' && !enabled) throw new Error('POSTGRES_FIXTURES_REQUIRED');
if (enabled && !['127.0.0.1', 'localhost', '::1'].includes(new URL(adminUrl!).hostname))
  throw new Error('LOCAL_FIXTURES_ONLY');
const parse = { parse: (value: unknown) => value as Record<string, unknown> };

describe.skipIf(!enabled)('PostgreSQL stored validation', () => {
  const schema = 'sdi_stored_' + randomUUID().replaceAll('-', '');
  const admin = enabled ? postgres(adminUrl!, { max: 2, prepare: false, onnotice: () => {} }) : undefined!;
  const runtime = enabled ? postgres(runtimeUrl!, { max: 1, prepare: false, onnotice: () => {} }) : undefined!;
  const pgPool =
    enabled && process.env.SDI_POSTGRES_DRIVER === 'pg'
      ? new Pool({ connectionString: runtimeUrl, max: 1 })
      : undefined;
  type TestCommandDb = PostgresCommandDb<PostgresExecuteResult | PgExecuteResult>;
  const adapter = (): ImpactAdapter<TestCommandDb> =>
    (pgPool
      ? pgAdapter({ database: pgPool })
      : postgresAdapter({ database: runtime })) as unknown as ImpactAdapter<TestCommandDb>;
  const resources = {
    a: { schema, table: 'a', idColumn: 'id', scopeColumn: null, columns: ['id', 'value'] },
  } as const;
  let version: PostgresMajor;
  const options = () => ({ version, searchPath: [schema, 'public'], runtimeRole: 'routine_runtime' });
  const definition = (text: string): PostgresSourceDefinition => ({ input: parse, source: { text, parameters: [] } });
  const update = (engine: ReturnType<typeof createImpact<TestCommandDb, never>>) =>
    engine.command({ scope: 'a' }, db => db.execute(new Sql(`update "${schema}".a set value=value+1`)));

  beforeAll(async () => {
    version = Math.floor(
      Number((await admin.unsafe("select current_setting('server_version_num')::int as n"))[0].n) / 10000,
    ) as PostgresMajor;
    await admin.unsafe(`create schema "${schema}";
      create table "${schema}".a(id text primary key,value integer not null);
      insert into "${schema}".a values('one',1);
      create table "${schema}".hidden(id text primary key);
      create table "${schema}".c(id integer primary key,name text not null);
      grant usage on schema "${schema}" to routine_runtime;
      grant select,insert,update,delete on all tables in schema "${schema}" to routine_runtime;`);
    await admin.begin(transaction => installPostgresTransactionGate(transaction, 'routine_runtime'));
  });
  afterAll(async () => {
    await pgPool?.end();
    await runtime?.end();
    await admin?.unsafe(`drop schema if exists "${schema}" cascade`);
    await admin?.end();
  });

  const storedRow = async () =>
    (await admin.unsafe(`select fingerprint,validated_at,report from "sdi_control"."validation"`))[0] as unknown as
      | { fingerprint: string; validated_at: Date; report: unknown }
      | undefined;

  it('records a snapshot during migration that fresh engines use instead of live validation', async () => {
    const migrated = await migratePostgresQueries(
      admin,
      resources,
      { list: definition(`select * from "${schema}".a`) },
      options(),
    );
    expect(migrated.validation).toMatchObject({
      fingerprint: migrated.fingerprint,
      report: { endpoints: { list: { status: 'verified' } } },
      equalityResources: ['a'],
      recorded: true,
    });
    const recordedAt = (await storedRow())?.validated_at;
    const engine = createImpact({ adapter: adapter(), resources: migrated.resources, queries: migrated.queries });
    expect(await engine.validate()).toEqual({
      report: migrated.validation.report,
      source: 'stored',
      validatedAt: migrated.validation.validatedAt,
    });
    const fresh = createImpact({ adapter: adapter(), resources: migrated.resources, queries: migrated.queries });
    expect((await update(fresh as never)).impact.endpoints.list.status).toBe('verified');
    // A live validation would have recorded a new snapshot.
    expect((await storedRow())?.validated_at).toEqual(recordedAt);

    // Statistics maintenance rewrites no catalog rows, so the catalog gate still passes.
    await admin.unsafe(`vacuum analyze "${schema}".a`);
    const afterVacuum = createImpact({ adapter: adapter(), resources: migrated.resources, queries: migrated.queries });
    expect((await afterVacuum.validate()).source).toBe('stored');
  });

  it('records a live validation after static SQL and after DDL outside SDI, so later processes use it', async () => {
    const artifact = await compilePostgresArtifacts(
      admin,
      resources,
      { static: definition(`select id from "${schema}".a`) },
      options(),
    );
    await admin.begin(tx =>
      tx.unsafe(generateObserverMigration(artifact.resources, artifact.manifest, { runtimeRole: 'routine_runtime' })),
    );
    const engine = () => createImpact({ adapter: adapter(), resources: artifact.resources, queries: artifact.queries });
    expect(await engine().validate()).toMatchObject({
      source: 'live',
      report: { endpoints: { static: { status: 'verified' } } },
    });
    expect((await storedRow())?.fingerprint).toBe(observerFingerprint(artifact.resources, artifact.manifest));
    expect((await engine().validate()).source).toBe('stored');

    // DDL outside the helpers moves the catalog hash: the next process validates live and records the drift.
    await admin.unsafe(`alter table "${schema}".a enable row level security;
      create policy hidden_rows on "${schema}".a using(exists(select 1 from "${schema}".hidden));`);
    try {
      expect(await engine().validate()).toMatchObject({
        source: 'live',
        report: { endpoints: { static: { status: 'unavailable', codes: ['CATALOG_DRIFT'] } } },
      });
      expect(await engine().validate()).toMatchObject({
        source: 'stored',
        report: { endpoints: { static: { status: 'unavailable', codes: ['CATALOG_DRIFT'] } } },
      });
      const drifted = await update(engine() as never);
      expect(drifted.commitState).toBe('committed');
      expect(drifted.impact.endpoints.static.status).toBe('unavailable');
    } finally {
      await admin.unsafe(
        `drop policy hidden_rows on "${schema}".a;alter table "${schema}".a disable row level security;`,
      );
    }
    expect(await engine().validate()).toMatchObject({
      source: 'live',
      report: { endpoints: { static: { status: 'verified' } } },
    });

    // Disabling an observer trigger is DDL too.
    await admin.unsafe(`alter table "${schema}".a disable trigger sdi_observe_update`);
    try {
      expect(await engine().validate()).toMatchObject({
        source: 'live',
        report: { endpoints: { static: { status: 'unavailable', codes: ['OBSERVER_UNVERIFIED'] } } },
      });
    } finally {
      await admin.unsafe(`alter table "${schema}".a enable trigger sdi_observe_update`);
    }

    const refreshed = await refreshPostgresValidation(admin, artifact.resources, artifact.manifest);
    expect(refreshed).toMatchObject({ recorded: true, report: { endpoints: { static: { status: 'verified' } } } });
    expect(await engine().validate()).toMatchObject({ source: 'stored', validatedAt: refreshed.validatedAt });
  });

  it('accepts only the gated row or a newer snapshot after the first command, and never needs the recorder', async () => {
    const artifact = await compilePostgresArtifacts(
      admin,
      resources,
      { later: definition(`select value from "${schema}".a`) },
      options(),
    );
    await admin.begin(tx =>
      tx.unsafe(generateObserverMigration(artifact.resources, artifact.manifest, { runtimeRole: 'routine_runtime' })),
    );
    await refreshPostgresValidation(admin, artifact.resources, artifact.manifest);
    const engine = createImpact({ adapter: adapter(), resources: artifact.resources, queries: artifact.queries });
    expect((await update(engine as never)).impact.endpoints.later.status).toBe('verified');
    const conservative = `{"endpoints":{"later":{"status":"conservative","codes":["PRECISION_REDUCED"]}}}`;
    // An older row is not a newer proof; the adapter keeps what it decided.
    await admin.unsafe(
      `update "sdi_control"."validation" set report='${conservative}'::jsonb,validated_at='2000-01-01'`,
    );
    expect((await update(engine as never)).impact.endpoints.later.status).toBe('verified');
    // A snapshot recorded after the decision is a newer full validation and is used without the gate.
    await admin.unsafe(
      `update "sdi_control"."validation" set report='${conservative}'::jsonb,validated_at=clock_timestamp()`,
    );
    expect((await update(engine as never)).impact.endpoints.later).toMatchObject({ status: 'conservative' });

    // Without the recorder grant a live validation still serves the command; it just is not recorded.
    await admin.unsafe(`revoke execute on function "sdi_control".record_validation(text,text,text[],jsonb,jsonb) from routine_runtime;
      delete from "sdi_control"."validation"`);
    try {
      const unrecorded = createImpact({ adapter: adapter(), resources: artifact.resources, queries: artifact.queries });
      expect((await update(unrecorded as never)).impact.endpoints.later.status).toBe('verified');
      expect(await storedRow()).toBeUndefined();
    } finally {
      await admin.unsafe(
        `grant execute on function "sdi_control".record_validation(text,text,text[],jsonb,jsonb) to routine_runtime`,
      );
    }
    await expect(
      runtime.unsafe(
        `select "sdi_control".record_validation('${'0'.repeat(64)}','x',array['public'],'{"endpoints":{}}','[]')`,
      ),
    ).resolves.toEqual([{ record_validation: false }]);
  });

  it('commits migration DDL and records reduced precision instead of throwing', async () => {
    const tracked = { c: { schema, table: 'c', idColumn: 'id', scopeColumn: null, columns: ['id', 'name'] } } as const;
    const queries = {
      byName: { input: parse, plan: q.select('c', { where: [q.eq('name', q.input('name'))] }) },
    };
    const migrated = await migratePostgresArtifacts(admin, tracked, compileManifest(queries, tracked), {
      runtimeRole: 'routine_runtime',
      change: async tx => {
        await tx.unsafe(
          `create collation "${schema}".ci (provider = icu, locale = 'und-u-ks-level2', deterministic = false);
           alter table "${schema}".c alter column name type text collate "${schema}".ci`,
        );
      },
    });
    expect(migrated.validation.report.endpoints.byName).toEqual({
      status: 'conservative',
      codes: ['PRECISION_REDUCED'],
    });
    const [column] = await admin.unsafe(
      `select coll.collname from pg_attribute a join pg_collation coll on coll.oid=a.attcollation
       where a.attrelid='"${schema}".c'::regclass and a.attname='name'`,
    );
    expect(column.collname).toBe('ci');
  });

  it('keeps the snapshot owner-written and reports missing control relations as setup errors', async () => {
    await expect(runtime.unsafe(`update "sdi_control"."validation" set report='{}'::jsonb`)).rejects.toThrow(
      /permission denied/,
    );
    const migrated = await migratePostgresQueries(
      admin,
      resources,
      { list: definition(`select * from "${schema}".a`) },
      options(),
    );
    const engine = createImpact({ adapter: adapter(), resources: migrated.resources, queries: migrated.queries });
    await admin.unsafe(`revoke select on "sdi_control"."validation" from routine_runtime`);
    try {
      await expect(update(engine as never)).rejects.toThrow('POSTGRES_CONTROL_ACCESS_DENIED');
      await expect(engine.validate()).rejects.toThrow('POSTGRES_CONTROL_ACCESS_DENIED');
    } finally {
      await admin.unsafe(`grant select on "sdi_control"."validation" to routine_runtime`);
    }
    await admin.unsafe(`drop table "sdi_control"."validation"`);
    try {
      await expect(update(engine as never)).rejects.toThrow('POSTGRES_CONTROL_NOT_INITIALIZED');
      await expect(engine.validate()).rejects.toThrow('POSTGRES_CONTROL_NOT_INITIALIZED');
      expect((await admin.unsafe(`select value from "${schema}".a where id='one'`))[0].value).toBeGreaterThan(0);
    } finally {
      await admin.begin(transaction => installPostgresTransactionGate(transaction, 'routine_runtime'));
    }
  });
});
