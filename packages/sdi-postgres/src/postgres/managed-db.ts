import {
  type Row,
  TrackedDb,
  type Transaction,
} from "./tracked-db.js";
import { identifier, join, Sql, sql } from "./sql.js";
import { canonical, type Scalar } from "@server-driven-impact/core";
import type { WriteSet } from "@server-driven-impact/core";
import { e, identityColumns, type Expr, type Resources } from "@server-driven-impact/runtime/adapter";
import { assertWriteAccess, type PostgresWriteAccess } from "./write-access.js";

export function createOperationExecutor(
  tx: Transaction,
  writes: WriteSet,
  scope: Scalar,
  resources: Resources,
  writeAccess?: PostgresWriteAccess,
) {
  const db = new TrackedDb(tx, writes, scope, resources, undefined, true);
  function column(resource: string, name: unknown) {
    if (
      typeof name !== "string" || !resources[resource]?.columns.includes(name)
    ) throw new Error("UNREGISTERED_COLUMN");
    return identifier(name);
  }
  function expression(
    resource: string,
    value: unknown,
    depth = 0,
    incoming = false,
  ): Sql {
    if (depth > 32) throw new Error("EXPRESSION_DEPTH");
    if (
      !value || typeof value !== "object" || Array.isArray(value) ||
      !Object.hasOwn(value, "expr")
    ) return sql`${value}`;
    const { expr, args } = value as Expr;
    if (!Array.isArray(args) || args.length > 5000) {
      throw new Error("INVALID_EXPRESSION");
    }
    const x = (v: unknown) => expression(resource, v, depth + 1, incoming);
    const arity = (n: number) => {
      if (args.length !== n) throw new Error("INVALID_EXPRESSION");
    };
    switch (expr) {
      case "column":
        arity(1);
        return sql`t.${column(resource, args[0])}`;
      case "incoming":
        arity(1);
        if (!incoming) throw new Error("INVALID_INCOMING");
        return sql`excluded.${column(resource, args[0])}`;
      case "now":
        arity(0);
        return sql`transaction_timestamp()`;
      case "=":
      case "<>":
      case "<":
      case "<=":
      case ">":
      case ">=":
        arity(2);
        return sql`(${x(args[0])} ${new Sql(expr)} ${x(args[1])})`;
      case "is-null":
      case "not-null":
        arity(1);
        return sql`(${x(args[0])} is ${
          expr === "not-null" ? sql`not` : sql``
        } null)`;
      case "and":
      case "or":
        if (!args.length) return expr === "and" ? sql`true` : sql`false`;
        return sql`(${join(args.map(x), expr === "and" ? " and " : " or ")})`;
      case "not":
        arity(1);
        return sql`not (${x(args[0])})`;
      case "in":
        arity(2);
        if (!Array.isArray(args[1]) || args[1].length > 5000) {
          throw new Error("INVALID_IN");
        }
        return args[1].length
          ? sql`(${x(args[0])} in (${join(args[1].map(x))}))`
          : sql`false`;
      case "coalesce":
        if (args.length < 2) throw new Error("INVALID_EXPRESSION");
        return sql`coalesce(${join(args.map(x))})`;
      case "nullif":
        arity(2);
        return sql`nullif(${x(args[0])},${x(args[1])})`;
      case "case":
        arity(3);
        return sql`case when ${x(args[0])} then ${x(args[1])} else ${
          x(args[2])
        } end`;
      default:
        throw new Error("UNSUPPORTED_EXPRESSION");
    }
  }
  function patch(resource: string, value: Row, incoming = false) {
    if (
      !value || typeof value !== "object" || Array.isArray(value) ||
      !Object.keys(value).length
    ) throw new Error("INVALID_PATCH");
    if (
      identityColumns(resources[resource]).some(column => Object.hasOwn(value,column)) ||
      (resources[resource].scopeColumn &&
        Object.hasOwn(value, resources[resource].scopeColumn!))
    ) throw new Error("IMMUTABLE_KEY");
    const result = Object.fromEntries(
      Object.entries(value).map(([k, v]) => {
        column(resource, k);
        return [k, expression(resource, v, 0, incoming)];
      }),
    );
    return result;
  }
  return async (raw: unknown): Promise<unknown> => {
    if (
      !raw || typeof raw !== "object" || Array.isArray(raw) ||
      canonical(raw).length > 2 * 1024 * 1024
    ) throw new Error("INVALID_OPERATION");
    const op = raw as Record<string, any>, resource = op.resource;
    if (typeof resource !== "string" || !Object.hasOwn(resources, resource)) {
      throw new Error("UNREGISTERED_RESOURCE");
    }
    if (
      !["select", "insert", "update", "delete", "patchMany"].includes(op.kind)
    ) throw new Error("UNSUPPORTED_OPERATION");
    const owner = resources[resource].scopeColumn;
    const where = expression(
      resource,
      owner
        ? e.and(op.where ?? e.and(), e.eq(owner, scope))
        : op.where ?? e.and(),
    );
    const options = op.options ?? {};
    if (op.kind === "select") {
      if (
        options.limit !== undefined &&
        (!Number.isInteger(options.limit) || options.limit < 1 ||
          options.limit > 10000)
      ) throw new Error("INVALID_LIMIT");
      const order = options.order?.map((o: Record<string, any>) =>
        sql`${
          typeof o.field === "string"
            ? sql`t.${column(resource, o.field)}`
            : expression(resource, o.field)
        } ${o.ascending === false ? sql`desc` : sql`asc`} nulls ${
          o.nullsFirst ? sql`first` : sql`last`
        }`
      );
      return db.select(resource, where, {
        lock: options.lock === true,
        limit: options.limit,
        order: order?.length ? join(order) : undefined,
      });
    }
    if (op.kind === "update") {
      assertWriteAccess(writeAccess,resource,"update",Object.keys(op.patch ?? {}));
      return db.update(resource, patch(resource, op.patch), where, {
        returnRows: options.returnRows === true,
      });
    }
    if (op.kind === "delete") {
      assertWriteAccess(writeAccess,resource,"delete");
      return db.delete(resource, where);
    }
    if (!Array.isArray(op.rows) || op.rows.length > 5000) {
      throw new Error("INVALID_BATCH");
    }
    for (const row of op.rows) {
      if (!row || typeof row !== "object" || Array.isArray(row)) {
        throw new Error("INVALID_ROW");
      }
      for (const key of Object.keys(row)) column(resource, key);
      const owner = resources[resource].scopeColumn;
      if (owner && Object.hasOwn(row, owner) && row[owner] !== scope) {
        throw new Error("FORBIDDEN");
      }
    }
    if (op.kind === "insert") {
      assertWriteAccess(writeAccess,resource,"insert");
      if (owner) op.rows = op.rows.map((r: Row) => ({ ...r, [owner]: scope }));
      const conflict = options.conflict;
      if (
        conflict && (!Array.isArray(conflict.keys) || !conflict.keys.length)
      ) throw new Error("INVALID_CONFLICT");
      for (const key of conflict?.keys ?? []) column(resource, key);
      const insertOptions = {
        returnRows: options.returnRows === true,
        conflict: conflict
          ? {
            keys: conflict.keys,
            patch: conflict.patch
              ? patch(resource, conflict.patch, true)
              : undefined,
            where: conflict.where
              ? expression(resource, conflict.where)
              : undefined,
          }
          : undefined,
      };
      if (conflict?.patch) assertWriteAccess(writeAccess,resource,"update",Object.keys(conflict.patch));
      return db.insert(resource, op.rows, insertOptions);
    }
    if (!op.rows.length) return { count: 0, rows: [] };
    if (!Array.isArray(op.keys) || !op.keys.length) {
      throw new Error("INVALID_KEYS");
    }
    op.keys.forEach((c: string) => column(resource, c));
    const seen = new Set<string>();
    for (const row of op.rows) {
      const key = canonical(op.keys.map((k: string) => row[k]));
      if (seen.has(key)) throw new Error("DUPLICATE_BATCH_KEY");
      seen.add(key);
    }
    const names = Object.keys(op.rows[0]).filter((k) => !op.keys.includes(k));
    if (
      op.rows.some((r: Row) =>
        canonical(Object.keys(r).sort()) !==
          canonical(Object.keys(op.rows[0]).sort())
      )
    ) throw new Error("BATCH_COLUMNS_MUST_MATCH");
    const changes = Object.fromEntries(
      names.map((c) => [c, sql`s.${column(resource, c)}`]),
    );
    if (
      identityColumns(resources[resource]).some(column => names.includes(column)) ||
      names.includes(resources[resource].scopeColumn!)
    ) throw new Error("IMMUTABLE_KEY");
    if (!names.length) throw new Error("EMPTY_PATCH");
    const r = resources[resource];
    assertWriteAccess(writeAccess,resource,"update",names);
    return db.update(
      resource,
      changes,
      sql`(${where}) and ${
        join(
          op.keys.map((k: string) =>
            sql`t.${column(resource, k)}=s.${column(resource, k)}`
          ),
          " and ",
        )
      }`,
      {
        from: sql`jsonb_populate_recordset(null::${
          identifier(r.schema ?? "public")
        }.${identifier(r.table)},${JSON.stringify(op.rows)}::text::jsonb) s`,
      },
    );
  };
}
