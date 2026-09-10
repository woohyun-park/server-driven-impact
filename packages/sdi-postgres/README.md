# @server-driven-impact/postgres

[English](./README.md) | [한국어](./README.ko.md)

PostgreSQL execution, write observation, catalog validation, and migration support for Server-Driven Impact.

```bash
pnpm add @server-driven-impact/core @server-driven-impact/runtime @server-driven-impact/postgres postgres
```

Use `postgresAdapter({ database })` with postgres.js. For node-postgres, install `pg` (and `@types/pg` in TypeScript projects) and import `pgAdapter` from `@server-driven-impact/postgres/pg`; COPY also requires `pg-copy-streams`. The `pg` entry point does not require postgres.js.

```ts
import postgres from 'postgres';
import { createImpact, compileManifest, defineQueries, q, type Input, type Resources } from '@server-driven-impact/runtime';
import { generateObserverMigration, identifier, postgresAdapter, sql } from '@server-driven-impact/postgres';

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1 });
const database = postgres(process.env.DATABASE_URL!, { max: 4 });
const resources: Resources = {
  todos: {
    schema: 'public', table: 'todos', idColumn: 'id', scopeColumn: 'account_id',
    columns: ['id', 'account_id', 'status'],
  },
};
const input = { parse(value: unknown): Input {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_INPUT');
  const status = (value as Record<string, unknown>).status;
  if (typeof status !== 'string') throw new Error('INVALID_STATUS');
  return { status };
} };
const queries = defineQueries({
  'todos.byStatus': {
    input,
    plan: q.select('todos', { where: [q.eq('status', q.input('status'))] }),
  },
});

// Run this with schema-owner credentials after each relevant migration.
await admin.unsafe(generateObserverMigration(resources, compileManifest(queries, resources), {
  runtimeRole: 'app_runtime',
}));
await admin.end();

const adapter = postgresAdapter({
  database,
  setup: async (tx, scope) => { await tx.unsafe("select set_config('app.account_id', $1, true)", [String(scope)]); },
});
const engine = createImpact({ resources, queries, adapter });
await engine.validate();
const result = await engine.command({ scope: 'account-a' }, db => db.execute(sql`
  insert into ${identifier('public')}.${identifier('todos')}(id, account_id, status)
  values(${'todo-1'}, ${'account-a'}, ${'open'})
`));
console.log(result.impact);
await database.end();
```

`execute()` runs the statement once and returns the selected driver's result object without copying, flattening, or converting it. With postgres.js the result is `RowList<Record<string, unknown>[]>`, so returned rows remain directly iterable and `result.count` and `result.command` are available. With node-postgres the result is `QueryResult<Record<string, unknown>>`, with rows in `result.rows` and `result.rowCount: number | null`. Driver-specific fields follow that driver's versioned contract; SDI preserves the result container but does not infer column types from SQL.

The driver result becomes `data` on the Command result:

```ts
const { data, impact } = await engine.command({ scope: 'account-a' }, db =>
  db.execute(sql`update todos set status=${'closed'} where id=${'todo-1'}`),
);

console.log(data.count); // postgres.js: number
console.log(impact.targets);
```

For `pgAdapter`, use `data.rowCount`; it remains `number | null` in TypeScript. The driver's processed-row count is the command tag's count, not the number of rows whose stored values changed. For example, updating one matching row to its existing value can report a count of `1` while `impact.targets` is empty because no observable row value changed. SQLSTATE and other execution failures remain driver error objects and are separate from successful execution results. The same result type is preserved through `savepoint()`, and a committed result is retained in `ImpactUnavailableError.data` if post-commit impact collection fails.

The table must already exist, the runtime role must have its normal table privileges, and its row-level security policy must use the same scope established by `setup`. Generate and apply the observer migration with schema-owner credentials, then call `engine.validate()` at the application's startup, deployment, or health-check boundary. Normal Query and Command execution does not repeat full catalog validation.

The conformance suite covers PostgreSQL 14–18 with postgres.js and pg. Transaction pooling, opaque dynamic SQL dependency inference, external I/O observation, autonomous procedures, held cursors, and two-phase commit are outside the atomic Command contract. The detailed contract is in the [PostgreSQL compatibility guide](https://github.com/woohyun-park/server-driven-impact/blob/main/spec/server-driven-impact/postgres-compatibility.md).

Node.js 22.18 or newer is required.

When upgrading from 0.1.x, see the corrected [0.2.0 migration guide](../../docs/migrations/postgres-0.2.md).

## Native and optional ORM commands

Version 0.4 adds native `tx.query(text, values)` for pg, scoped lazy postgres.js tagged queries, and optional `drizzleAdapter` / `prismaAdapter` subpaths. Pin Drizzle 0.45.2 or Prisma/client/adapter-pg/driver-adapter-utils 7.10.0 with pg 8.16.3. ORM clients execute through the guarded connection; their nested transactions use SDI savepoints. Repositories receive the command client explicitly.

Regenerate and install observer protocol 9 artifacts when upgrading. See [0.4 migration and support](../../docs/migrations/transaction-impact-0.4.md) for supported native methods, installation, lifecycle limits, codecs and examples.
