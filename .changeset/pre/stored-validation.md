---
"@server-driven-impact/core": minor
"@server-driven-impact/runtime": minor
"@server-driven-impact/postgres": minor
"@server-driven-impact/sqlite": minor
---

Breaking: record PostgreSQL validation snapshots with a catalog hash in `sdi_control.validation`, and check them once per process in the first Command preamble, so request paths no longer run catalog validation and DDL applied outside SDI is still detected. When the hash moved, the first Command validates live and records the result through the guarded `sdi_control.record_validation()`, so later processes use it without a refresh step; `refreshPostgresValidation()` records with owner credentials. `validate()` now returns `{ report, source, validatedAt }` and records live results. Migrations record validation problems instead of throwing. `POSTGRES_TRANSACTION_GATE_NOT_INITIALIZED` becomes `POSTGRES_CONTROL_NOT_INITIALIZED`, and missing access raises `POSTGRES_CONTROL_ACCESS_DENIED`. The command SQL parser loads when the adapter is bound. Rerun observer migrations before deploying this version.
