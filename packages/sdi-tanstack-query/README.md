# @server-driven-impact/tanstack-query

[English](./README.md) | [한국어](./README.ko.md)

Validates a server-owned invalidation response and applies its exact/partial union to TanStack Query in one call.

```ts
import { applyCacheInvalidations } from '@server-driven-impact/tanstack-query';

await applyCacheInvalidations(queryClient, response.cacheInvalidation, {
  contract: {id: 'company-api', version: 1}, scope: currentTenant,
});
```

The contract and request-time scope must match before the cache is touched. Matching active and inactive queries are invalidated; the default refetch target is `active`. Await the returned promise when mutation completion should include active refetch completion, or retain it separately to distinguish a committed mutation from a later refetch failure.

`@tanstack/query-core` is a peer dependency. The application owns the `QueryClient` and its cache lifecycle.

## Execution boundaries

- Matching uses TanStack's own `matchQuery`, including exact hashing and partial nested keys. Scope/version mismatch rejects before cancellation or invalidation. Payloads are bounded JSON; they contain no executable predicate.
- `refetchType` defaults to `active`; `none` only marks stale. Disabled/static queries follow TanStack's refetch exclusions. This does not guarantee all views have refreshed.
- `cancelRefetch` is forwarded to TanStack. It does **not** reliably cancel an initial fetch without cached data. By default that in-flight result may be reused and may have started before the mutation.
- Opt into `cancelInFlight:true` to call `cancelQueries` for the matching union before invalidating it. This also cancels first fetches, discards their eventual results, and permits active queries to restart. Physical network cancellation additionally requires the query function to consume its AbortSignal. Inactive/disabled reads do not automatically restart.
- `throwOnError` defaults to `true`: an awaited refetch error rejects this function, **not** the already committed business operation. `throwOnError:false` suppresses refetch errors. Cancellation due to other app activity is not proof of fresh data.

The executor does not schedule mutation callbacks, serialize concurrent commands, manage optimistic rollback, block auth responses, or clear persisted/artifact caches. Await asynchronous application callbacks **before** applying invalidations. Keep command success and callback/refetch errors in separate handling paths.

Capture the request's session generation and QueryClient. After awaiting the response and callbacks, verify that generation is still current. On logout/login—even for the same user ID—retire and clear the old client and reject its responses. Scope equality alone does not detect such a change. Artifact/contract changes require an app-owned client reset and persistence/hydration buster; no automatic cache reset is performed here.

Do not nest cache-refresh failure into a mutation retry/rollback path. A generic integration example and local prerelease instructions are in the [migration guide](../../docs/migrations/cache-contract-0.5.md). Regression tests exercise real QueryObserver first-fetch overlap both with and without cancellation.
