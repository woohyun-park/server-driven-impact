# Stored validation benchmark — 2026-09-28

Command: `pnpm benchmark:validation` with `SDI_BENCHMARK_TABLES` set to 10 and 50.

Environment: PostgreSQL 18.6 Docker on Apple Silicon macOS over loopback, postgres.js 3.4.8, 30 samples after two warm-ups. Each first-command sample binds a fresh engine, which is what a new serverless isolate does. Times are local evidence, not a performance SLA.

## Before (live validation on the first Command)

| Tables | `validate()` p50 | First Command p50 / p95 | Warm Command p50 |
| ---: | ---: | ---: | ---: |
| 10 | 25.1 ms | 34.7 / 40.3 ms | 6.3 ms |
| 50 | 98.2 ms | 107.7 / 373.2 ms | 6.1 ms |

Per `validate()` at 50 tables: one catalog-fingerprint query (12.0 ms), one catalog query per resource (50 statements, 75.7 ms), one observer trigger query (5.2 ms), and 4 other statements (3.5 ms). The per-resource round trips dominate and grow with network latency between the runtime and the database.

## After

| Tables | Stored first Command p50 / p95 | Live first Command p50 / p95 | Warm Command p50 |
| ---: | ---: | ---: | ---: |
| 10 | 4.9 / 5.8 ms | 29.1 / 39.9 ms | 5.0 ms |
| 50 | 6.3 / 7.7 ms | 81.2 / 108.6 ms | 5.5 ms |

With a snapshot recorded by the migration, a fresh engine's first Command costs the same as a warm Command: the snapshot is read in the existing preamble round trip. The live path, used when no snapshot matches, still pays full validation once per bound adapter, now inside the Command transaction instead of a separate one. JSON output is written to `.local/runtime/postgres-release/validation-benchmark.json`.

## Fresh process: command SQL parser

The measurements above reuse one Node process, so they miss a cost that only a fresh isolate pays: the first Command loads the WASM SQL parser used by the command SQL guard (about 5 ms `require`, 2 ms WASM initialization, 7 ms first parse; 0.07 ms per later parse). Live validation used to load it before the first Command. With stored validation the first Command paid it on the request path, which a consumer measured as 18–19 ms under Deno.

The adapter now starts loading and warming the parser when it is bound, so the work overlaps the first Command's connection and preamble round trips. Fresh Node process per sample, 47 tables, median of 10:

| | First Command after an explicit connect | First Command including connect |
| --- | ---: | ---: |
| Without preload | 28.8 ms | 35.3 ms |
| With preload | 12.2 ms | 28.8 ms |

Over loopback the connect has little idle time, so part of the preload still competes with it for the main thread; longer network round trips hide more of it.

## Catalog gate and self-recording

The stored snapshot is now used only while a catalog hash (the `xmin` of every catalog row validation depends on) still matches, and a live validation records its result for later processes. The live samples below delete the snapshot before each sample; otherwise the first live validation records it and every later sample takes the stored path. Same environment as above:

| Tables | Stored first Command p50 / p95 (includes the gate) | Live first Command p50 / p95 | Warm Command p50 |
| ---: | ---: | ---: | ---: |
| 10 | 4.4 / 6.0 ms | 31.1 / 43.0 ms | 3.5 ms |
| 50 | 4.5 / 5.8 ms | 61.5 / 70.7 ms | 4.0 ms |

The gate cost grows with the catalog rows of the covered schemas, not with resources. On a local Supabase database (PostgreSQL 17.6) the covered schemas were `public`, `auth`, and one observer schema, about 4,300 catalog rows. There the `xmin` hash took 10.7 ms p50 (11.3 ms p95), against 44.0 ms for hashing row contents with `to_jsonb`. Both are one statement inside the existing preamble round trip.
