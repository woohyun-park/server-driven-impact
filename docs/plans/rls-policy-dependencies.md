# RLS policy dependency precision

Approved scope: select policies by command and effective role; analyze USING separately
from WITH CHECK; retain column and row dependencies independently; share analysis
between compilation and validation. Preserve conservative fallbacks and existing
custom resolvers. No push, release, or application workaround removal is included.

Branch: `fix/rls-policy-dependencies`, based on `1f18100`.

Implementation:
- Add shared policy analysis for SELECT and locking SELECT, role inheritance,
  owner/BYPASSRLS/FORCE RLS, SQL helpers and security-definer context.
- Carry precise same-row columns and unconditional external-row dependencies through
  the resolver into the compiler and validator. Unknown resources require rejection
  or no-store; broad columns alone cannot cover an unknown function body.
- Record an optional effective role in the catalog stamp and verify it after setup.
  Keep role-unspecified consumers conservative. Reuse catalog fingerprints.
- Keep permissive/restrictive references as a conservative union; no Boolean
  simplification or new caller-binding inference in this change.
- Verify badge UPDATE-only policies, USING/WITH CHECK isolation, roles, policy
  combinations, SQL helpers, INSERT/DELETE, drift and plain-table precision.

Verification: focused tests, typecheck, full unit suite, PostgreSQL 14–18 with
postgres.js and pg. Compare actual query results before/after writes with impacts.

Status: implemented and verified on 2026-09-10. Changes remain local on the task branch.

Completed checks:
- `pnpm typecheck`: passed (includes package builds).
- `pnpm exec vitest run --config sdi.vitest.config.ts`: 120 passed; 68 DB-dependent
  cases skipped without PostgreSQL settings and covered by the dedicated matrix.
- `pnpm test:matrix`: PostgreSQL 14–18 × postgres.js/pg, 74 passed and zero skipped
  per combination (740 executions). Includes actual SELECT/ImpactSet comparisons,
  definer/structured/native composition, role inheritance and FORCE RLS.
- `pnpm pack:check`: passed public API and isolated consumer installation checks.
- `git diff --check`: passed. Task-created PostgreSQL containers cleaned up.

Application follow-up: regenerate/install artifacts with the actual `effectiveRole`,
then measure the 38-target example and remove only proven redundant closure entries.
No application repository was changed.

Release follow-up: the user authorized deployment. Publish the fixed SDI package
group as 0.4.1 through the repository's verified GitHub Actions `latest` workflow.
