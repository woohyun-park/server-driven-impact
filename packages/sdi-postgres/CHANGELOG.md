# Changelog

## 0.3.0

- Preserve the selected PostgreSQL driver's native successful execution result from `execute()` through `CommandResult.data`, savepoints, and `ImpactUnavailableError.data`. postgres.js returns its metadata-bearing `RowList`; node-postgres returns `QueryResult`, including `command` and `rowCount: number | null`.
- Keep internal catalog, observer, and query execution on a separate row-array path, so `pgDatabase().unsafe()` remains compatible and internal calls do not depend on a union of driver result types.
- Document the distinction between PostgreSQL processed-row counts and SDI impact, and record the SQL validation cache benchmark decision.

## 0.2.0

- Replace PostgreSQL CRUD helpers and registered routine dispatch with one observed native SQL `execute()` command surface. Remove `operations`, `writeAccess`, and `routines`; passing the removed adapter options is rejected instead of silently ignored.
- Stop applying the former helper-specific JSON projection to command results. Values now follow the selected driver's codecs, and SQL function calls return the row shape produced by their `SELECT` statement.
- Return only the rows produced by `RETURNING` from `execute()`. A DML statement without `RETURNING` therefore returns `[]` whether it processes zero or many rows; applications on 0.2.0 must use `RETURNING` when they need to distinguish those cases.
- Move native SQL authorization to database roles, grants, RLS policies, and application domain validation. SDI continues to own the transaction, validate the command SQL boundary, observe writes, and calculate impact.

## 0.1.1

- Move package source, documentation, and releases to the standalone Server-Driven Impact repository.

## 0.1.0

- Initial public release of the PostgreSQL adapter for postgres.js and node-postgres.
