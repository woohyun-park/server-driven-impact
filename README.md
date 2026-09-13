# Server-Driven Impact

[English](./README.md) | [한국어](./README.ko.md)

Server-Driven Impact (SDI) is a backend library that calculates which registered query results may be stale after a database command.

SDI aims to automatically collect a mutation's direct and indirect committed database effects into a WriteSet, derive the affected queries and inputs, and return the narrowest safely supported `{ data, impact }` response to the frontend without missing affected results. Applications register Resources and Queries; mutations do not manually report writes or enumerate invalidations. Conservative widening is a fallback when the available evidence cannot justify narrower impact.

Execution paths include pg, postgres.js, SQLite, and optional Drizzle 0.45.2 + pg and Prisma 7.10.0 + pg adapters. See the [0.4 migration and support guide](./docs/migrations/transaction-impact-0.4.md) and [automatic analysis boundaries](./docs/research/query-automation-boundaries.md).

Suppose an order moves from customer `old` to customer `new`. The detail query for that order and both customer lists may now be stale. SDI observes the committed write and returns that relationship as data:

```json
{
  "protocolVersion": 1,
  "targets": [
    {
      "endpoint": "orders.detail",
      "scope": "caller",
      "selector": { "kind": "inputs", "values": [{ "id": "one" }] }
    },
    {
      "endpoint": "orders.list",
      "scope": "caller",
      "selector": {
        "kind": "inputs",
        "values": [{ "customer": "new" }, { "customer": "old" }]
      }
    }
  ]
}
```

An `ImpactSet` says that a result **may** have changed. It does not claim that the result was cached or that its rendered value definitely changed. This conservative contract lets an application invalidate, revalidate, publish, or serialize the result using its own transport and cache policy.

## How it works

```text
Resources + Query definitions ─► read dependencies
                                      │
Database command ─► observed writes ──┼─► pure calculation ─► ImpactSet
        │                             │
        └──────── one transaction ────┘
```

1. `Resources` describe database tables, columns, identities, and tenant scope.
2. executable Query definitions describe reads, filters, ordering, and joins.
3. a database adapter owns the transaction and records the writes that actually commit.
4. `@server-driven-impact/core` compares the read dependencies with the observed OLD and NEW row states.
5. the Command resolves with `{ data, impact }` after commit.

Using both OLD and NEW values matters. A row moved from `old` to `new` can make both lists stale. When SDI cannot safely preserve an input constraint, it widens the selector to `{ "kind": "all" }` instead of dropping a possible target.

## Packages

| Package | Responsibility |
| --- | --- |
| [`@server-driven-impact/core`](./packages/sdi-core) | Database-neutral contracts and pure `ImpactSet` calculation |
| [`@server-driven-impact/cache-contract`](./packages/sdi-cache-contract) | Versioned cache-key contracts, OpenAPI metadata, and invalidation compilation |
| [`@server-driven-impact/runtime`](./packages/sdi-runtime) | Query/Command execution boundary and adapter contract |
| [`@server-driven-impact/postgres`](./packages/sdi-postgres) | PostgreSQL adapter for postgres.js and node-postgres |
| [`@server-driven-impact/sqlite`](./packages/sdi-sqlite) | SQLite adapter for Node's synchronous SQLite driver |
| [`@server-driven-impact/tanstack-query`](./packages/sdi-tanstack-query) | Browser-safe TanStack Query invalidation executor |

The packages keep one calculation model while leaving transaction and observation details to each database adapter. Applications may consume logical `ImpactSet` values directly or opt into a versioned cache contract and the TanStack Query executor.

## Quick start with SQLite

Node.js 22.18 or newer is required.

```bash
pnpm add @server-driven-impact/core @server-driven-impact/runtime @server-driven-impact/sqlite
```

```ts
import { DatabaseSync } from 'node:sqlite';
import {
  createImpact,
  defineQueries,
  q,
  type Input,
  type Resources,
} from '@server-driven-impact/runtime';
import { sqliteAdapter } from '@server-driven-impact/sqlite';

const database = new DatabaseSync(':memory:');
database.exec(`
  pragma foreign_keys = on;
  create table todos (
    id text primary key,
    account_id text not null,
    status text not null
  );
`);

const resources: Resources = {
  todos: {
    schema: 'main',
    table: 'todos',
    idColumn: 'id',
    scopeColumn: 'account_id',
    columns: ['id', 'account_id', 'status'],
  },
};

const statusInput = {
  parse(value: unknown): Input {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('INVALID_INPUT');
    }
    const status = (value as Record<string, unknown>).status;
    if (typeof status !== 'string') throw new Error('INVALID_STATUS');
    return { status };
  },
};

const queries = defineQueries({
  'todos.byStatus': {
    input: statusInput,
    plan: q.select('todos', {
      where: [q.eq('status', q.input('status'))],
      order: [{ field: 'id' }],
    }),
  },
});

const engine = createImpact({
  resources,
  queries,
  adapter: sqliteAdapter({ database }),
});

// Choose this lifecycle boundary explicitly. Normal queries and commands do not
// repeat full validation.
await engine.validate();

const context = { scope: 'account-a' };
await engine.command(context, db => db.execute(
  'insert into todos(id, account_id, status) values(?, ?, ?)',
  ['todo-1', 'account-a', 'open'],
));

const { data, impact } = await engine.command(context, db =>
  db.execute('update todos set status=? where id=?', ['done', 'todo-1']),
);

console.log(data);
console.log(impact);
console.log(await engine.query('todos.byStatus', { status: 'done' }, context));

database.close();
```

