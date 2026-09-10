import type { Scalar } from "@server-driven-impact/core";
export type Row = Record<string, any>;
export type Expr = { expr: string; args: unknown[] };
const node = (expr: string, ...args: unknown[]): Expr => ({ expr, args });
export const e = {
  col: (name: string) => node("column", name),
  incoming: (name: string) => node("incoming", name),
  eq: (name: string, value: unknown) => node("=", node("column", name), value),
  ne: (name: string, value: unknown) => node("<>", node("column", name), value),
  lt: (name: string, value: unknown) => node("<", node("column", name), value),
  isNull: (name: string) => node("is-null", node("column", name)),
  notNull: (name: string) => node("not-null", node("column", name)),
  in: (name: string, values: unknown[]) =>
    node("in", node("column", name), values),
  and: (...values: Expr[]) => node("and", ...values),
  or: (...values: Expr[]) => node("or", ...values),
  not: (value: Expr) => node("not", value),
  now: () => node("now"),
  coalesce: (...values: unknown[]) => node("coalesce", ...values),
  nullif: (a: unknown, b: unknown) => node("nullif", a, b),
  choose: (test: Expr, yes: unknown, no: unknown) =>
    node("case", test, yes, no),
};
export interface Select {
  lock?: boolean;
  order?: { field: string | Expr; ascending?: boolean; nullsFirst?: boolean }[];
  limit?: number;
}
export interface Insert {
  returnRows?: boolean;
  conflict?: { keys: string[]; patch?: Row; where?: Expr };
}
export interface OperationsDb {
  readonly scope: Scalar;
  select(resource: string, where?: Expr, options?: Select): Promise<Row[]>;
  require(resource: string, where: Expr, lock?: boolean): Promise<Row>;
  insert(
    resource: string,
    rows: Row[],
    options?: Insert,
  ): Promise<{ count: number; rows: Row[] }>;
  update(
    resource: string,
    patch: Row,
    where: Expr,
    options?: { returnRows?: boolean },
  ): Promise<{ count: number; rows: Row[] }>;
  delete(
    resource: string,
    where?: Expr,
  ): Promise<{ count: number; rows: Row[] }>;
  patchMany(
    resource: string,
    rows: Row[],
    keys: string[],
    where?: Expr,
  ): Promise<{ count: number; rows: Row[] }>;
}
export function remoteDb(
  scope: Scalar,
  call: (operation: unknown) => Promise<any>,
): OperationsDb {
  return Object.freeze(
    {
      scope,
      select: (resource, where = e.and(), options = {}) =>
        call({ kind: "select", resource, where, options }),
      require: async (resource, where, lock = false) => {
        const [row] = await call({
          kind: "select",
          resource,
          where,
          options: { lock, limit: 1 },
        });
        if (!row) {
          throw Object.assign(new Error("NOT_FOUND"), { code: "P0002" });
        }
        return row;
      },
      insert: (resource, rows, options = {}) =>
        call({ kind: "insert", resource, rows, options }),
      update: (resource, patch, where, options = {}) =>
        call({ kind: "update", resource, patch, where, options }),
      delete: (resource, where) => call(where === undefined ? { kind: "delete", resource } : { kind: "delete", resource, where }),
      patchMany: (resource, rows, keys, where = e.and()) =>
        call({ kind: "patchMany", resource, rows, keys, where }),
    } satisfies OperationsDb,
  );
}
