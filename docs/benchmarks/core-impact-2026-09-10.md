# Core impact benchmark — 2026-09-10

Command: `pnpm benchmark:core`

Environment: Apple Silicon macOS, Node.js 25.8.0. Each case uses 100 write facts and 30 measured samples after one warm-up. Times are local evidence, not a performance SLA.

| Endpoints | Before p50 | After p50 | After p95 | Result |
| ---: | ---: | ---: | ---: | --- |
| 1 | 3.00 ms | 0.40 ms | 0.54 ms | narrow selectors |
| 32 | 76.61 ms | 11.40 ms | 13.62 ms | narrow selectors |
| 128 | 366.61 ms | 8.27 ms | 10.04 ms | byte budget widens all targets |

The change indexes reads by resource, deduplicates selectors with canonical-key sets, and stops detailed selector construction once the detail payload alone proves that the impact byte budget will be exceeded.
