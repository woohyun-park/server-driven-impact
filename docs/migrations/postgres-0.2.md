# PostgreSQL 0.1.x to 0.2.0 migration correction

This page supplies migration information omitted from the published 0.2.0 changelog. It describes 0.2.0 behavior; 0.3.0 adds the driver-result behavior documented in the package README.

## Replace command helpers with native SQL

0.2.0 removed the PostgreSQL CRUD helpers, `operations`, and registered routine dispatcher. Express writes and function calls as parameterized SQL on the observed transaction.

```ts
// 0.1.x
const changed = await db.postgres.update('todos', { title }, sql`t.id=${id}`, { returnRows: true });
const value = await db.call('recalculate', [id]);

// 0.2.0
const changed = await db.execute(sql`
  update todos set title=${title} where id=${id} returning *
`);
const value = await db.execute(sql`select * from recalculate(${id})`);
```

The removed helpers projected results through PostgreSQL JSON expressions in several paths. Native execution does not apply that conversion. Dates, numerics, big integers, JSON, arrays, and custom types follow the selected driver's codec configuration.

Function results also follow SQL row semantics. `select fn(...) as value` produces a row with a `value` column. `select * from fn(...)` produces the columns and row count defined by PostgreSQL and the driver. SDI no longer wraps function results in the former dispatcher shape.

## Counting processed rows in 0.2.0

The 0.2.0 `execute()` result is an array of returned rows. DML without `RETURNING` produces `[]` whether it processes zero rows or many rows. Use `RETURNING` when the application must distinguish those cases:

```ts
const rows = await db.execute(sql`
  update todos set completed=true where id=${id} returning id
`);
if (rows.length === 0) throw new Error('NOT_FOUND_OR_CONFLICT');
```

Starting in 0.3.0, `execute()` preserves postgres.js `count` or node-postgres `rowCount`, so `RETURNING` is no longer required solely to obtain the processed-row count.

## Responsibility after `writeAccess` removal

In 0.1.x, `writeAccess` checked resources, operations, and selected column names before supported structured writes. In 0.2.0, native SQL authorization belongs to database roles and privileges, column grants, RLS policies, and application domain validation.

```ts
// 0.1.x
postgresAdapter({ database, writeAccess: { todos: { update: ['title'] } } });

// 0.2.0
postgresAdapter({ database, setup: setVerifiedClaims });
// Grant the runtime role only the required privileges and enforce tenant access with RLS.
// Validate allowed fields before constructing the parameterized SQL statement.
```

SDI still owns the observed transaction, command SQL boundary, write observation, and impact calculation. Those mechanisms report cache impact; they do not replace authorization.
