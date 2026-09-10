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
const { impact } = await engine.command({ scope: 'tenant-a' }, db => db.insert('notes', [{
  id: 'one', tenant_id: 'tenant-a', category: 'work', body: 'Ship SDI',
}]));
console.log(impact);
database.close();
```

The adapter observes structured writes, trusted native DML, triggers, foreign-key cascades, rollback, and savepoints inside the Command transaction. It uses connection-local TEMP observers, so share one adapter for each `DatabaseSync` connection.

Version 0.1 supports Node's synchronous SQLite driver, the `main` database, ordinary tables with one primary-key column, and registered `TEXT`, `INTEGER`, or `REAL` columns. `ATTACH`, virtual tables, generated or hidden columns, `REPLACE`, transaction control, and DDL inside a Command are rejected. Node.js 22.18 or newer is required.
