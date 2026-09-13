import { canonical } from '@server-driven-impact/core';
import type { CacheInputField, CacheKeyNode, CacheQueryContract, CacheValue, QueryKey } from './types.js';
import { isCacheValue, normalizeField, OMIT, own } from './input.js';

export function queryTemplate(query: CacheQueryContract): CacheKeyNode {
  if ('template' in query.key) return query.key.template;
  const { prefix, path = [], params, omitEmptyParams } = query.key;
  return {
    kind: 'array',
    items: [
      ...prefix.map(value => ({ kind: 'literal' as const, value })),
      ...path.map(field => ({ kind: 'input' as const, field })),
      ...(params ? [{ kind: 'inputs' as const, fields: params, omitEmpty: omitEmptyParams ?? false }] : []),
    ],
  };
}

export function validateTemplate(query: CacheQueryContract): void {
  const used = new Set<string>();
  function field(name: string) {
    if (!own(query.input, name)) throw new Error('UNKNOWN_CACHE_KEY_INPUT:' + name);
    used.add(name);
  }
  function walk(node: CacheKeyNode, depth: number, inArray: boolean, last: boolean): void {
    if (!node || depth > 24) throw new Error('INVALID_CACHE_KEY_TEMPLATE');
    switch (node.kind) {
      case 'literal':
        if (!isCacheValue(node.value)) throw new Error('INVALID_CACHE_KEY_LITERAL');
        break;
      case 'input':
        field(node.field);
        if (inArray && !query.input[node.field].required && !own(query.input[node.field], 'default')) {
          throw new Error('CACHE_ARRAY_INPUT_MUST_BE_REQUIRED:' + node.field);
        }
        break;
      case 'inputs':
        (node.fields ?? Object.keys(query.input)).forEach(field);
        if (node.omitEmpty !== undefined && typeof node.omitEmpty !== 'boolean')
          throw new Error('INVALID_CACHE_KEY_TEMPLATE');
        if (inArray && node.omitEmpty && !last) throw new Error('CACHE_OPTIONAL_ARRAY_ITEM_MUST_BE_LAST');
        break;
      case 'object':
        if (!node.fields || Array.isArray(node.fields)) throw new Error('INVALID_CACHE_KEY_TEMPLATE');
        for (const child of Object.values(node.fields)) walk(child, depth + 1, false, true);
        break;
      case 'array':
        if (!Array.isArray(node.items)) throw new Error('INVALID_CACHE_KEY_TEMPLATE');
        node.items.forEach((child, index) => walk(child, depth + 1, true, index === node.items.length - 1));
        break;
      default:
        throw new Error('INVALID_CACHE_KEY_TEMPLATE');
    }
  }
  const template = queryTemplate(query);
  if (template.kind !== 'array' || !template.items.length) throw new Error('CACHE_KEY_ROOT_MUST_BE_ARRAY');
  walk(template, 0, false, true);
  for (const name of Object.keys(query.input)) if (!used.has(name)) throw new Error('CACHE_INPUT_NOT_IN_KEY:' + name);
  if (!('template' in query.key)) {
    const { path = [], params = [], paramsAnchor } = query.key;
    if (new Set([...path, ...params]).size !== path.length + params.length)
      throw new Error('DUPLICATE_CACHE_KEY_FIELD');
    if (paramsAnchor && (!paramsAnchor.length || paramsAnchor.some(name => !params.includes(name))))
      throw new Error('INVALID_CACHE_PARAMS_ANCHOR');
  }
}

type Shape =
  | { kind: 'literal'; value: CacheValue; optional?: boolean }
  | { kind: 'dynamic'; schema: CacheInputField; optional?: boolean }
  | { kind: 'array'; items: Shape[]; optional?: boolean }
  | { kind: 'object'; fields: Record<string, Shape>; optional?: boolean };

