---
'@server-driven-impact/postgres': minor
---

Run PostgreSQL Query, Command, and catalog validation through one transaction-pool-compatible database. Commands now force deferred work, drain observations, and seal the observer before COMMIT, and no longer require session affinity or post-COMMIT SQL.
