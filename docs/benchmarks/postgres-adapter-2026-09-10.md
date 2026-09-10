# PostgreSQL adapter benchmark — 2026-09-10

Command: `pnpm benchmark:postgres`

Environment: PostgreSQL 18.6 Docker on Apple Silicon macOS, postgres.js 3.4.8, 30 samples after two warm-ups. Explicit catalog validation is outside the samples. Times are local evidence, not a performance SLA.

| Changed rows | Native p50 | Broad observer p50 | Narrow observer p50 | Max SDI response |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 1.711 ms | 6.951 ms | 5.400 ms | 140 bytes |
| 1,000 | 2.303 ms | 5.167 ms | 5.099 ms | 117 bytes |
| 10,000 | 14.718 ms | 21.326 ms | 19.355 ms | 117 bytes |

The debug counter observed zero reverse business-table SELECTs. The adapter adds a roughly 3-5 ms median fixed cost in this environment, while 10,000-row observation stayed bounded in response size. Tail latency varied substantially under the local Docker run, so the benchmark reports p95/p99 in its JSON output at `.local/runtime/postgres-release/benchmark.json` for diagnosis.
