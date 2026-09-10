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

The table must already exist, the runtime role must have its normal table privileges, and its row-level security policy must use the same scope established by `setup`. Generate and apply the observer migration with schema-owner credentials, then call `engine.validate()` at the application's startup, deployment, or health-check boundary. Normal Query and Command execution does not repeat full catalog validation.

The conformance suite covers PostgreSQL 14–18 with postgres.js and pg. Transaction pooling, opaque dynamic SQL dependency inference, external I/O observation, autonomous procedures, held cursors, and two-phase commit are outside the atomic Command contract. The detailed contract is in the [PostgreSQL compatibility guide](https://github.com/woohyun-park/server-driven-impact/blob/main/spec/server-driven-impact/postgres-compatibility.md).

Node.js 22.18 or newer is required.
