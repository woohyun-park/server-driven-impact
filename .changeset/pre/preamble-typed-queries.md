---
'@server-driven-impact/runtime': minor
'@server-driven-impact/postgres': minor
---

Accept Standard Schema v1 query inputs and infer `engine.query()` input and output types from Query definitions through typed `q.*` builders.

Send the PostgreSQL command preamble (session lock, collector table, BEGIN, request settings) and the read preamble as one simple-protocol round trip, and set `search_path` once per read transaction. Observed command SQL calls drop from eight to five for a single statement.
