# Stored validation

PostgreSQL catalog and observer validation moves off the request path. A validation snapshot is recorded in the database together with a catalog hash, and each process checks that hash once in its first Command preamble. Short-lived runtimes such as Supabase Edge Functions and serverless Node no longer repeat full validation on every cold start. DDL applied outside SDI is detected without a refresh step.

## What changes

- `installPostgresTransactionGate()` and `generateObserverMigration()` also install `sdi_control.validation` (one row), `sdi_control.catalog_hash(text[])`, and `sdi_control.record_validation(...)`. With `runtimeRole`, the runtime role may read the table and execute the recorder, but it cannot write the table directly. A table with an outdated shape is recreated, because it only caches a validation.
- A snapshot records the report, the equality resources, a catalog hash, and the schemas that hash covers. The hash is computed from the `xmin` of every catalog row validation can depend on: relations, columns, functions, types, operators, collations, constraints, rules, policies, triggers, and inheritance in those schemas, plus casts, extensions, role membership, role settings, role attributes, and the server version. The schemas are those of resources and partitions, those the policy resolver visited (for example `auth` for `auth.uid()`), `public`, stamp schemas, and the observer schema. DDL rewrites catalog rows and moves the hash; `VACUUM` and `ANALYZE` do not.
- `record_validation()` stores a snapshot only when the catalog still has the hash taken before validation, and only one recorder runs at a time. A DDL committed during validation can never pair a newer hash with an older report.
- The first Command of a bound adapter reads the row in its last preamble statement, with no extra round trip, and accepts it only if the fingerprint and the catalog hash match.
  - Later Commands skip the hash. They accept the row that passed, or a row recorded after that decision.
  - Otherwise the Command validates live inside its own transaction before `setup`, records the result for later processes, and caches it on the bound adapter. A failed or refused record never fails the Command.
- `migratePostgresQueries()` and `migratePostgresArtifacts()` validate after all of their DDL and record the snapshot. They return it as `validation: { fingerprint, report, equalityResources, validatedAt, recorded }`. They no longer throw on catalog drift, RLS dependency problems, or unsupported selector collations; inspect `validation.report` to block a deployment.
- `refreshPostgresValidation(database, resources, manifest)` validates and records with owner credentials, without DDL. It is optional: it only saves the first request after a change from paying for live validation.
- `engine.validate()` returns `ValidationResult`, `{ report, source: 'stored' | 'live', validatedAt }`. It always runs the catalog gate. It runs in a read-write transaction and records a live result, so a deployment preflight that calls it also records the snapshot. SQLite always returns `source: 'live'`.
- `POSTGRES_TRANSACTION_GATE_NOT_INITIALIZED` is replaced by `POSTGRES_CONTROL_NOT_INITIALIZED`, raised by Command preambles, reads, and `validate()` when the control relations or functions are missing or outdated. Missing access raises `POSTGRES_CONTROL_ACCESS_DENIED`.
- The adapter starts loading the command SQL parser when it is bound, so a fresh process does not pay for it on its first write.

## Upgrade steps

1. Rerun your observer migration with owner credentials and `runtimeRole`: `migratePostgresQueries()`, `migratePostgresArtifacts()`, or the SQL from `generateObserverMigration()`.
2. Deploy the new library only after that migration. A new library against a database without the control relations fails every Command with `POSTGRES_CONTROL_NOT_INITIALIZED`.
3. Replace reads of `(await engine.validate()).endpoints` with `(await engine.validate()).report.endpoints`.
4. Replace migration error handling for drift with checks on the returned `validation.report`.
5. Do not call `validate()` on every request of a short-lived runtime; Commands already check the snapshot. Call it in a deployment preflight to record the snapshot and to assert `source: 'stored'` and the endpoint statuses you require.

## Guarantees, costs and limits

- A snapshot is used only while the catalog hash it was recorded with still matches, so its report never describes a catalog other than the current one. DDL applied while a process is running is detected by the next process, as before.
- The hash scans catalog rows of the covered schemas once per process. On a local Supabase database with `public`, `auth`, and one observer schema, about 4,300 catalog rows, it took 10.7 ms p50, and it adds no round trip.
- A harmless catalog change also moves the hash; examples are a `GRANT`, `ALTER ROLE ... SET`, a new table in a covered schema, or an extension upgrade. The next process then validates live once and records the result. For artifacts with a catalog stamp, live validation reports `CATALOG_DRIFT` until the artifact is recompiled, as it did before this change.
- The runtime role can record snapshots that its own validation proved. A leaked runtime credential could record a false one; the effect is limited to stale client caches, and that credential can already write business data.
- The table holds one row. Applications with different manifests that share one database replace each other's snapshot; each then validates live on its next process.
- Validation problems never block writes or migrations. Missing or inaccessible control relations are setup errors and fail fast.
