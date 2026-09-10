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

Adapter authors use the stable contract exported by `@server-driven-impact/runtime/adapter`. Diagnostic helpers are exported by `@server-driven-impact/runtime/debug`. Node.js 22.18 or newer is required.

The mutation contract is automatic committed WriteSet collection followed by safely narrowed ImpactSet calculation and `{ data, impact }` return. Native and ORM adapter clients keep their own execution semantics; Query dependency registration remains required. [0.4 support and migration](../../docs/migrations/transaction-impact-0.4.md).
