# PostgreSQL transaction-only verification — 2026-09-15

## Result

The transaction-only PostgreSQL adapter passed the repository checks, PostgreSQL 14–18 conformance with both supported drivers, and PgBouncer transaction-pool mixed load.

## Checks

| Check | Result |
| --- | --- |
| `pnpm lint` | passed |
| `pnpm typecheck` | passed |
| `pnpm test` | 145 passed, 72 environment-gated |
| `pnpm pack:check` | all package and isolated consumer checks passed |
| PostgreSQL 14–17 × postgres.js/pg | 77 tests per combination passed in a fresh container |
| PostgreSQL 18 × postgres.js/pg | 77 tests per driver passed in the local isolated PostgreSQL 18.6 container |
| PgBouncer 1.24.1 transaction mode × postgres.js/pg | passed with 30 clients, backend pool 5 |
| PgBouncer Drizzle/Prisma acceptance | 11 tests passed through the transaction endpoint |

The combined local matrix command exhausted the Docker VM's writable-layer space when it reached PostgreSQL 18 after eight successful container runs. PostgreSQL 18 was rerun independently against the existing isolated 18.6 container. The matrix runner now creates a fresh container per driver and waits for a real `SELECT 1`, preventing cross-driver catalog growth and startup races.

## PgBouncer load

| Driver | Independent clients | Observed backend PIDs | Query/Command samples | p95 |
| --- | ---: | ---: | ---: | ---: |
| postgres.js 3.4.8 | 30 | 5 | 120 | 183.515 ms |
| pg 8.16.3 | 30 | 5 | 120 | 169.671291 ms |

Each Query used one backend PID from BEGIN through COMMIT. Repeated Query and Command waves observed no transaction-local role, request token, observation phase, or application claim leakage. No session advisory lock remained. Drizzle and Prisma DML, savepoint, result, and error tests also passed through PgBouncer.

## Deferred and failure semantics

The PostgreSQL integration and fault-injection tests cover:

- a deferred constraint trigger whose DML is included in the drained observations;
- a trigger that re-defers a second trigger until COMMIT, where the sealed observer rejects the late registered write and rolls the entire Command back;
- the same sealed error caught in a PL/pgSQL subtransaction, where the late DML rolls back but already observed work commits;
- observation drain failure before COMMIT causing rollback;
- impact conversion failure after confirmed COMMIT retaining `ImpactUnavailableError.data`;
- PostgreSQL COMMIT rejection remaining the original SQLSTATE and network/resolution errors becoming `CommitStateUnknownError`.

Supavisor itself was not available locally. Its transaction endpoint remains an operational acceptance item; PgBouncer verifies the PostgreSQL transaction-pooling protocol used by the adapter.
