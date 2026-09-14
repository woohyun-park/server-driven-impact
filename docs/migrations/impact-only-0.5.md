# Impact-only 0.5 migration

SDI 0.5 narrows its public responsibility to observing committed database writes and returning a logical `ImpactSet`. Client cache keys and invalidation execution belong to the consuming application.

## Package changes

The published package set is now:

- `@server-driven-impact/core`
- `@server-driven-impact/runtime`
- `@server-driven-impact/postgres`
- `@server-driven-impact/sqlite`

`@server-driven-impact/cache-contract` and `@server-driven-impact/tanstack-query` are retired. Remove them from application dependencies. `createImpact()` no longer accepts `cacheContracts` or `cacheInvalidationOptions`, and `command()` no longer accepts a third argument.

```ts
const { data, impact } = await engine.command(context, work);

// Translate logical targets at the application boundary.
for (const target of impact.targets) {
  invalidateApplicationQueries(target);
}
```

`ImpactSet` does not prescribe TanStack Query keys, GraphQL documents, Apollo entity IDs, or another cache's representation. An application can match `target.endpoint`, `target.scope`, and `target.selector` against whichever query registry it owns.

## Server-owned input normalization

The default input relation is `preserve`. When a plan binds an input field to a database selector, parsing must preserve the raw scalar value. This keeps the dependency SDI calculated aligned with the query SQL executed.

```ts
const queries = defineQueries({
  'profiles.byUsername': {
    input: z.object({ username: z.string() }),
    plan: q.select('profiles', {
      where: [q.eq('username', q.input('username'))],
    }),
  },
});
```

If normalization is deliberately server-owned, declare the relationship opaque:

```ts
const queries = defineQueries({
  'profiles.byUsername': {
    input: z.object({ username: z.string().trim().toLowerCase() }),
    inputRelation: 'opaque',
    plan: q.select('profiles', {
      where: [q.eq('username', q.input('username'))],
    }),
  },
});
```

The query still executes with the normalized value. Its manifest no longer claims that the caller's raw input identifies the rows read, so matching mutations return `{ selector: { kind: 'all' } }` for this endpoint. This is safe and keeps the normalization rule out of the frontend.

Identity `q.call()` paths carry preservation checks through nested queries. An opaque callee or an explicit input mapper ends that identity relationship and widens dependencies below that point.

## Error changes

`ImpactUnavailableError` now only represents post-commit impact calculation failure. It retains `data`, `code`, `commitState`, and `impactStatus`; cache-compilation `phase` and partial `impact` fields were removed.
