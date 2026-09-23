# Endpoint assessment (breaking change)

Commands return `{ data, commitState: 'committed', impact }` after commit. `impact` is `{ endpoints }`; every registered endpoint is present. Manifest, impact, and write-fact payloads have no version field. Versioned manifests are rejected, and there is no flat `impact.targets` compatibility path. Package versions remain in `package.json`.

| Endpoint status | Payload | Consumer action |
| --- | --- | --- |
| `verified` | `targets` | Apply targets. Empty targets prove no impact against the pinned validation snapshot and complete observation. |
| `conservative` | `codes`, `targets` | Apply the broadened safe range. |
| `unavailable` | `codes`, no targets | Invalidate this endpoint's cache or stop reusing it. |

Targets retain `scope: 'caller' | 'global'` and `selector`. Consumers must handle status on **every command response**, including repeated unavailable responses while a failed validation report is cached. The orders example demonstrates this handling. Queries keep their existing response shape; SDI adds no automatic cache deletion, cache bypass, or HTTP transport.

`engine.validate()` now returns `Promise<ValidationReport>` with endpoint assessments. A first command validates once if necessary and reuses both successful and failed reports. Explicit `validate()` performs a fresh validation and can recover unavailable endpoints. The last validation **started** selects the snapshot for subsequent commands; commands already running retain their original snapshot. Returned reports are copies and cannot mutate command policy. Validation does not detect DDL changes occurring after its snapshot.

Removing the manifest version field alone does not change the PostgreSQL observer fingerprint, which is derived from resources, reads, and catalog data. Reinstall observers only when those inputs or their installed definitions change.

Validation mismatches and validation access failures do not preemptively block writes. Invalid engine configuration, invalid manifests, and SQL execution restrictions still reject. Business SQL, observer execution, constraints, and pre-commit collection SQL failures roll back. No recovery savepoints or retries are added. Normal validated PostgreSQL commands retain their existing DB round trips.

When dependency completeness is verified, resource-local observer failures affect only dependent endpoints. Directly identified dependency failures affect those endpoints. Unknown dependency scope or global catalog drift makes all endpoints unavailable; absence from an old resource index is not evidence of safety.

Assessment precedence is `unavailable > conservative > verified`. Codes from validation, observation, and calculation are unioned, deduplicated, and sorted. Unavailable entries discard all intermediate targets. Public codes are `VALIDATION_FAILED`, `CATALOG_DRIFT`, `RESOURCE_DRIFT`, `OBSERVER_UNVERIFIED`, `PRECISION_REDUCED`, `OBSERVATION_FAILED`, and `CALCULATION_FAILED`; they carry no original SQL, DB error, or row data.

Precision loss in comparisons, bindings, column information, unknown observations, selector count limits, or byte limits is reported as conservative when completeness permits safe broadening. A query whose natural scope is `all` can still be verified. The 128 KiB budget covers the entire impact envelope, endpoint names, statuses, codes, and targets, excluding business data. Engine creation checks the worst fallback with both scopes and all reason codes. Larger selectors are widened first, counting changed statuses and codes in the resulting size; endpoints and codes are never omitted.

`ImpactUnavailableError` and `isCommitOutcomeError` are removed. Post-commit calculation failures preserve the original callback result object in `data` and return unavailable endpoints; callbacks are never rerun. `CommitStateUnknownError` remains for indeterminate commit outcomes and must not trigger automatic command replay. The pure core calculator does not validate a database: callers/adapters are responsible for complete manifests and observations.

This is a cache handling contract after commands. It does not clean existing caches when policies, RLS, or DDL change without writes. Distribution to other users, devices, or tenants, lost responses, and stale in-flight reads remain application responsibilities.

## Separate toktok-world work

SDI changes do not remove application startup checks. The app still needs to replace its policy/trigger fingerprint blocking with report handling, produce and consume the endpoint-assessment response, and handle unavailable endpoints on every response. Its proposed 6,000-character header budget is independent of SDI's 128 KiB budget: never truncate endpoint states to fit. Response-body delivery is the default proposal, pending review of the app's route/client contract. Policy-change cache cleanup and distribution require a separate operational contract. Publishing and deployment are outside this change.
