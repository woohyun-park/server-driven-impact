# PostgreSQL observer cost: 0.3 baseline → 0.4 candidate

2026-09-10. Local PostgreSQL 18.6, postgres.js 3.4.8, Node 25.8.0. Baseline source is isolated `git archive c24e226`; current candidate uses observer protocol 9. Each scenario has two warmups and 10 timed samples. Same loopback Docker instance, sequential baseline/current runs, fixed 1/1,000/10,000 row increments. Full artifact validation is outside timings.

| Rows | Mode | Baseline p50 / p95 ms | Candidate p50 / p95 ms | Candidate response bytes |
| --- | --- | --- | --- | --- |
| 1 | native | 1.49 / 1.587 | 2.115 / 2.668 | 2 |
| 1 | broad | 15.42 / 75.26 | 8.989 / 12.522 | 117 |
| 1 | narrow | 8.004 / 10.611 | 13.258 / 17.586 | 140 |
| 1000 | native | 4.225 / 5.412 | 5.022 / 9.616 | 2 |
| 1000 | broad | 8.807 / 10.778 | 14.986 / 18.866 | 117 |
| 1000 | narrow | 8.138 / 38.795 | 11.983 / 22.941 | 117 |
| 10000 | native | 23.571 / 46.411 | 33.648 / 57.21 | 2 |
| 10000 | broad | 27.422 / 54.067 | 44.563 / 63.479 | 117 |
| 10000 | narrow | 28.797 / 45.864 | 54.732 / 159.576 | 117 |

Timed inverse/business SELECT calls: baseline 0, candidate 0. Both runs assert zero. Native control drift between runs and p95 from only 10 samples limit causal interpretation. This measures a local scenario, not an SLA or proof of universal improvement.

Final candidate measured at `2026-09-10T11:25:34.581Z`. Native control p50 also rose from 23.571 to 33.648 ms for 10,000 rows, so the observed difference cannot be attributed solely to the implementation.

Large transition batches now aggregate common scope/binding values instead of immediately returning unknown facts. A single-column primary key cannot be common across a batch, so that unnecessary aggregate is skipped; batches with no remaining scope or observed values skip the aggregate scan. This can add DB work even when this id-per-row fixture has no common binding to preserve. The separate observer precision conformance proves the gained common-customer selector on homogeneous batches; this cost fixture checks that exact same native mutation still commits without impact misses. See [ORM/native breakdown](./orm-impact-2026-09-10.md) for query counts, connection hold time and contention, and [core precision costs](./impact-precision-2026-09-10.md) for output precision tradeoffs.

Reproduce each checkout with `SDI_POSTGRES_ADMIN_URL` and `SDI_POSTGRES_RUNTIME_URL` pointing to an isolated loopback DB and `SDI_BENCHMARK_SAMPLES=10 node scripts/backend/benchmark-sdi-postgres.mjs`. The script creates and cleans its own schema. Raw runs are in `.local/postgres-baseline-output.json` and `.local/postgres-current-output.json`.
