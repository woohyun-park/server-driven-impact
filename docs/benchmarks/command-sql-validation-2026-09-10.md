# Command SQL validation cache benchmark

## Decision

Do not add a validation cache in 0.3.0. The measured warm parse median was 0.0113 ms, while the smallest observed SDI command median was 5.388 ms. Eliminating warm validation entirely would improve that command by at most about 0.21%, below the preselected 5% whole-command threshold.

## Fixed criteria

- Measure parser-only and full Command costs separately.
- Measure cold parser startup in new processes and warm p50/p95 after warm-up.
- Add a cache only if a representative repeated Command improves by at least 5% in p50 or throughput, p95 regresses by no more than 5%, and miss/eviction workloads regress by no more than 5%.
- If added later, keep it inside a validator instance tied to its parser version and validation rules. Key exact SQL UTF-8 bytes, cache successful validation only, and bound both entries and retained key bytes.

## Results

Environment: Node 25.8.0, `@pgsql/parser` 1.5.0 with PostgreSQL 18 grammar, PostgreSQL 18.6 Alpine/aarch64, and postgres.js 3.4.8. Parser measurements used 1,000 warm samples after warm-up and 20 new-process cold samples.

| Measurement | p50 | p95 |
| --- | ---: | ---: |
| New-process import and first validation | 17.455 ms | 20.752 ms |
| Warm validation, identical UPDATE | 0.0113 ms | 0.0242 ms |
| Full observed Command, one-row narrow UPDATE | 5.388 ms | 5.827 ms |
| Full observed Command, one-row broad UPDATE | 6.719 ms | 10.276 ms |

Cold startup occurs before a repeated statement can produce a cache hit. A cache would add state, eviction work, retained strings, and an invalidation contract without meeting the whole-command threshold.

Reproduce parser measurements after building with `node scripts/backend/benchmark-sdi-command-sql.mjs`. Full PostgreSQL measurements use `node scripts/backend/benchmark-sdi-postgres.mjs` with isolated loopback admin and runtime URLs. Generated JSON is written under `.local/runtime/postgres-release/`.
