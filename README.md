# Server-Driven Impact

Server-Driven Impact (SDI) is a backend library for calculating which registered query results may have become stale after a database command.

An SDI command runs inside the adapter's transaction. The adapter observes committed writes, the shared calculator turns those writes into an `ImpactSet`, and the application decides how to deliver that result to clients or other systems. SDI does not prescribe an HTTP response shape, cache library, or frontend framework.

```text
Query definitions + Resource metadata
                 │
Database command ├─► observed WriteFacts ─► @server-driven-impact/core ─► ImpactSet
                 │
                 └─► committed application data
```

## Packages

| Package | Responsibility |
| --- | --- |
| [`@server-driven-impact/core`](./packages/sdi-core) | Database-neutral contracts and pure `ImpactSet` calculation |
| [`@server-driven-impact/runtime`](./packages/sdi-runtime) | Query/Command boundary and the adapter contract |
| [`@server-driven-impact/postgres`](./packages/sdi-postgres) | PostgreSQL adapter for postgres.js and node-postgres |
| [`@server-driven-impact/sqlite`](./packages/sdi-sqlite) | SQLite adapter for Node's synchronous SQLite driver |

The runtime is the enforcement boundary: application reads and writes that must participate in impact tracking go through an SDI engine. Each adapter owns database-specific transactions, observation, validation, and query execution. `engine.validate()` is explicit so applications can run catalog checks during startup, deployment, or health checks without paying that cost on every request.

## Install

Choose the adapter for your database:

```bash
pnpm add @server-driven-impact/core @server-driven-impact/runtime @server-driven-impact/postgres postgres
```

```bash
pnpm add @server-driven-impact/core @server-driven-impact/runtime @server-driven-impact/sqlite
```

See each package README and the [orders example](./examples/orders-impact) for executable examples. PostgreSQL support and known boundaries are documented in the [compatibility guide](./spec/server-driven-impact/postgres-compatibility.md).

## Development

Node.js 22.18 or newer and pnpm 10.33 are required.

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm pack:check
```

PostgreSQL conformance runs against PostgreSQL 14 through 18 with both postgres.js and node-postgres in CI. Releases use Changesets and npm trusted publishing from `.github/workflows/sdi-release.yml`.

## License

MIT
