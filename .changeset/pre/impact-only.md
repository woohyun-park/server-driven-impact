---
'@server-driven-impact/core': minor
'@server-driven-impact/runtime': minor
'@server-driven-impact/postgres': minor
'@server-driven-impact/sqlite': minor
---

Focus SDI on deterministic committed-write impact calculation and the logical `{ data, impact }` command result. Remove cache-key contracts, client-cache execution, and the cache-specific command output.

Add `inputRelation: 'preserve' | 'opaque'` to Query definitions. Preserve rejects parser changes to selector-bound scalar inputs; opaque permits server-owned normalization and widens the endpoint selector by removing its input bindings.
