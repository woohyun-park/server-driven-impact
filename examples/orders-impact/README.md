# Independent orders domain

[English](./README.md) | [한국어](./README.ko.md)

`domain.ts` configures `orders` / `order_items`, tenant scope, customer selectors and a tracked cascade. It registers list, detail with nested items, ready orders, and total amount queries. It imports only the public `@server-driven-impact/core`, `@server-driven-impact/runtime`, `@server-driven-impact/postgres`, and `@server-driven-impact/sqlite` package boundaries.

`demo.ts` exercises a customer move: both customer lists are impacted and another tenant receives no targets. `pnpm pack:check` builds and runs this example in an external temporary folder with only the four packed packages installed.

The PostgreSQL integration suite creates a disposable `sdi_test_*` schema in an isolated test database, grants the dedicated RLS role access, and removes that schema in teardown. `pnpm test:postgres` covers creation, movement, child cascade, aggregate changes, empty queries, predicates, ordering, rollback, savepoints, deferred constraint failure, and RLS. `pnpm test:matrix` runs the required suite across PostgreSQL 14–18 and both supported drivers.
