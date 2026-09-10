# SDI 0.4 transaction impact migration

This release completes the mutation → observed WriteSet → narrowed ImpactSet → frontend response path on top of 0.3. It keeps protocol 1. Upgrade core, runtime and adapters together; the adapters require the 0.4 runtime's native statement guard. Existing 0.1 CRUD migration instructions remain in [postgres-0.2.md](./postgres-0.2.md).

## What changes

- Core command helpers calculate after the adapter has completed final COMMIT and observer drain. Post-commit calculation failures are `ImpactUnavailableError` from both core and runtime, with saved `data` and `commitState: 'committed'`.
- WriteSet overflow summarizes the affected resource first, retaining bounded common OLD/NEW scope and fields. It preserves unrelated small writes where the shared budget allows. Selector overflow retains shared input constraints; response byte overflow widens individual endpoint/scope targets.
- PostgreSQL's observer protocol is now 9. Large transition batches preserve common bindings; collector pressure compacts the largest affected resource rather than all resources. Repeated-statement collector compaction may still lose that resource's detail. Reapply generated observer migrations and regenerate Query artifacts, then `engine.validate()` before serving requests.
- Native SQL artifacts can automatically exclude unrelated-column updates only when catalog resolution proves a direct table has no hidden rule/policy reads. Native SQL input bindings still widen where driver parameter/observer codec equivalence is unproven. `q.count` no longer registers unused projection/order/optional joins.
- Query Plan literal equality conditions add optional `ReadDependency.filters`. Observers attach `RowState.equalityFields` only for certified comparisons; the calculator ignores regular binding fields for this exclusion. Unknown, missing, mixed-type, fractional or unsafe numeric comparisons widen. PostgreSQL certifies built-in text/varchar, boolean and integer fields; temporal/custom/float fields stay broad. SQL literal filters are not inferred. New manifest/fact schemas require the 0.4 tooling; frontend ImpactSet protocol 1 is unchanged.
- Literal-filter exclusion activates only after successful `engine.validate()`. Resources affected by hidden RLS/rules keep conservative comparison behavior. Hidden RLS row dependencies require a global resource with an unconditional `columns: '*'`, unbound read per endpoint; validation rejects unsupported column/input/scope assumptions instead of returning incomplete impacts.
- No application mutation needs to manually append WriteFacts or enumerate invalidated queries. Resource/Query registration remains necessary.

## Native APIs

| Adapter | Command client | Supported boundary |
| --- | --- | --- |
| postgres.js 3.4.8 | callable tagged template, `.unsafe(text, values)`, `.query(text, values)`, existing `.execute(Sql)` | Tagged/unsafe queries are lazy and expose then/catch/finally/execute/cursor. This is a scoped subset, not the entire postgres.Sql helper/connection API. |
| pg 8.16.3 | `.query(text, values)` or `.query({text, values?, name?, rowMode?, types?}, values?)`, existing `.execute(Sql)` | Promise-based QueryResult, per-query codecs and array rows preserved. Callback/submittable queries, arbitrary connection methods and other config options are not exposed. |
| node:sqlite | `.prepare(text).run/get/all`, existing `.execute(text, values)` | Prepared methods are synchronous and return native results. Statements close with the command/savepoint. Other StatementSync/DatabaseSync methods are not exposed. |

Existing COPY, cursor, savepoint and materialized-view refresh methods remain. Transaction control SQL, observer/token manipulation and connection release are not permitted through the command client. Every operation must finish before the callback resolves. Merely constructing a lazy query does not execute it; executing it later rejects.

All supplied SQLite engines sharing one managed DatabaseSync connection are serialized. Their observer configuration is switched before commands. Do not execute directly on the raw DatabaseSync connection while a command is active; arbitrary external use of that object cannot be intercepted by the adapter. SQLite TEMP observers are connection-local and reserved collector tables cannot be accessed through command SQL.

## Optional ORM adapters

Import only the adapter you use. Neither core/runtime nor the SQLite-only and plain PostgreSQL subpaths load ORM dependencies.

```ts
import { drizzleAdapter } from '@server-driven-impact/postgres/drizzle';
const engine = createImpact({
  resources, queries,
  adapter: drizzleAdapter({database: pool, drizzle: {schema}, setup}),
});
const response = await engine.command(context, tx => repository.move(tx, id, customer));
```

Install `drizzle-orm@0.45.2` and `pg@8.16.3`. Drizzle query builders and prototypes remain intact; the actual driver execution is guarded. `.transaction(callback)` and `.savepoint(callback)` use the same SDI savepoint. Nested transaction configuration is rejected; configure isolation on the outer adapter. Drizzle's optional query cache is not configured by this adapter. Drizzle 0.45.2's upstream declaration graph requires `skipLibCheck` with TypeScript 6; the consumer's own code remains typechecked.

```ts
import { prismaAdapter } from '@server-driven-impact/postgres/prisma';
const engine = createImpact({
  resources, queries,
  adapter: prismaAdapter({
    database: pool, setup,
    createClient: adapter => new PrismaClient({adapter}),
  }),
});
const response = await engine.command(context, client =>
  client.order.update({where:{id}, data:{customerId:customer}}),
);
```

Install matched `@prisma/client`, `@prisma/adapter-pg`, `@prisma/driver-adapter-utils` 7.10.0 and pg 8.16.3; generate your model with Prisma 7.10.0. `createClient` must create a client using the supplied adapter. SDI creates/disconnects that client per command. Prisma's nested writes and interactive transactions use SDI savepoints; Prisma transaction-level isolation overrides and overlapping savepoints are rejected. See the [public-API experiment](../research/prisma-transaction-feasibility.md).

## Frontend response

Return the business result and `impact` from the successful command. Keep WriteSet, OLD/NEW rows and the full dependency graph server-side. The [orders consumer example](../../examples/orders-impact/consume-impact.ts) selects affected inputs in the current signed-in frontend session. The [Drizzle repository](../../examples/orders-impact/drizzle-repository.ts) demonstrates injected transaction clients and JOIN/RETURNING.

Only caller/global targets are returned. Scope metadata does not provide authentication or broadcast updates to another tenant/device. The app owns HTTP serialization, cache mutation and stale in-flight request handling. An impact failure after commit is not a reason to automatically replay the mutation.

## Routine handoff (read-only inspection)

The local Routine checkout's package.json does not depend on the published SDI packages. It contains an embedded predecessor under `supabase/functions/_shared/backend`: `infrastructure/trackedDb.ts`, `impact/writeSet.ts`, `runtime/runtime.ts`, and domain functions for todos/routines/runs/saveDefinition. These are not automatically updated by an SDI package version bump.

A separate Routine migration should replace its transaction owner with an SDI engine, pass the command's native client into business functions, translate tracked select/require/insert/update/delete to SQL or the chosen ORM, preserve business conflict/authorization checks, register existing Query dependencies, install observers, and verify the existing parity fixtures. Keep caller authentication/RLS setup and response error handling explicit. This task does not change or deploy Routine.
