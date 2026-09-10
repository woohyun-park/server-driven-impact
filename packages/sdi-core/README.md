# @server-driven-impact/core

[English](./README.md) | [한국어](./README.ko.md)

Database-neutral contracts and the pure `ImpactSet` calculator for Server-Driven Impact.

```bash
pnpm add @server-driven-impact/core
```

```ts
import { calculateImpact, type ImpactManifest, type ImpactResources, type WriteFact } from '@server-driven-impact/core';

const resources: ImpactResources = {
  todos: { scopeColumn: 'account_id', columns: ['id', 'account_id', 'status'] },
};
const manifest: ImpactManifest = {
  protocolVersion: 1,
  reads: {
    'todos.byStatus': [{
      resource: 'todos', columns: ['id', 'status'],
      bindings: [{ column: 'status', input: 'status' }],
    }],
  },
};
const writes: WriteFact[] = [{
  resource: 'todos', operation: 'update',
  before: { kind: 'known', scope: 'account-a', fields: { status: 'open' } },
  after: { kind: 'known', scope: 'account-a', fields: { status: 'done' } },
  changedColumns: ['status'],
}];

console.log(calculateImpact(writes, { resources, manifest, scope: 'account-a' }));
// Includes todos.byStatus for both {status: "open"} and {status: "done"}.
```

`WriteFact` describes a committed database write. `ImpactSet` conservatively describes which registered query inputs may now be stale. This package performs no I/O and has no database driver or frontend dependency. Most backend applications use it through `@server-driven-impact/runtime` and an adapter.

For diagnostics, `createImpact({ resources, manifest })` creates a reusable calculator whose `explain(writes, scope)` method returns the same `ImpactSet` together with the decisions made by the exact calculation path. This method belongs to the core calculator; the runtime engine does not expose `explain()`.

Node.js 22.18 or newer is required.
