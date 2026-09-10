# Server-Driven Impact protocol 1

This specification describes the first TypeScript reference implementation. It is not an international standard or a claim of support for other languages. Schemas describe JSON shape; resource registration and budgets add semantic validation. The fixtures are executed by the reference implementation's test suite.

## Facts, manifest and output

A WriteFact records a resource, operation, before/after row state, and changedColumns. `absent` means no row existed on that side; `unknown` means its previous/current values cannot be established. `known` contains an internal scope scalar and selected fields by actual database column name. Missing fields are not null. UPDATE with `changedColumns: []` is a known no-op for read dependencies; `null` means unknown change information. Insert/delete never use UPDATE-only column pruning.

A QueryManifest contains `protocolVersion: 1` and endpoint `reads`. Each read names a registered resource, columns (`*` or an array), and equality bindings from database columns to endpoint input fields. Optional derived `sources` / `dependents` aid inspection; `reads` is authoritative. No callbacks are serialized. The application may store a build-time graph hash alongside this manifest; it is not a database revision or impact version.

An ImpactSet contains `protocolVersion: 1` and targets. Each target names an endpoint, `caller` or `global`, and a selector. `all` covers every input; `inputs.values` is a disjunction of partial input objects. Each object is a conjunction of scalar equality tests. A cached input with a missing field conservatively matches; explicit null only equals null. Cache entries need not have existed or executed when impact is calculated.

## Reference calculation

For every before/after row that is not absent:

1. For a scoped resource, known scope unequal to the verified caller is excluded. Unknown scope is conservatively eligible for the caller. A resource with `scopeColumn: null` produces global targets.
2. Find reads of that resource. A known UPDATE disjoint from all read columns may be excluded. A changed scope column prevents this pruning because visibility can change.
3. Copy known captured equality binding values into an input conjunction. Missing values leave fewer constraints; unknown rows leave none. Conflicting bindings for one input widen. No remaining constraints means all inputs.
4. Union targets by endpoint/scope; deduplicate canonical input objects. `all` dominates narrower selectors. Both OLD and NEW participate so moves cover their old and new input ranges.
5. More than 100 alternatives widens that endpoint/scope. More than 128 KiB of encoded impact widens all present targets. Endpoint identifiers are never silently dropped.

Selectors describe possible staleness. They do not assert a cached result actually changed. Columns from WHERE, ORDER and JOIN membership count as reads even if not projected. Both conditional branches are registered. Multiple paths that read one resource are alternatives; their bindings must not be combined into an invented conjunction. Arbitrary call/bind input mapping cannot safely be inverted and clears child equality bindings. Queries must use the registered plan executor and authorization rules must be expressible by the declared scope/reads. The PostgreSQL catalog resolver expands supported views, SQL functions and RLS policies. An unregistered leaf relation fails activation unless explicit catalog discovery adds an ordinary table as a global broad resource. A tenant scope is never inferred from catalog names or columns.

## JSON and canonicalization

Values are JSON scalars: string, finite number, boolean, null. Date objects, BigInt, undefined and nonfinite numbers are not coerced. PostgreSQL date/time fields must be returned as strings. Canonical objects sort property names by UTF-16 code unit ordering, arrays preserve order, and primitives use JSON encoding. Target and input-array order is deterministic under that encoding. Missing keys remain absent. This encoding is deterministic for the supported JS scalar range; an SDK in another language must match ECMAScript number serialization and string ordering for byte-for-byte canonical identity.

## Memory, transaction and publication

The buffer belongs to one transaction. At most 200 detailed facts or 128 KiB are retained. On overflow all buffered facts become one unknown fact per resource (maximum 128 resources). This deliberately loses exact owner/selector detail while conservatively covering the current caller. It does not enumerate other owners. Input/output snapshots are copied; a closed context rejects additions. The PostgreSQL collector applies row and byte limits before detailed fact return. Its internal CTE still visits all business rows; memory/metadata bounds are not limits on database execution work.

The driver adapter owns the transaction and resolves only after COMMIT. Rollback and commit errors reject with no successful impact response. A savepoint has a child buffer merged after RELEASE; rollback discards it. All business operations must be awaited. Concurrent overlapping savepoints, writes on another connection, transaction pooling, and using a context after the Command are unsupported. There is no automatic retry, idempotency key, journal, version row, outbox or durable response record.

Registration validates table identifiers, columns, cascades, at most 128 resources, 512 endpoints, and 1 MiB of manifest data without accessing the database. The fully widened response must fit 128 KiB, otherwise engine creation fails. Each explicit `engine.validate()` call checks PostgreSQL table columns, identities, RLS dependencies, routines, catalog fingerprints, partition/inheritance topology and observer definitions at that point in time. Query and Command never invoke this full catalog validation implicitly. Applications decide when to validate and must control later database definition changes. Native writes, supported Trigger/FK effects, COPY and TRUNCATE are observed by database Trigger coverage. Materialized views require the explicit refresh operation. Time, random, sequence and session-state dependencies require a separate freshness policy and do not silently become empty reads.

`scope` is metadata filtering, not authorization. The app verifies identity and sets RLS and transaction settings. Row facts, tenant IDs and the full dependency graph stay server-side. Only current-caller/global targets travel in responses. An old scope cannot receive another request's private values; scope movement does not broadcast to another device or tenant.

## Consumers and diagnostics

SDI stops at producing the ImpactSet. An application may map its targets to an HTTP response, a message, or a cache library, but that transport and cache integration is outside the SDI package. Routine keeps its TanStack Query coordinator in the mobile application and owns its batching, selector matching, session cleanup, and late-fetch protection there.

Unknown protocol versions are not accepted as version 1: the adapter emits `unsupported-version` and conservatively stales current-scope endpoint caches. Malformed targets or unknown endpoint IDs similarly widen with diagnostics. Unknown/malformed selectors widen the named endpoint. No diagnostic response contains original facts. `engine.explain()` records decisions from the exact calculator path and does not run a second approximation.

The runtime returns `{data, impact}` and the `impact` value is an ImpactSet. Routine's application-owned compatibility facade maps its targets to the existing `affected` transport response and keeps `contractVersion: 1`. Transport envelopes, cache mutation, realtime delivery, other devices, lost responses and server-cache freshness remain outside this version.

## Correctness oracle

For every supported endpoint and fixed input, if its result differs between pre-write and post-commit snapshots, the committed ImpactSet must contain a target whose selector matches that input. Overinvalidation is allowed. The orders tests execute actual SQL around fixed-seed writes, plus explicit empty→insert, joins, aggregates, old/new customer ranges, cascade, rollback, constraint failure and tenant cases. Pure tests cover null/number/boolean/missing/unknown values and count/byte overflow. Routine's existing integration and RPC parity tests protect its app-specific behavior.
