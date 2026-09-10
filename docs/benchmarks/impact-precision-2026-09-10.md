# Impact precision benchmark — 2026-09-10

This local comparison measures the cost and retained selector precision of the core calculator changes in `feat/transaction-impact-contract`. It does not measure database observation, mutation execution, transport, or frontend cache work.

## Reproduction and environment

- Script: `scripts/backend/benchmark-sdi-core.mjs`.
- Command: `SDI_BENCHMARK_SAMPLES=10 node scripts/backend/benchmark-sdi-core.mjs`.
- Baseline: commit `c24e226986dab01215cf0c7c7914ca80dabfa1b0`, using the existing built core package in the separate `server-driven-impact-transaction` worktree. The baseline worktree was not modified or rebuilt for this comparison.
- Current: the same base commit plus the uncommitted core changes in `feat/transaction-impact-contract`, rebuilt before measurement.
- Machine: Apple M5 Pro, 15 logical CPUs, 24 GiB memory; macOS/Darwin 25.6.0, arm64; Node v25.8.0.
- Dataset/seed: deterministic construction, no random seed. One scoped resource, 100 inserted facts with category values `category-0` through `category-99`, and 1, 32, or 128 registered endpoints. Every endpoint reads the category binding.
- One warm-up calculation per endpoint count, then 10 measured calculations. Current and baseline ran sequentially in separate Node processes. Other development processes were running on the machine.

## Results

| Endpoints | Baseline p50 / p95 (ms) | Current p50 / p95 (ms) | Baseline bytes | Current bytes | Baseline broad targets | Current broad targets |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 0.49 / 0.80 | 0.50 / 0.94 | 2,806 | 2,806 | 0 | 0 |
| 32 | 11.35 / 13.27 | 11.08 / 12.93 | 88,791 | 88,791 | 0 | 0 |
| 128 | 6.99 / 10.24 | 23.57 / 29.17 | 9,011 | 130,691 | 128 | 83 |

At 1 and 32 endpoints, both implementations retain identical detail and the measured medians are similar. At 128 endpoints, the baseline widens every endpoint once the shared byte budget is exceeded, then stops maintaining selector detail. The current implementation widens individual endpoint/scope targets as needed and retains all 100 alternatives for 45 endpoints. It therefore spends more CPU and response bytes to preserve useful precision, while remaining under the 131,072-byte response limit and retaining every endpoint.

These ten-sample results are a local characterization, not a fixed latency promise or a production capacity estimate. Node 22/24 package compatibility and actual database costs require their separate validation. The 128-endpoint results compare different output precision; the baseline's lower latency is not an equivalent-output performance target.

## Correctness and precision checks

The focused run passed **44 tests across 3 files**:

```sh
pnpm exec vitest run --config sdi.vitest.config.ts \
  tests/server-driven-impact/core-precision.test.ts \
  tests/server-driven-impact/core.test.ts \
  tests/server-driven-impact/transaction.test.ts
```

The new regressions verify independent resource detail under WriteSet overflow, common OLD/NEW customer ranges and scopes, changed-column unions, bounded encoded fact size, exact subset deduplication, endpoint-local byte widening, shared constraints at the selector-count limit, byte reclamation after subsumption, and calculation after final commit/drain. A small resource arriving after another resource fills the buffer continues to retain its subsequent detailed facts.

The core package typecheck and a focused TypeScript check of the new regression file also passed. This report is limited to those core checks; repository-wide database and packaging results are recorded with the implementation plan.
