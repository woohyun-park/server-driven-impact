import type { Resources } from '@server-driven-impact/runtime/adapter';
import type { SelectPlan, SelectOptions, Input, Join, PageValue, Predicate } from '@server-driven-impact/runtime';
export type CompiledSql = { text: string; values: unknown[] };
export function compileSelect(plan: SelectPlan, input: Input, resources: Resources): CompiledSql {
  const values: unknown[] = [];
  let nextAlias = 0;
  const ident = (value: string) => {
    if (!/^[a-z_][a-z0-9_]*$/i.test(value)) throw new Error(`Invalid SQL identifier: ${value}`);
    return `"${value}"`;
  };
  function parameter(value: unknown): string { values.push(value); return `$${values.length}`; }
  function pageValue(value: PageValue | undefined, input: Input, kind: 'limit'|'offset'): number | undefined {
    if (value === undefined) return undefined;
    const resolved = typeof value === 'number' ? value : value.kind === 'input' ? input[value.field] : value.value;
    const minimum = kind === 'limit' ? 1 : 0;
    if (!Number.isInteger(resolved) || (resolved as number) < minimum || (resolved as number) > 10000) throw new Error(`Invalid query ${kind}`);
    return resolved as number;
  }
  function render(resource: string, options: SelectOptions, parent?: { alias: string; join: Join }): string {
    if (!Object.hasOwn(resources,resource)) throw new Error('UNREGISTERED_RESOURCE');
    const definition = resources[resource];
    const alias = `t${nextAlias++}`;
    const countRoot = plan.result === 'count' && !parent;
    const column = (name: string) => { if (!definition.columns.includes(name)) throw new Error('UNREGISTERED_COLUMN'); return `${alias}.${ident(name)}`; };
    const conditions: string[] = [];
    if (parent) conditions.push(`${column(parent.join.foreign)} = ${parent.alias}.${ident(parent.join.local)}`);
    function predicateSql(predicate: Predicate): string {
      if ('predicates' in predicate) {
        const children = predicate.predicates.map(predicateSql);
        if (!children.length) return predicate.kind === 'and' ? 'true' : 'false';
        return `(${children.join(predicate.kind === 'and' ? ' AND ' : ' OR ')})`;
      }
      if ('predicate' in predicate) return `(NOT ${predicateSql(predicate.predicate)})`;
      if (!['=', '<>', '<', '<=', '>', '>=', 'in', 'is-null', 'not-null'].includes(predicate.op)) throw new Error('INVALID_PREDICATE');
      const field = column(predicate.field);
      if (predicate.op === 'is-null' || predicate.op === 'not-null') {
        return `${field} IS ${predicate.op === 'not-null' ? 'NOT ' : ''}NULL`;
      }
      const value = predicate.value?.kind === 'input' ? input[predicate.value.field] : predicate.value?.value;
      if (value === undefined) throw new Error(`Missing query input for ${predicate.field}`);
      if (predicate.op === 'in') {
        if (!Array.isArray(value)) throw new Error('IN requires an array');
        return value.length ? `${field} IN (${value.map(parameter).join(', ')})` : 'false';
      }
      return `${field} ${predicate.op} ${parameter(value)}`;
    }
    for (const predicate of options.where ?? []) conditions.push(predicateSql(predicate));
    let valueSql = countRoot ? '' : options.columns
      ? `jsonb_build_object(${options.columns.flatMap((name) => [parameter(name) + '::text', column(name)]).join(', ')})`
      : `to_jsonb(${alias})`;
    for (const join of options.joins ?? []) {
      ident(join.as);
      column(join.local);
      if (countRoot && !join.required) continue;
      const child = render(join.resource, join, { alias, join });
      const result = join.many
        ? `(SELECT coalesce(jsonb_agg(j.value), '[]'::jsonb) FROM (${child}) j)`
        : `(SELECT j.value FROM (${child}) j LIMIT 1)`;
      if (plan.result !== 'count') valueSql += ` || jsonb_build_object(${parameter(join.as)}::text, ${result})`;
      if (join.required) conditions.push(`EXISTS (SELECT 1 FROM (${child}) required_child)`);
    }
    const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
    const order = options.order?.length ? ' ORDER BY ' + options.order.map((entry) => `${column(entry.field)} ${entry.ascending === false ? 'DESC' : 'ASC'} NULLS ${entry.nullsFirst ? 'FIRST' : 'LAST'}`).join(', ') : '';
    const limit = pageValue(options.limit,input,'limit');
    const offset = pageValue(options.offset,input,'offset');
    const selected = countRoot ? 'count(*)::int' : valueSql;
    return `SELECT ${selected} AS value FROM ${ident(definition.schema ?? 'public')}.${ident(definition.table)} ${alias}${where}${countRoot ? '' : order}${!countRoot && limit !== undefined ? ` LIMIT ${parameter(limit)}` : ''}${!countRoot && offset !== undefined ? ` OFFSET ${parameter(offset)}` : ''}`;
  }
  return { text: render(plan.resource, plan.options), values };
}
