# @server-driven-impact/sqlite

[English](./README.md) | [한국어](./README.ko.md)

SQLite execution and transaction-local write observation for Server-Driven Impact.

```bash
pnpm add @server-driven-impact/core @server-driven-impact/runtime @server-driven-impact/sqlite
```

```ts
import { DatabaseSync } from 'node:sqlite';
import { createImpact, defineQueries, q, type Input, type Resources } from '@server-driven-impact/runtime';
import { sqliteAdapter } from '@server-driven-impact/sqlite';

const database = new DatabaseSync(':memory:');
database.exec(`pragma foreign_keys=on; create table notes(
  id text primary key, tenant_id text not null, category text not null, body text
)`);
const resources: Resources = {
  notes: {
    schema: 'main', table: 'notes', idColumn: 'id', scopeColumn: 'tenant_id',
    columns: ['id', 'tenant_id', 'category', 'body'],
  },
};
const input = { parse(value: unknown): Input {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_INPUT');
  const category = (value as Record<string, unknown>).category;
  if (typeof category !== 'string') throw new Error('INVALID_CATEGORY');
  return { category };
} };
const queries = defineQueries({
  'notes.byCategory': {
    input,
    plan: q.select('notes', { where: [q.eq('category', q.input('category'))] }),
  },
});
const engine = createImpact({ resources, queries, adapter: sqliteAdapter({ database }) });
await engine.validate();
const { impact } = await engine.command({ scope: 'tenant-a' }, db => db.execute(
  'insert into notes(id, tenant_id, category, body) values(?, ?, ?, ?)',
  ['one', 'tenant-a', 'work', 'Ship SDI'],
));
console.log(impact);
database.close();
```

The adapter observes native DML, triggers, foreign-key cascades, rollback, and savepoints inside the Command transaction. It uses connection-local TEMP observers, and serializes managed use of each `DatabaseSync` connection.

Version 0.4 supports Node's synchronous SQLite driver, the `main` database, ordinary tables with one primary-key column, registered `TEXT`, `INTEGER`, or `REAL` columns, and SQLite's built-in `BINARY`, `NOCASE`, and `RTRIM` collations. `ATTACH`, virtual tables, generated or hidden columns, custom collations, `REPLACE`, `INSERT OR REPLACE`, `UPDATE OR REPLACE`, schema-level `ON CONFLICT REPLACE`, transaction control, and DDL inside a Command are rejected. Node.js 22.18 or newer is required.

Version 0.4 also supports synchronous `tx.prepare(text).run/get/all` with native results, including `changes` and `lastInsertRowid`. Escaped prepared statements reject after their command or savepoint closes. Shared managed connections serialize commands and switch observer definitions as needed. Collector overflow preserves unrelated resource detail where the shared budget permits. [Migration and limits](../../docs/migrations/transaction-impact-0.4.md).

Validation returns a `ValidationReport`; the first command pins and caches a snapshot until explicit `validate()`. It does not detect later DDL. Handle endpoint status on every response: apply verified/conservative targets, and invalidate or stop reusing unavailable endpoint caches. [Endpoint assessment migration](../../docs/migrations/endpoint-assessment.md).
