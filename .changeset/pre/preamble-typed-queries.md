---
'@server-driven-impact/runtime': minor
'@server-driven-impact/postgres': minor
---

Accept Standard Schema v1 query inputs and infer `engine.query()` input and output types from Query definitions through typed `q.*` builders.

Send the PostgreSQL command preamble (session lock, collector table, BEGIN, request settings) and the read preamble as one simple-protocol round trip, and re-send `search_path` only when a plan's value differs from the one in effect, so a read transaction whose plans all share one search path sends it once. Observed command SQL calls drop from eight to five for a single statement.

Typed queries are a type-level breaking change for three existing patterns. A Query whose `input` does not narrow — the `parse(value: unknown): Input` style — now types its `engine.query()` argument as `object` rather than `unknown`, and an untyped `q.select('todos')` resolves to `unknown[]` rather than `unknown`; `interface`-declared inputs and row casts such as `(await engine.query(...)) as Todo[]` both keep compiling, but a value that is not an object no longer type-checks as an input. `q.choose`'s callback tightens from `(input) => string` to `(input) => keyof C & string`, so returning an unregistered name is now a compile error instead of a runtime `Unregistered query choice`. `q.call` no longer takes its output type from an annotation: `const plan: Plan<Todo[]> = q.call('todos.byStatus')` fails, and the output type must be passed as an argument — `q.call<Todo[]>('todos.byStatus')`.
