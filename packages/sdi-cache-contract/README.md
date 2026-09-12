# @server-driven-impact/cache-contract

[English](./README.md) | [한국어](./README.ko.md)

Defines a versioned relationship between SDI endpoints, OpenAPI operations, normalized inputs, and cache keys. It converts an `ImpactSet` into data-only invalidation instructions; it does not inspect a browser cache.

```ts
import { buildQueryKey, defineCacheContract } from '@server-driven-impact/cache-contract';

const contract = defineCacheContract({
  id: 'company-api', version: 1,
  queries: [{
    operationId: 'getOrder', endpoint: 'orders.detail', kind: 'query',
    input: {id: {type: 'string', required: true, exclude: ['list']}},
    key: {prefix: ['orders'], path: ['id']}, fallback: ['orders'],
  }],
});

buildQueryKey(contract, 'getOrder', {id: 'one'}); // ['orders', 'one']
```

Use `cacheContractOpenApiExtension(contract)` as the value of a root-level `x-sdi-cache` extension. Generated clients send `{id, version}` with mutations. On the server, `createCacheContractRegistry()` rejects unsupported versions and `compileCacheInvalidations()` returns `{contractId, contractVersion, scope, invalidations}`.

Every result-affecting identity input must be declared and represented in the key. Unknown input fields are rejected, not dropped. Flat `prefix/path/params` and recursive declarative templates are supported. `fallback` must be a TanStack partial key proven to cover every generated key. Potentially colliding query/infinite templates are rejected.

For a key such as `['orders', 'list', params]`, use `paramsAnchor` only when input validation guarantees those fields whenever the params object exists. This proof lets protocol-1 missing-field matching preserve a narrow partial key; otherwise conversion safely widens to `fallback`.

## Nested keys and inputs

No oRPC dependency or application-specific compiler is needed for its key shape:

```ts
const rpc = defineCacheContract({
  id: 'rpc', version: 1,
  queries: [{
    operationId: 'profile', endpoint: 'profile.read', kind: 'query',
    input: {userId: {type: 'string', required: true}},
    key: {template: {kind: 'array', items: [
      {kind: 'literal', value: ['data', 'profile', 'read']},
      {kind: 'object', fields: {
        input: {kind: 'inputs'},
        type: {kind: 'literal', value: 'query'},
      }},
    ]}},
    fallback: [['data', 'profile', 'read'], {type: 'query'}],
  }],
});
// [['data', 'profile', 'read'], {input: {userId: 'user-a'}, type: 'query'}]
buildQueryKey(rpc, 'profile', {userId: 'user-a'});
```

Nodes are `literal`, `input` (one top-level field, including a structured value), `inputs` (all or named fields), `object`, and `array`. An omitted optional object field is absent; null remains null. Use `inputs.omitEmpty` when an empty input object should be absent. Optional array elements must not shift positions.

Recursive fields use `{type:'array', items:..., order:'preserve'|'set'}` and `{type:'object', properties:...}`. Arrays preserve order and duplicates by default; explicit `set` deduplicates and sorts by canonical JSON. Object property ordering does not affect identity; unknown nested fields are rejected. Optional fields stay absent unless a default is declared; null requires `nullable:true`. Dates require an explicit timezone and become ISO UTC. `format:'uuid'` validates and lowercases strings.

Use `prepareCacheQuery(contract, operationId, input)` and send its **input** to the API while using its **queryKey**. `normalizeCacheInput` is also exported. Do not normalize only the key when the request's meaning would differ. Preserving existing keys requires choosing normalization that matches the existing API.

Infinite operations use a separate literal such as `type:'infinite'` and may declare `pageInput` alongside identity `input`. `buildQueryExecutionInput(contract, operationId, identity, page)` merges both normalized inputs for the request; `buildQueryKey` rejects page-only fields. All pages share the infinite query key. Page fields in an impact widen to fallback.

## Coverage and diagnostics

`validateCacheContractCoverage(contract, [{endpoint, cache:'cacheable'|'no-store'}])` validates an inventory at startup/generation. The runtime does this automatically for **each** configured contract. Every endpoint must have a query or an explicit `excludedEndpoints: [{endpoint, reason:'no-store'|'not-consumed'}]` entry. No-store reads cannot receive reusable keys. Unknown impact endpoints throw `CACHE_ENDPOINT_UNCOVERED`; explicit exclusions alone may produce no instructions.

Pass `{explain(diagnostic), maxInvalidations, maxBytes}` to `compileCacheInvalidations`, or `cacheInvalidationOptions` to the runtime. Diagnostics contain endpoint/operation, selector field names, reason, and filter count—not user values. Reasons include `missing-field`, `comparison-unproven`, `page-input`, `input-unrepresentable`, `endpoint-policy`, and `budget`. Compare these with the returned filters when debugging; do not log raw keys in production. An explain callback must not throw; failures remain explicit post-commit errors.

Protocol 1 matches absent fields and conservatively handles database equality. Unrestricted strings can match different case/trailing-space keys, so precise conversion requires a proven domain (numbers, booleans, normalized UUIDs, or a finite `enum` with one matching value). A mere `required:true` string is not sufficient. Optional/defaulted fields generally widen. `invalidation:'endpoint'` deliberately always uses fallback. A domain prefix such as `[['data','profile']]` may be used as fallback if it covers every operation key.

The runtime automatically refines required, non-coerced string inputs when it has an unchanged input field, a direct Query equality binding, and adapter validation of the live column's exact comparison semantics. Runtime enforces the unchanged input on every request. Standalone `compileCacheInvalidations()` remains conservative because it has no runtime/database proof. Unsupported or unvalidated comparison reports `comparison-unproven`.

`paramsAnchor:['id']` is appropriate for `['orders','list',{id,page?}]` only if `{page:2}` is invalid. Key preparation enforces this. Declaring an anchor that older cached requests do not honor is unsafe: clear/migrate them first. Selecting optional `page` still widens even with an ID anchor. Anchors do not prove string comparison semantics.

Structured **key identity** does not add IN/range/nested selector inference to ImpactSet v1. Unsupported precision widens safely; it never silently removes an endpoint or truncates instructions. If even broad instructions exceed the budget, compilation throws.
