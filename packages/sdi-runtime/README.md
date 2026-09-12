# @server-driven-impact/runtime

[English](./README.md) | [한국어](./README.ko.md)

The Query/Command execution boundary for Server-Driven Impact.

```bash
pnpm add @server-driven-impact/core @server-driven-impact/runtime @server-driven-impact/sqlite
```

```ts
import { DatabaseSync } from 'node:sqlite';
import { createImpact, defineQueries, q, type Input, type Resources } from '@server-driven-impact/runtime';
import { sqliteAdapter } from '@server-driven-impact/sqlite';

const database = new DatabaseSync(':memory:');
database.exec(`pragma foreign_keys=on; create table todos(
  id text primary key, account_id text not null, status text not null
)`);
const resources: Resources = {
  todos: {
    schema: 'main', table: 'todos', idColumn: 'id', scopeColumn: 'account_id',
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
const engine = createImpact({ resources, queries, adapter: sqliteAdapter({ database }) });

await engine.validate();
await engine.command({ scope: 'account-a' }, db => db.execute(
  'insert into todos(id, account_id, status) values(?, ?, ?)',
  ['todo-1', 'account-a', 'open'],
));
const result = await engine.command({ scope: 'account-a' }, db =>
  db.execute('update todos set status=? where id=?', ['done', 'todo-1']),
);
console.log(result.impact);
console.log(await engine.query('todos.byStatus', { status: 'done' }, { scope: 'account-a' }));
database.close();
```

Commands return `{ data, impact }`. The application decides how to serialize that value over HTTP and how a frontend uses it. `validate()` is explicit and is suitable for startup, deployment, or a health check; normal Query and Command execution does not scan the whole database catalog.

For server-owned keys, register versioned `cacheContracts` and select the output with the third argument to `command()`. Contract definitions and OpenAPI metadata come from `@server-driven-impact/cache-contract`.

For a required unrestricted string used by a direct equality predicate, built-in adapters automatically narrow cache invalidation after `validate()` proves the live column has exact string equality. Runtime compares the raw and parsed value on every verified field and rejects a request if parsing changes it. Before database validation, or for unsupported collations/operators, invalidation keeps the endpoint fallback.

```ts
// Choose one call per business operation:
const logical = await engine.command(context, work);
// { data, impact }

const cached = await engine.command(context, work, {
  cacheContract: {id: 'web-cache', version: 1},
});
// { data, impact, cacheInvalidation }
```

Without a cache option (including `{}` or `cacheContract: undefined`), no cache compilation runs and the existing result type stays unchanged. Explicit cache options infer `CommandInvalidationResult<T>`; dynamic `CommandOptions` infer a union that can be narrowed with `'cacheInvalidation' in result`. The logical `impact` field always remains ImpactSet v1. The separate `commandWithInvalidations()` method from prerelease .0 has been removed in .1.

Each contract must cover registered reads or explicitly exclude them (`no-store` / `not-consumed`); coverage is checked at construction. `cacheInvalidationOptions` accepts compiler budgets and an `explain` callback. Scope and contract version are captured before awaiting command work.

The selected contract is resolved before the transaction starts. After commit, `ImpactUnavailableError.data` is **always the business result**, with or without the cache output option. `phase` is `impact-calculation` or `cache-invalidation`; `impact` is present if impact calculation succeeded. Preserve this metadata in your transport. Do not retry the command or roll back optimistic business state because post-commit calculation/compilation failed. Arrange a conservative client resync separately.

Adapter authors use the stable contract exported by `@server-driven-impact/runtime/adapter`. Diagnostic helpers are exported by `@server-driven-impact/runtime/debug`. Node.js 22.18 or newer is required.

The mutation contract is automatic committed WriteSet collection followed by safely narrowed ImpactSet calculation and `{ data, impact }` return. Native and ORM adapter clients keep their own execution semantics; Query dependency registration remains required. [0.4 support and migration](../../docs/migrations/transaction-impact-0.4.md).