The second Command impacts `todos.byStatus` for both `{ status: "open" }` and `{ status: "done" }`. The application can attach `impact` to an HTTP response, publish it to a message system, or consume it on the server.

## Core concepts

### Resources

A Resource maps an application name to a database relation. `idColumn` identifies rows. `scopeColumn` partitions caller-specific impact; use `null` for global data. `columns` describes the fields used to validate Query plans and collect write facts.

`scope` is impact metadata, not authentication or authorization. The application must verify identity and enforce access through RLS or equivalent database rules.

### Queries

`defineQueries()` registers executable plans. SDI derives dependencies from selected columns, filters, ordering, and joins. Plans may also compose queries with `q.call`, `q.combine`, `q.when`, `q.bind`, `q.map`, and `q.choose`.

`engine.query()` accepts only registered, cacheable plans. Use `engine.queryUncached()` for a plan compiled with a `no-store` policy.

`input` accepts any object with `parse(value)` or any [Standard Schema](https://standardschema.dev) v1 schema such as zod or valibot. `engine.query()` infers its input type from that schema and its return type from the plan: `q.select<Row>()` returns `Row[]`, `q.count()` returns `number`, `q.call<O>()` returns `O` but defaults to `unknown` unless given an explicit type argument, and `q.map`, `q.combine`, `q.when`, `q.choose` follow their callbacks and children.

### Commands and WriteFacts

`engine.command()` is the tracked write boundary. The adapter executes the callback inside its transaction and records `WriteFact` values for inserts, updates, deletes, triggers, and supported cascades. Rollback produces no successful impact result; rolled-back savepoint writes are discarded.

All work in the Command callback must be awaited. Writes made through another connection or outside the adapter transaction are outside that Command's impact result.

### ImpactSet

Each target contains an endpoint, a scope, and a selector:

- `inputs` lists partial input objects that may match stale results.
- `all` covers every input for the endpoint.
- `caller` is limited to the verified Command scope.
- `global` applies to a Resource whose `scopeColumn` is `null`.

Use `matchesInputSelector()` from `@server-driven-impact/core` when an application needs the reference selector-matching behavior. It conservatively covers common database equality differences such as numeric string coercion and SQLite `NOCASE`/`RTRIM`; this may refresh extra cache entries but avoids missing an affected one.

## PostgreSQL adoption

```bash
pnpm add @server-driven-impact/core @server-driven-impact/runtime @server-driven-impact/postgres postgres
```

A PostgreSQL application normally has two lifecycle paths:

1. after a relevant schema or Query-definition change, use schema-owner credentials to apply `generateObserverMigration(...)`;
2. at startup, deployment, or a health-check boundary, call `engine.validate()` with the runtime connection;
3. serve normal Query and Command traffic through the engine without repeating full catalog validation per request.

The runtime role needs its normal table privileges and should use RLS aligned with the scope set by the adapter's `setup` callback. postgres.js uses `postgresAdapter`. node-postgres uses `pgAdapter` from `@server-driven-impact/postgres/pg`; COPY with that driver also requires `pg-copy-streams`.

Each Command sends one preamble round trip (session lock, collector table, `BEGIN`, request settings) before the business SQL, then `COMMIT`, the observer drain, and the unlock. Reads use one preamble and re-send `search_path` only when a plan's value differs from the one currently in effect, so a transaction whose plans all share one search path sends it once. The preamble temporarily sets `client_min_messages` to `error` for its own implicit block only; the setting reverts before `BEGIN`.

See the [PostgreSQL package guide](./packages/sdi-postgres), [compatibility contract](./spec/server-driven-impact/postgres-compatibility.md), and [orders example](./examples/orders-impact).

## Guarantee boundary

SDI provides impact tracking for supported operations executed through an SDI engine and its adapter-owned transaction. Direct writes on another connection, external services, transaction pooling, autonomous procedures, held cursors, and two-phase commit are outside the atomic Command contract.

The library deliberately fails or widens when it cannot prove a narrow result. Database-specific limits are documented by each adapter. PostgreSQL compatibility is tested across PostgreSQL 14–18 with postgres.js and node-postgres.

## Commit outcome errors

- `ImpactUnavailableError` means the database committed but impact calculation or cache-invalidation compilation failed. `data` is always the business result, `commitState` is `committed`, `phase` identifies the failed stage, and `impact` is available if already calculated.
- `CommitStateUnknownError` means the client cannot determine whether the commit succeeded. Do not blindly retry a non-idempotent Command.

Use `isCommitOutcomeError()` when mapping these cases into an application protocol. SDI does not impose an HTTP envelope, retry policy, idempotency key, or durable outbox.

See the [cache-contract migration guide](./docs/migrations/cache-contract-0.5.md) for existing RPC keys, structured inputs, coverage, post-commit errors, and local prerelease installation.

## Development

```bash
pnpm install
git config blame.ignoreRevsFile .git-blame-ignore-revs
pnpm lint
pnpm typecheck
pnpm test
pnpm pack:check
```

GitHub honors `.git-blame-ignore-revs` on its own; the `git config` line makes local `git blame` skip the same formatting-only commits.

Releases use Changesets and npm trusted publishing from `.github/workflows/sdi-release.yml`.

## License

MIT
