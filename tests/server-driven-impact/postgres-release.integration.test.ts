import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { matchesInputSelector } from '@server-driven-impact/core';
import { createImpact, q } from '@server-driven-impact/runtime';
import {
  compilePostgresArtifacts,
  compilePostgresQuery,
  createPostgresCatalogResolver,
  generateObserverMigration,
  identifier,
  installPostgresTransactionGate,
  migratePostgresQueries,
  postgresAdapter,
  sql,
  Sql,
  type PostgresCommandDb,
  type PostgresExecuteResult,
  type PostgresMajor,
  type PostgresSourceDefinition,
} from '@server-driven-impact/postgres';
import { pgAdapter, pgDatabase, type PgExecuteResult } from '@server-driven-impact/postgres/pg';
import { bindAdapter, type ImpactAdapter } from '@server-driven-impact/runtime/adapter';

const adminUrl = process.env.SDI_POSTGRES_ADMIN_URL;
const runtimeUrl = process.env.SDI_POSTGRES_RUNTIME_URL;
const enabled = !!adminUrl && !!runtimeUrl;
if (process.env.SDI_POSTGRES_REQUIRED === '1' && !enabled) throw new Error('POSTGRES_FIXTURES_REQUIRED');
if (enabled && !['127.0.0.1', 'localhost', '::1'].includes(new URL(adminUrl!).hostname))
  throw new Error('LOCAL_FIXTURES_ONLY');
const parse = { parse: (value: unknown) => value as Record<string, unknown> };