function literalShape(value: CacheValue): Shape {
  if (Array.isArray(value)) return { kind: 'array', items: value.map(literalShape) };
  if (value && typeof value === 'object')
    return { kind: 'object', fields: Object.fromEntries(Object.entries(value).map(([k, v]) => [k, literalShape(v)])) };
  return { kind: 'literal', value };
}
function shape(node: CacheKeyNode, query: CacheQueryContract): Shape {
  switch (node.kind) {
    case 'literal':
      return literalShape(node.value);
    case 'input': {
      const schema = query.input[node.field];
      return { kind: 'dynamic', schema, optional: !schema.required && !own(schema, 'default') };
    }
    case 'inputs':
      return {
        kind: 'object',
        optional: node.omitEmpty,
        fields: Object.fromEntries(
          (node.fields ?? Object.keys(query.input)).map(name => [name, shape({ kind: 'input', field: name }, query)]),
        ),
      };
    case 'object':
      return {
        kind: 'object',
        fields: Object.fromEntries(Object.entries(node.fields).map(([k, v]) => [k, shape(v, query)])),
      };
    case 'array':
      return { kind: 'array', items: node.items.map(child => shape(child, query)) };
  }
}
function dynamicMayEqual(schema: CacheInputField, value: CacheValue): boolean {
  try {
    const result = normalizeField(schema, value, 'collision');
    return result !== OMIT && canonical(result) === canonical(value);
  } catch {
    return false;
  }
}
function intersects(a: Shape, b: Shape): boolean {
  if (a.kind === 'dynamic' || b.kind === 'dynamic') {
    const dynamic = a.kind === 'dynamic' ? a : (b as Extract<Shape, { kind: 'dynamic' }>);
    const other = a.kind === 'dynamic' ? b : a;
    if (other.kind === 'literal') return dynamicMayEqual(dynamic.schema, other.value);
    if (other.kind === 'array') return dynamic.schema.type === 'array';
    if (other.kind === 'object') return dynamic.schema.type === 'object';
    return true;
  }
  if (a.kind !== b.kind) return false;
  if (a.kind === 'literal' && b.kind === 'literal') return canonical(a.value) === canonical(b.value);
  if (a.kind === 'array' && b.kind === 'array') {
    const minA = a.items.filter(item => !item.optional).length;
    const minB = b.items.filter(item => !item.optional).length;
    if (minA > b.items.length || minB > a.items.length) return false;
    return a.items.every(
      (item, i) => !b.items[i] || (item.optional && b.items[i].optional) || intersects(item, b.items[i]),
    );
  }
  if (a.kind === 'object' && b.kind === 'object') {
    for (const name of new Set([...Object.keys(a.fields), ...Object.keys(b.fields)])) {
      const x = a.fields[name],
        y = b.fields[name];
      if (!x || !y) {
        if (!(x ?? y).optional) return false;
      } else if (!(x.optional && y.optional) && !intersects(x, y)) return false;
    }
  }
  return true;
}
export function validateKeySeparation(queries: readonly CacheQueryContract[]): void {
  const shapes = queries.map(query => shape(queryTemplate(query), query));
  for (let i = 0; i < queries.length; i++)
    for (let j = i + 1; j < queries.length; j++) {
      if (intersects(shapes[i], shapes[j]))
        throw new Error('CACHE_KEY_COLLISION:' + queries[i].operationId + ':' + queries[j].operationId);
    }
}
function guarantees(node: Shape, filter: CacheValue): boolean {
  if (node.optional) return false;
  if (node.kind === 'literal') return canonical(node.value) === canonical(filter);
  if (node.kind === 'dynamic') {
    return (
      'enum' in node.schema &&
      !!node.schema.enum?.length &&
      node.schema.enum.every(value => canonical(value) === canonical(filter))
    );
  }
  if (node.kind === 'array')
    return (
      Array.isArray(filter) &&
      filter.every((value, index) => !!node.items[index] && guarantees(node.items[index], value))
    );
  return (
    !!filter &&
    !Array.isArray(filter) &&
    typeof filter === 'object' &&
    Object.entries(filter).every(([name, value]) => !!node.fields[name] && guarantees(node.fields[name], value))
  );
}
export function validateFallback(query: CacheQueryContract): void {
  if (
    !Array.isArray(query.fallback) ||
    !query.fallback.length ||
    !isCacheValue(query.fallback) ||
    !guarantees(shape(queryTemplate(query), query), query.fallback)
  )
    throw new Error('CACHE_FALLBACK_NOT_PROVEN:' + query.operationId);
}

const UNKNOWN = Symbol('unknown');
type Render = { value: CacheValue | typeof OMIT | typeof UNKNOWN; complete: boolean };
function render(
  node: CacheKeyNode,
  query: CacheQueryContract,
  input: Record<string, CacheValue>,
  partial: boolean,
): Render {
  switch (node.kind) {
    case 'literal':
      return { value: node.value, complete: true };
    case 'input':
      return own(input, node.field)
        ? { value: input[node.field], complete: true }
        : { value: partial ? UNKNOWN : OMIT, complete: !partial };
    case 'inputs': {
      const names = node.fields ?? Object.keys(query.input);
      const value = Object.fromEntries(names.filter(name => own(input, name)).map(name => [name, input[name]]));
      const complete = !partial || names.every(name => own(input, name));
      return { value: !Object.keys(value).length && node.omitEmpty ? (partial ? UNKNOWN : OMIT) : value, complete };
    }
    case 'object': {
      const result: Record<string, CacheValue> = Object.create(null);
      let complete = true;
      for (const [name, child] of Object.entries(node.fields)) {
        const value = render(child, query, input, partial);
        complete &&= value.complete;
        if (value.value !== OMIT && value.value !== UNKNOWN) result[name] = value.value;
      }
      return { value: result, complete };
    }
    case 'array': {
      const result: CacheValue[] = [];
      let complete = true;
      for (const child of node.items) {
        const value = render(child, query, input, partial);
        complete &&= value.complete;
        if (value.value === UNKNOWN) break; // Partial arrays can express only a prefix.
        if (value.value !== OMIT) result.push(value.value);
      }
      return { value: result, complete };
    }
  }
}
export function renderKey(
  query: CacheQueryContract,
  input: Record<string, CacheValue>,
  partial = false,
): { queryKey: QueryKey; exact: boolean } {
  const result = render(queryTemplate(query), query, input, partial);
  if (!Array.isArray(result.value) || !result.value.length) return { queryKey: query.fallback, exact: false };
  return { queryKey: result.value as QueryKey, exact: result.complete };
}
