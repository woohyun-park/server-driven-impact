# Endpoint assessment verification — 2026-09-22

The change separates a committed business result from endpoint impact reliability. The focused tests cover verified empty impact, naturally broad impact, precision loss, unavailable target removal, sorted reason unions, full-envelope byte limits, fallback budgets, schema/type restrictions, cached validation failures, explicit recovery, in-flight snapshots, last-started validation ordering, observation isolation, original driver result identity, calculation failures, and callback execution counts.

SQLite tests verify pre-commit collection SQL rollback and committed-data preservation after malformed row conversion. PostgreSQL tests verify changed observer definitions permit a write attempt, an actual observer execution error rolls it back, newly introduced RLS dependencies cannot be excluded using a stale index, and normal command round trips remain unchanged. Existing savepoint, deferred constraint, sealing, native driver, ORM, and precision tests remain in the suite.

The first standard `pnpm test:matrix` and `pnpm test:pgbouncer` attempts could not initialize PostgreSQL: Docker reported `No space left on device` for its WAL directory. Existing containers and volumes were not removed. Temporary copies of the same harnesses added `PGDATA=/tmp/sdi-data` and a 512 MiB `/tmp` tmpfs to each test PostgreSQL container. Image digests, SQL fixtures, driver selection, and assertions were unchanged. An initial concurrent run hit the existing 20-second test timeout; the final matrix ran after other heavy checks completed, without changing timeout settings.

See [the migration contract](../migrations/endpoint-assessment.md) for consumer obligations and the separate toktok-world work. This verification covers the SDI packages; it does not deploy the consumer application.

## Final results

Local runner: Node.js 25.8.0 on macOS, pnpm 10.33.0. Repository CI uses Node.js 24; this records local execution of its checks, not a remote CI run.

| Check | Result |
| --- | --- |
| `pnpm exec biome ci .` | Passed |
| `pnpm typecheck` | Passed, including all package builds/checks and consumer/type tests |
| `pnpm pack:check` | Passed: packed consumer/type checks, core, SQLite, both PostgreSQL driver entrypoints, Drizzle and Prisma |
| `pnpm test` | 159 passed; 73 DB-dependent tests skipped in this non-DB invocation |
| PostgreSQL 14, 15, 16, 17, 18 × postgres.js and node-postgres | 78 passed, zero skipped in each of 10 combinations (780 total) |
| PgBouncer transaction pooling | Both driver runs passed (30 clients each); 11 native/Drizzle/Prisma tests passed |

The PostgreSQL and PgBouncer rows used the tmpfs harness adjustment described above. Matrix reports are local artifacts under `.local/runtime/postgres-release/`; the final matrix summary was written at `2026-09-22T02:44:41.699Z`. The final SQLite-only fallback additions were verified by the final unit suite, including missing-table observer installation and post-commit malformed-row conversion. PostgreSQL production behavior was unchanged after the completed matrix.

## Removal of public version fields — 2026-09-23

`ImpactSet` and `QueryManifest` now omit `protocolVersion`. The manifest validator rejects the obsolete field, and both JSON schemas reject it. Fixture, package-consumer, byte-budget, and command-result checks use the unversioned shapes. The observer fingerprint function hashes resource/read/catalog inputs rather than the removed field, so this removal alone does not alter installed observer identity.

Local checks: CI lint, package typecheck, 160 unit tests (73 DB-dependent skips), and packed-consumer verification passed. The PostgreSQL 14–18 matrix passed with both postgres.js and node-postgres: 78 tests per combination, 780 total, with no skips. PgBouncer transaction pooling passed for both drivers (30 clients each), followed by 11 native/Drizzle/Prisma tests. The database checks used the same tmpfs harness adjustment described above; the final matrix summary was written at `2026-09-23T02:39:51.416Z`.

The release version step advanced the four fixed-version packages to `0.5.0-impact.2`, because `0.5.0-impact.1` was already published. At `.2`, frozen-lockfile installation, CI lint, package typecheck, 160 unit tests, packed-consumer verification, and publication dry-run passed. `pnpm pack:check` regenerated and verified all four `.tgz` archives and their SHA-512 release manifest under `.local/artifacts/sdi/0.5.0-impact.2/`. No ZIP archive was generated.
