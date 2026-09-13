type Json = Record<string, any>;
export function sqlReferences(tree: unknown) {
  const relations = new Map<string, { schema?: string; name: string }>();
  const functions = new Map<string, { schema?: string; name: string; arguments: number }>();
  let nonRow = false;
  let unresolvedExpression = false;
  const string = (value: Json) => value?.String?.sval ?? value?.String?.str;
  function visit(value: unknown, inherited: Set<string>) {
    if (Array.isArray(value)) {
      value.forEach(child => visit(child, inherited));
      return;
    }
    if (!value || typeof value !== 'object') return;
    const record = value as Json;
    const column = record.ColumnRef?.fields?.map(string)?.at(-1);
    if (['ctid', 'tableoid', 'xmin', 'xmax', 'cmin', 'cmax'].includes(column)) unresolvedExpression = true;
    const names = (record.TypeName ?? record.TypeCast?.typeName)?.names?.map(string);
    if (names?.length > 1 && names[0] !== 'pg_catalog') unresolvedExpression = true;
    const operator = record.A_Expr?.name?.map(string);
    if (operator?.length > 1 && operator[0] !== 'pg_catalog') unresolvedExpression = true;
    if (record.SQLValueFunction || record.NextValueExpr) nonRow = true;
    const select = record.SelectStmt ?? (String(record.op).startsWith('SETOP_') ? record : undefined);
    if (select) {
      const withClause = select.withClause?.WithClause ?? select.withClause;
      const ctes = (withClause?.ctes ?? []).map((entry: Json) => entry.CommonTableExpr);
      const visible = new Set(inherited);
      if (withClause?.recursive) for (const cte of ctes) visible.add(cte.ctename);
      for (const cte of ctes) {
        visit(cte.ctequery, new Set(visible));
        visible.add(cte.ctename);
      }
      for (const [key, child] of Object.entries(select)) if (key !== 'withClause') visit(child, visible);
      return;
    }
    const range = record.RangeVar;
    if (range && (range.schemaname || !inherited.has(range.relname))) {
      const reference = { ...(range.schemaname ? { schema: range.schemaname } : {}), name: range.relname };
      relations.set(JSON.stringify(reference), reference);
    }
    const call = record.FuncCall;
    if (call?.funcname) {
      const names = call.funcname.map(string);
      if (names.every(Boolean) && names.length <= 2) {
        const reference = {
          ...(names.length === 2 ? { schema: names[0] } : {}),
          name: names.at(-1),
          arguments: call.args?.length ?? 0,
        };
        functions.set(JSON.stringify(reference), reference);
      }
    }
    Object.values(record).forEach(child => visit(child, inherited));
  }
  visit(tree, new Set());
  return { relations: [...relations.values()], functions: [...functions.values()], nonRow, unresolvedExpression };
}
