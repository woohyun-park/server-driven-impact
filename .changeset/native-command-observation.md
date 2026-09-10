---
"@server-driven-impact/runtime": minor
"@server-driven-impact/postgres": minor
"@server-driven-impact/sqlite": minor
---

Remove SDI-specific CRUD, operations, routine, and nested PostgreSQL command APIs. Commands now expose only transaction-bound native database operations, while database observers remain the source of write facts and ImpactSet calculation.