describe.skipIf(!enabled)('PostgreSQL release contract', () => {
  const schema = 'sdi_release_' + randomUUID().replaceAll('-', '');
  const admin = enabled ? postgres(adminUrl!, { max: 2, prepare: false, onnotice: () => {} }) : undefined!;
  const pgPool =
    enabled && process.env.SDI_POSTGRES_DRIVER === 'pg'
      ? new Pool({ connectionString: runtimeUrl, max: 1 })
      : undefined;
  const database = enabled
    ? pgPool
      ? ({ ...pgDatabase(pgPool), end: () => pgPool.end() } as unknown as postgres.Sql)
      : postgres(runtimeUrl!, { max: 1, prepare: false, onnotice: () => {} })
    : undefined!;
  type TestCommandDb = PostgresCommandDb<PostgresExecuteResult | PgExecuteResult>;
  const adapter = (): ImpactAdapter<TestCommandDb> =>
    (pgPool
      ? pgAdapter({ database: pgPool })
      : postgresAdapter({ database })) as unknown as ImpactAdapter<TestCommandDb>;
  const driverRows = (result: PostgresExecuteResult | PgExecuteResult) =>
    pgPool ? (result as PgExecuteResult).rows : [...(result as PostgresExecuteResult)];
  const resources = {
    a: { schema, table: 'a', idColumn: 'id', scopeColumn: null, columns: ['id', 'value'] },
    b: { schema, table: 'b', idColumn: 'id', scopeColumn: null, columns: ['id', 'value'] },
  } as const;
  let version: PostgresMajor;
  const options = () => ({ version, searchPath: [schema, 'public'], runtimeRole: 'routine_runtime' });
  const definition = (text: string, parameters: string[] = [], cache?: 'no-store'): PostgresSourceDefinition => ({
    input: parse,
    source: { text, parameters, ...(cache ? { cache } : {}) },
  });
  async function install(definitions: Record<string, PostgresSourceDefinition>) {
    const artifact = await compilePostgresArtifacts(admin, resources, definitions, options());
    await admin.unsafe(
      generateObserverMigration(artifact.resources, artifact.manifest, { runtimeRole: 'routine_runtime' }),
    );
    return {
      artifact,
      engine: createImpact({ adapter: adapter(), resources: artifact.resources, queries: artifact.queries }),
    };
  }
  function recordingDatabase(statements: string[]): postgres.Sql {
    return new Proxy(database, {
      get(target, key) {
        if (key === 'reserve')
          return async () => {
            const session = await target.reserve();
            return new Proxy(session, {
              get(reserved, reservedKey) {
                const member = Reflect.get(reserved, reservedKey, reserved);
                if (reservedKey === 'unsafe')
                  return (text: string, ...args: unknown[]) => {
                    statements.push(text);
                    return member.call(reserved, text, ...args);
                  };
                return typeof member === 'function' ? member.bind(reserved) : member;
              },
            });
          };
        const member = Reflect.get(target, key, target);
        return typeof member === 'function' ? member.bind(target) : member;
      },
    }) as postgres.Sql;
  }
  beforeAll(async () => {
    version = Math.floor(
      Number((await admin.unsafe("select current_setting('server_version_num')::int as n"))[0].n) / 10000,
    ) as PostgresMajor;
    await admin.unsafe(`create schema "${schema}";
      create table "${schema}".a(id text primary key,value integer not null);
      create table "${schema}".b(id text primary key,value integer not null);
      insert into "${schema}".a values('one',1),('two',2); insert into "${schema}".b values('one',10);
      create view "${schema}".routed as select * from "${schema}".a;
      create function "${schema}".dynamic_read() returns integer language plpgsql stable as $$declare result integer;begin execute 'select sum(value)::int from "${schema}".a' into result;return result;end$$;
      create function "${schema}".timed_read() returns timestamptz language sql stable as $$select current_timestamp from "${schema}".a limit 1$$;
      create function "${schema}".atomic_timed_read() returns timestamptz language sql stable begin atomic select current_timestamp from "${schema}".a limit 1; end;
      create sequence "${schema}".sequence_value;grant usage,select on sequence "${schema}".sequence_value to routine_runtime;
      create function "${schema}".shadow_read() returns bigint language sql stable set search_path="${schema}",public as $$with a as (select * from a) select count(*) from a$$;
      grant usage on schema "${schema}" to routine_runtime;
      grant select,insert,update,delete on all tables in schema "${schema}" to routine_runtime;`);
    await admin.begin(transaction => installPostgresTransactionGate(transaction, 'routine_runtime'));
  });
  afterAll(async () => {
    await database?.end();
    await admin?.unsafe(`drop schema if exists "${schema}" cascade`);
    await admin?.end();
  });

  it('executes time, randomness and dynamic SQL only through the no-store API, including composed endpoints', async () => {
    const { artifact, engine } = await install({
      clock: definition('select current_timestamp as value'),
      random: definition('select random() as value'),
      dynamic: definition(`select "${schema}".dynamic_read() as value`),
      nested: definition(`select "${schema}".timed_read() as value`),
    });
    expect(Object.keys(artifact.diagnostics)).toHaveLength(4);
    for (const endpoint of ['clock', 'random', 'dynamic', 'nested']) {
      await expect(engine.query(endpoint, {}, { scope: 'a' })).rejects.toThrow('QUERY_REQUIRES_NO_STORE_EXECUTION');
      const result = await engine.queryUncached(endpoint, {}, { scope: 'a' });
      expect(result).toMatchObject({ cachePolicy: 'no-store' });
      expect(result).not.toHaveProperty('headers');
    }
    const first = await engine.queryUncached('random', {}, { scope: 'a' });
    expect((await engine.queryUncached('random', {}, { scope: 'a' })).data).not.toEqual(first.data);
    const queries = { ...artifact.queries, composed: { input: parse, plan: q.map(q.call('clock'), data => data) } };
    const composed = createImpact({ adapter: adapter(), resources: artifact.resources, queries });
    await expect(composed.query('composed', {}, { scope: 'a' })).rejects.toThrow('QUERY_REQUIRES_NO_STORE_EXECUTION');
  });

  it('preserves each driver native types, duplicate rows and SQLSTATE without normalizing IDs', async () => {
    const text = `select '9007199254740993'::bigint as big,'1.2300'::numeric as decimal,'2026-01-01T00:00:00Z'::timestamptz as time,
      '{"a":1}'::json as json,array[1,2] as array,'\\x0102'::bytea as bytes,'NaN'::float8 as nan union all
      select '9007199254740993'::bigint,'1.2300'::numeric,'2026-01-01T00:00:00Z'::timestamptz,'{"a":1}'::json,array[1,2],'\\x0102'::bytea,'NaN'::float8`;
    const { engine } = await install({
      types: definition(text, [], 'no-store'),
      error: definition('select 1/0', [], 'no-store'),
    });
    const native = [...(await database.unsafe(text))];
    const actual = await engine.queryUncached('types', {}, { scope: 'a' });
    expect(actual.data).toEqual(native);
    expect(native).toHaveLength(2);
    await expect(database.unsafe('select 1/0')).rejects.toMatchObject({ code: '22012' });
    await expect(engine.queryUncached('error', {}, { scope: 'a' })).rejects.toMatchObject({ code: '22012' });
  });

  it('validates the first Command once, skips Query validation, and allows explicit revalidation', async () => {
    const { artifact } = await install({ read: definition(`select * from "${schema}".a order by id`) });
    const statements: string[] = [];
    const engine = createImpact({
      adapter: postgresAdapter({ database: recordingDatabase(statements) }),
      resources: artifact.resources,
      queries: artifact.queries,
    });
    await engine.query('read', {}, { scope: 'a' });
    const catalogSql = /\bpg_(?:class|proc|trigger|policy|attribute|index)\b|observer_manifest/i;
    expect(statements.filter(text => catalogSql.test(text))).toEqual([]);
    statements.length = 0;
    await engine.command({ scope: 'a' }, db =>
      db.execute(new Sql(`update "${schema}".a set value=value where id='one'`)),
    );
    expect(statements.some(text => catalogSql.test(text))).toBe(true);
    statements.length = 0;
    await engine.command({ scope: 'a' }, db =>
      db.execute(new Sql(`update "${schema}".a set value=value where id='one'`)),
    );
    expect(statements.filter(text => catalogSql.test(text))).toEqual([]);
    statements.length = 0;
    await engine.validate();
    expect(statements.some(text => catalogSql.test(text))).toBe(true);
  });

  it('preserves driver command metadata through command data and savepoints', async () => {
    const { engine } = await install({ read: definition(`select * from "${schema}".a order by id`) });
    const processed = await engine.command({ scope: 'a' }, db =>
      db.execute(new Sql(`update "${schema}".a set value=value where id='one'`)),
    );
    expect(driverRows(processed.data)).toEqual([]);
    if (pgPool) {
      const result = processed.data as PgExecuteResult;
      expect(result).toMatchObject({ command: 'UPDATE', rowCount: 1 });
      const rowCount: number | null = result.rowCount;
      void rowCount;
    } else {
      expect(processed.data as PostgresExecuteResult).toMatchObject({ command: 'UPDATE', count: 1 });
    }
    expect(processed.impact.targets).toEqual([]);
    const missing = await engine.command({ scope: 'a' }, db =>
      db.savepoint(child => child.execute(new Sql(`update "${schema}".a set value=value where id='missing'`))),
    );
    expect(pgPool ? (missing.data as PgExecuteResult).rowCount : (missing.data as PostgresExecuteResult).count).toBe(0);
    const returned = await engine.command({ scope: 'a' }, db =>
      db.execute(new Sql(`update "${schema}".a set value=value where id='one' returning id`)),
    );
    expect(driverRows(returned.data)).toEqual([{ id: 'one' }]);
  });

  it('compares native and SDI results across joins, anti joins, sets, recursion, windows and page boundaries', async () => {
    const a = `"${schema}".a`,
      b = `"${schema}".b`;
    const texts = [
      `select x.id as left_id,y.id as right_id from ${a} x cross join ${a} y where x.id=$1 or y.id=$1 order by 1,2`,
      `select x.id,y.value from ${a} x left join ${b} y using(id) order by x.id`,
      `select id from ${a} x where not exists(select from ${b} y where y.id=x.id) order by id`,
      `select id from ${a} union select id from ${b} order by id`,
      `select id from ${a} intersect select id from ${b} order by id`,
      `select id from ${a} except select id from ${b} order by id`,
      `select id,row_number() over(order by value,id) as rank from ${a} order by value,id limit 1`,
      `with recursive walk(n) as (select value from ${a} where id=$1 union all select n-1 from walk where n>0) select n from walk order by n`,
      `select x.id,y.value from ${a} x cross join lateral(select value from ${b} where id=x.id) y order by x.id`,
    ];
    const defs = Object.fromEntries(
      texts.map((text, index) => ['q' + index, definition(text, text.includes('$1') ? ['id'] : [])]),
    );
    const { engine, artifact } = await install(defs);
    expect(artifact.diagnostics).toEqual({});
    const read = () => Promise.all(texts.map((_, index) => engine.query('q' + index, { id: 'one' }, { scope: 'a' })));
    const before = await read();
    for (let index = 0; index < texts.length; index++)
      expect(before[index]).toEqual([
        ...(await database.unsafe(texts[index], texts[index].includes('$1') ? ['one'] : [])),
      ]);
    const changed = await engine.command({ scope: 'a' }, db =>
      db.execute(sql`update ${identifier(schema)}.a set value=3 where id='one'`),
    );
    const after = await read();
    for (let index = 0; index < texts.length; index++) {
      expect(after[index]).toEqual([
        ...(await database.unsafe(texts[index], texts[index].includes('$1') ? ['one'] : [])),
      ]);
      if (JSON.stringify(before[index]) !== JSON.stringify(after[index]))
        expect(
          changed.impact.targets.some(
            target => target.endpoint === 'q' + index && matchesInputSelector({ id: 'one' }, target.selector),
          ),
        ).toBe(true);
    }
  });

  it('preserves every changed resource when one transaction exceeds the fact budget', async () => {
    await admin.unsafe(
      `delete from "${schema}".a where id like 'overflow-a-%';delete from "${schema}".b where id='overflow-b'`,
    );
    const { engine } = await install({
      readA: definition(`select * from "${schema}".a`),
      readB: definition(`select * from "${schema}".b`),
    });
    try {
      const changed = await engine.command({ scope: 'a' }, async db => {
        await db.execute(new Sql(`insert into "${schema}".a select 'overflow-a-'||g,g from generate_series(1,201) g`));
        await db.execute(new Sql(`insert into "${schema}".b values('overflow-b',1)`));
      });
      expect(changed.impact.targets.map(target => target.endpoint)).toEqual(['readA', 'readB']);
      expect(changed.impact.targets.every(target => target.selector.kind === 'all')).toBe(true);
    } finally {
      await admin.unsafe(
        `delete from "${schema}".a where id like 'overflow-a-%';delete from "${schema}".b where id='overflow-b'`,
      );
    }
  });

  it('finds shadowed CTE reads inside SQL functions and rejects hidden time in views', async () => {
    const catalog = createPostgresCatalogResolver(admin, resources, {
      parserVersion: version,
      searchPath: [schema, 'public'],
    });
    expect(
      (
        await compilePostgresQuery({ text: `select "${schema}".shadow_read()` }, resources, version, { catalog })
      ).reads.map(read => read.resource),
    ).toContain('a');
    await admin.unsafe(`create view "${schema}".timed_view as select current_timestamp as now,id from "${schema}".a`);
    await expect(
      compilePostgresQuery({ text: `select * from "${schema}".timed_view` }, resources, version, {
        catalog: createPostgresCatalogResolver(admin, resources, { parserVersion: version }),
      }),
    ).rejects.toThrow('POSTGRES_QUERY_REQUIRES_FRESHNESS_POLICY');
    await expect(
      compilePostgresQuery({ text: `select "${schema}".atomic_timed_read()` }, resources, version, { catalog }),
    ).rejects.toThrow('POSTGRES_QUERY_REQUIRES_FRESHNESS_POLICY');
  });

  it('preserves sequence rollback semantics and keeps session state out of cached queries', async () => {
    const { engine } = await install({ session: definition("select current_setting('application_name') as name") });
    await expect(engine.query('session', {}, { scope: 'a' })).rejects.toThrow('QUERY_REQUIRES_NO_STORE_EXECUTION');
    expect(await engine.queryUncached('session', {}, { scope: 'a' })).toMatchObject({ cachePolicy: 'no-store' });
    await expect(
      engine.command({ scope: 'a' }, async db => {
        await db.execute(new Sql(`select nextval('"${schema}".sequence_value')`));
        throw new Error('rollback sequence transaction');
      }),
    ).rejects.toThrow('rollback sequence transaction');
    const next = await engine.command({ scope: 'a' }, db =>
      db.execute(new Sql(`select nextval('"${schema}".sequence_value') as value`)),
    );
    expect(String(driverRows(next.data)[0].value)).toBe('2');
  });

  it('recompiles changed views atomically, explicitly detects old artifacts and observes the new dependency', async () => {
    const definitions = { routed: definition(`select * from "${schema}".routed order by id`) };
    const previous = await install(definitions);
    await expect(previous.engine.validate()).resolves.toBeUndefined();
    const next = await migratePostgresQueries(admin, resources, definitions, {
      ...options(),
      change: async tx => {
        await tx.unsafe(`create or replace view "${schema}".routed as select * from "${schema}".b`);
      },
    });
    expect(next.manifest.reads.routed.map(read => read.resource)).toEqual(['b']);
    expect(await previous.engine.query('routed', {}, { scope: 'a' })).toEqual([{ id: 'one', value: 10 }]);
    await expect(previous.engine.validate()).rejects.toThrow('POSTGRES_ARTIFACT_DRIFT');
    const engine = createImpact({ adapter: adapter(), resources: next.resources, queries: next.queries });
    expect(await engine.query('routed', {}, { scope: 'a' })).toEqual([{ id: 'one', value: 10 }]);
    const changed = await engine.command({ scope: 'a' }, db =>
      db.execute(sql`update ${identifier(schema)}.b set value=11 where id='one'`),
    );
    expect(changed.impact.targets).toContainEqual({ endpoint: 'routed', scope: 'global', selector: { kind: 'all' } });
    await expect(
      migratePostgresQueries(admin, resources, definitions, {
        ...options(),
        change: async tx => {
          await tx.unsafe(`create or replace view "${schema}".routed as select * from "${schema}".a`);
          throw new Error('abort migration');
        },
      }),
    ).rejects.toThrow('abort migration');
    expect(await engine.query('routed', {}, { scope: 'a' })).toEqual([{ id: 'one', value: 11 }]);
  });

  it('serializes a transaction-pooled Query against a cooperating migration', async () => {
    const definitions = { read: definition(`select * from "${schema}".a order by id`) };
    const installed = await migratePostgresQueries(admin, resources, definitions, options());
    const transactionAdapter = pgPool ? pgAdapter({ database: pgPool }) : postgresAdapter({ database });
    const boundQuery = transactionAdapter[bindAdapter](installed.resources, installed.manifest);
    let queryEntered!: () => void;
    const entered = new Promise<void>(resolve => {
      queryEntered = resolve;
    });
    let releaseQuery!: () => void;
    const holdQuery = new Promise<void>(resolve => {
      releaseQuery = resolve;
    });
    const activeQuery = boundQuery.query('a', async () => {
      queryEntered();
      await holdQuery;
      return 'held';
    });
    await entered;
    let migrated = false;
    const migration = migratePostgresQueries(admin, resources, definitions, options()).then(result => {
      migrated = true;
      return result;
    });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(migrated).toBe(false);
    releaseQuery();
    expect(await activeQuery).toBe('held');
    await migration;
    expect(migrated).toBe(true);
  });

  it('detects function-only and permission-only drift when explicitly validated', async () => {
    const first = await install({ read: definition(`select "${schema}".shadow_read()`) });
    await admin.unsafe(
      `create or replace function "${schema}".shadow_read() returns bigint language sql stable as $$select count(*) from "${schema}".b$$`,
    );
    await expect(first.engine.validate()).rejects.toThrow('POSTGRES_ARTIFACT_DRIFT');
    const second = await install({ read: definition(`select * from "${schema}".a`) });
    await admin.unsafe(`revoke select on "${schema}".a from routine_runtime`);
    try {
      await expect(second.engine.validate()).rejects.toThrow('POSTGRES_ARTIFACT_DRIFT');
    } finally {
      await admin.unsafe(`grant select on "${schema}".a to routine_runtime`);
    }
  });

  it('validates against the post-migration catalog snapshot after waiting for its lock', async () => {
    const { engine } = await install({ read: definition(`select * from "${schema}".routed`) });
    let entered!: () => void, release!: () => void;
    const active = new Promise<void>(resolve => {
      entered = resolve;
    });
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const changing = admin.begin('isolation level read committed', async tx => {
      await tx.unsafe('select pg_advisory_xact_lock($1,$2)', [0x534449, 0x5047]);
      await tx.unsafe('lock table only "sdi_control"."transaction_gate" in access exclusive mode');
      await tx.unsafe(`create or replace view "${schema}".routed as select * from "${schema}".a`);
      entered();
      await gate;
    });
    await active;
    let settled = false;
    const waiting = engine.validate().then(
      () => {
        settled = true;
        return undefined;
      },
      error => {
        settled = true;
        return error;
      },
    );
    try {
      await new Promise(resolve => setTimeout(resolve, 25));
      expect(settled).toBe(false);
    } finally {
      release();
      await changing;
    }
    expect(await waiting).toMatchObject({ message: 'POSTGRES_ARTIFACT_DRIFT' });
  });

  it('prevents explicit transaction escape and DDL through the command SQL API', async () => {
    const { engine } = await install({ read: definition(`select * from "${schema}".a`) });
    for (const text of ['commit', 'rollback', "prepare transaction 'escaped'"]) {
      await expect(engine.command({ scope: 'a' }, db => db.execute(new Sql(text)))).rejects.toThrow(
        'COMMAND_TRANSACTION_CONTROL_FORBIDDEN',
      );
    }
    await expect(
      engine.command({ scope: 'a' }, db => db.execute(new Sql(`alter table "${schema}".a add column escaped text`))),
    ).rejects.toThrow('COMMAND_REQUIRES_MIGRATION_API');
    await expect(
      engine.command({ scope: 'a' }, db => db.copyFrom(new Sql(`copy "${schema}".a from stdin;commit`), [])),
    ).rejects.toThrow('COMMAND_REQUIRES_ONE_STATEMENT');
    expect(await engine.query('read', {}, { scope: 'a' })).toHaveLength(2);
  });

  it('closes abandoned and partially consumed cursors before rolling back and reusing a one-connection pool', async () => {
    const { engine } = await install({ read: definition(`select * from "${schema}".a order by id`) });
    let escaped: AsyncIterator<unknown> | undefined;
    await expect(
      engine.command({ scope: 'a' }, async db => {
        escaped = db.cursor(sql`select * from ${identifier(schema)}.a`, 1)[Symbol.asyncIterator]();
        await escaped.next();
      }),
    ).rejects.toThrow('UNAWAITED_DATABASE_OPERATION');
    await expect(escaped!.next()).rejects.toThrow('WRITE_CONTEXT_CLOSED');
    expect(await engine.query('read', {}, { scope: 'a' })).toHaveLength(2);
    await engine.command({ scope: 'a' }, async db => {
      for await (const _batch of db.cursor(sql`select * from ${identifier(schema)}.a`, 1)) break;
    });
    await expect(
      engine.command({ scope: 'a' }, async db => {
        for await (const _batch of db.cursor(sql`select 1/0`, 1)) {
          /* fetch must preserve SQLSTATE */
        }
      }),
    ).rejects.toMatchObject({ code: '22012' });
    expect(await engine.query('read', {}, { scope: 'a' })).toHaveLength(2);
  });

  it('rolls back COPY source failures and preserves session usability', async () => {
    const { engine } = await install({ read: definition(`select * from "${schema}".a order by id`) });
    async function* source() {
      yield 'copy-abort\t9\n';
      throw new Error('source failed');
    }
    await expect(
      engine.command({ scope: 'a' }, db =>
        db.copyFrom(sql`copy ${identifier(schema)}.a(id,value) from stdin`, source()),
      ),
    ).rejects.toThrow();
    expect(await engine.query('read', {}, { scope: 'a' })).toHaveLength(2);
  });

  it('routes custom type semantics to native no-store execution on the transaction adapter', async () => {
    await admin.unsafe(
      `create type "${schema}".mood as enum('ok','bad');create function "${schema}".custom_type_read(value "${schema}".mood) returns "${schema}".mood language sql immutable as $$select $1$$`,
    );
    const { engine, artifact } = await install({
      custom: definition(`select 'ok'::"${schema}".mood as value`),
      implicit: definition(`select "${schema}".custom_type_read('ok') as value from "${schema}".a`),
    });
    expect(artifact.diagnostics.custom).toBe('UNRESOLVED_QUERY_EXPRESSION');
    expect((await engine.queryUncached('custom', {}, { scope: 'a' })).data).toEqual([{ value: 'ok' }]);
    expect(artifact.diagnostics.implicit).toBe('UNRESOLVED_FUNCTION_TYPES');
    await expect(engine.query('implicit', {}, { scope: 'a' })).rejects.toThrow('QUERY_REQUIRES_NO_STORE_EXECUTION');
    const queryAdapter = pgPool ? pgAdapter({ database: pgPool }) : postgresAdapter({ database });
    const queryEngine = createImpact({
      adapter: queryAdapter as never,
      resources: artifact.resources,
      queries: artifact.queries,
    });
    await queryEngine.validate();
    expect(await queryEngine.queryUncached('custom', {}, { scope: 'a' })).toMatchObject({
      data: [{ value: 'ok' }],
      cachePolicy: 'no-store',
    });
    await expect(queryEngine.command({ scope: 'a' }, async () => undefined)).resolves.toMatchObject({
      data: undefined,
    });
  });

  it('limits custom-column fallback to endpoints that read the custom relation', async () => {
    await admin.unsafe(`create type "${schema}".state as enum('open','closed');
      create table "${schema}".typed_relation(id text primary key,state "${schema}".state not null);
      insert into "${schema}".typed_relation values('one','open');grant select on "${schema}".typed_relation to routine_runtime`);
    const artifact = await compilePostgresArtifacts(
      admin,
      resources,
      {
        regular: definition(`select * from "${schema}".a order by id`),
        typed: definition(`select * from "${schema}".typed_relation order by id`),
      },
      options(),
    );
    expect(artifact.diagnostics.regular).toBeUndefined();
    expect(artifact.diagnostics.typed).toBe('UNRESOLVED_CUSTOM_TYPE_OR_OPERATOR');
    await admin.unsafe(
      generateObserverMigration(artifact.resources, artifact.manifest, { runtimeRole: 'routine_runtime' }),
    );
    const engine = createImpact({ adapter: adapter(), resources: artifact.resources, queries: artifact.queries });
    await expect(engine.query('regular', {}, { scope: 'a' })).resolves.toHaveLength(2);
    await expect(engine.query('typed', {}, { scope: 'a' })).rejects.toThrow('QUERY_REQUIRES_NO_STORE_EXECUTION');
  });

  it('observes numeric scale and raw JSON text changes and routes MVCC columns to no-store', async () => {
    await admin.unsafe(
      `create table "${schema}".typed(id text primary key,n numeric,j json);insert into "${schema}".typed values('one',1.0,'{"a":1}');grant select,update on "${schema}".typed to routine_runtime`,
    );
    const typed = {
      typed: { schema, table: 'typed', idColumn: 'id', scopeColumn: null, columns: ['id', 'n', 'j'] },
    } as const;
    const artifact = await compilePostgresArtifacts(
      admin,
      typed,
      {
        text: definition(`select n::text,j::text from "${schema}".typed where id=$1`, ['id']),
        mvcc: definition(`select xmin::text from "${schema}".typed`),
      },
      options(),
    );
    expect(artifact.diagnostics.mvcc).toBe('UNRESOLVED_QUERY_EXPRESSION');
    await admin.unsafe(
      generateObserverMigration(artifact.resources, artifact.manifest, { runtimeRole: 'routine_runtime' }),
    );
    const engine = createImpact({ adapter: adapter(), resources: artifact.resources, queries: artifact.queries });
    const before = await engine.query('text', { id: 'one' }, { scope: 'a' });
    const changed = await engine.command({ scope: 'a' }, db =>
      db.execute(new Sql(`update "${schema}".typed set n=1.00,j=' { "a" : 1 } '::json where id='one'`)),
    );
    const after = await engine.query('text', { id: 'one' }, { scope: 'a' });
    expect(after).not.toEqual(before);
    expect(changed.impact.targets).toContainEqual({ endpoint: 'text', scope: 'global', selector: { kind: 'all' } });
  });
});
