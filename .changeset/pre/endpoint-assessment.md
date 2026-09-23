---
"@server-driven-impact/core": minor
"@server-driven-impact/runtime": minor
"@server-driven-impact/postgres": minor
"@server-driven-impact/sqlite": minor
---

Breaking: remove public protocolVersion fields from QueryManifest and ImpactSet; return endpoint assessments and committed command results. Validation now returns cached reports without blocking write attempts; explicit validation refreshes snapshots. Replace flat targets and ImpactUnavailableError handling with per-endpoint verified, conservative, or unavailable handling on every response. Preserve unknown commit errors and pre-commit rollback guarantees.
