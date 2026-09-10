# Plan: Database correctness and performance

## Outcome and scope

Prevent PostgreSQL and SQLite query-impact misses caused by database value semantics, close SQLite transaction-observation gaps, and reduce impact-calculation and adapter overhead. Preserve the conservative contract: uncertain comparisons widen invalidation instead of narrowing it.

Acceptance criteria:

- Result changes caused by supported numeric coercion and SQLite built-in collations match the returned selector.
- SQLite native SQL cannot escape the owned transaction through comments, and unsupported schema-level REPLACE policies fail validation.
- SQLite supports OFFSET without LIMIT and avoids unnecessary RETURNING work.
- Impact calculation uses a precomputed resource index and bounded selector sets, with regression benchmarks.
- PostgreSQL native-query and composed-query precision only increases where it is provably safe.
- Package, type, unit, SQLite, and PostgreSQL matrix checks remain green.

New database families, CDC, transaction pooling, Expo SQLite, BLOB selectors, and composite SQLite primary keys remain follow-up work.

## Workspace and approach

- Base / task branch / PR target: `main` / `feat/database-correctness-performance` / `main`
- Workspace: `/Users/woohyunpark/Desktop/c/server-driven-impact`
- Affected areas: core selector semantics and calculator, runtime query manifest, SQLite catalog/observer/SQL execution, PostgreSQL catalog precision, tests, benchmarks, and package documentation.
- Decisions or risks that need user input: none. Unknown database equality semantics widen or fail validation.

## Verification

- Focused core and SQLite regression tests during development.
- `pnpm typecheck`, `pnpm test`, and `pnpm pack:check`.
- PostgreSQL 14-18 matrix with postgres.js and node-postgres.
- Repeatable calculator and adapter benchmarks with before/after output.

## Delivery

- Commit / push / PR authorization: implementation is authorized; push and PR creation were not requested.
- Remaining permission needed: push or PR creation only if later requested.
- Status and next action: implemented. Core, SQLite, package, and PostgreSQL 14-18 matrix verification passed; benchmark results are recorded under `docs/benchmarks/`.
