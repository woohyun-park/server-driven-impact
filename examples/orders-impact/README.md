# Independent orders domain

`domain.ts` configures `orders` / `order_items`, tenant scope, customer selectors and a tracked cascade. It registers list, detail with nested items, ready orders, and total amount queries. It imports only the public `@server-driven-impact/core`, `@server-driven-impact/runtime`, `@server-driven-impact/postgres`, and `@server-driven-impact/sqlite` package boundaries.

`demo.ts` exercises a customer move: both customer lists are impacted and another tenant receives no targets. `pnpm check:sdi:pack` builds and runs this example in an external temporary folder with only the four packed packages installed.

The PostgreSQL integration suite creates a disposable `sdi_test_*` schema in the existing local test database, grants the dedicated RLS role access, and removes that schema in teardown. `pnpm local:test:sdi` tests creation, movement, child cascade, aggregate changes, empty queries, predicates, ordering, rollback, savepoints, deferred constraint failure and RLS, including a fixed-seed before/after query-result oracle. It never resets app data or changes production.
