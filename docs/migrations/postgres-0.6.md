# PostgreSQL transaction-only migration

This release removes the PostgreSQL adapter's session execution path. Query, Command, and catalog validation now use one transaction-pool-compatible database.

## Connection API

Replace split or mode-based options:

```ts
postgresAdapter({
  query: { database: queryDatabase, connectionMode: 'transaction' },
  command: { database: commandDatabase, connectionMode: 'session' },
});
```

with one database:

```ts
const database = postgres(process.env.SUPAVISOR_TRANSACTION_URL!, {
  max: 1,
  prepare: false,
});

postgresAdapter({ database, setup });
```

Use the same shape for `pgAdapter({ database: pool })`. Drizzle and Prisma adapters also receive one `pg.Pool`. Passing `query`, `command`, or `connectionMode` now fails with `POSTGRES_CONNECTION_OPTIONS_REMOVED`.

## Database artifacts

Regenerate and install observer protocol 10 before accepting Commands. The migration installs `sdi_control.transaction_gate`, updates observer functions with the collecting/sealed state check, and replaces the artifact fingerprint. Apply `generateObserverMigration()` output in one explicit transaction, or use `migratePostgresQueries()` / `migratePostgresArtifacts()`.

The first Command for each bound adapter validates the installed observer and caches that result. A stale protocol fails before the application callback runs.

## Deferred behavior

Command completion now has this order:

```text
callback closes
→ started operations settle
→ SET CONSTRAINTS ALL IMMEDIATE
→ observations drain to memory
→ observer becomes sealed
→ COMMIT
```

Deferred constraints and constraint triggers must succeed at the `SET CONSTRAINTS ALL IMMEDIATE` boundary. Transactions that rely on a different order among end-of-COMMIT triggers can now fail earlier. If trigger code defers new registered writes until COMMIT, the sealed observer aborts that write rather than allowing it to commit without impact.

Observation drain failure now rolls the business transaction back. `ImpactUnavailableError.data` remains reserved for impact conversion failures after a confirmed COMMIT. `CommitStateUnknownError` continues to represent an indeterminate COMMIT outcome.

## Runtime requirements

- Use a transaction endpoint for Supavisor or PgBouncer.
- Configure postgres.js with `prepare: false`.
- Keep `setup` transaction-local; `SET LOCAL ROLE` and `set_config(..., true)` are supported.
- Do not depend on role, GUC, temporary object, advisory lock, or LISTEN state surviving the transaction.
