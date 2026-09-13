import { canonical, isScalar, matchesInputSelector, type Scalar } from '@server-driven-impact/core';
import type { CacheInputField, CacheValue } from './types.js';

export const own = (value: object, name: string): boolean => Object.hasOwn(value, name);
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null &&
  typeof value === 'object' &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

/** Bounded JSON validation, including sparse arrays and cyclic/non-JSON input. */
export function isCacheValue(value: unknown, depth = 0): value is CacheValue {
  if (depth > 32) return false;
  if (isScalar(value)) return true;
  if (Array.isArray(value)) return Array.from(value).every(item => isCacheValue(item, depth + 1));
  return isRecord(value) && Object.values(value).every(item => isCacheValue(item, depth + 1));
}
export const OMIT = Symbol('omitted');
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export function normalizeField(field: CacheInputField, value: unknown, path: string): CacheValue | typeof OMIT {
  if (value === undefined) {
    if (own(field, 'default')) value = field.default;
    else if (!field.required) return OMIT;
    else throw new Error('CACHE_INPUT_REQUIRED:' + path);
  }
  if (value === null) {
    if (!field.nullable) throw new Error('CACHE_INPUT_NULL:' + path);
    if ('enum' in field && field.enum && !field.enum.includes(null)) throw new Error('CACHE_INPUT_ENUM:' + path);
    if ('exclude' in field && field.exclude?.includes(null)) throw new Error('CACHE_INPUT_EXCLUDED:' + path);
    return null;
  }
  if (field.type === 'array') {
    if (!Array.isArray(value)) throw new Error('INVALID_CACHE_INPUT:' + path);
    const items = Array.from(value).map(item => {
      const normalized = normalizeField(field.items, item, path + '[]');
      if (normalized === OMIT) throw new Error('CACHE_ARRAY_ITEM_REQUIRED:' + path);
      return normalized;
    });
    if (field.order !== 'set') return items;
    return [...new Map(items.map(item => [canonical(item), item])).entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([, item]) => item);
  }
  if (field.type === 'object') return normalizeFields(field.properties, value, path);
  let result: Scalar;
  if (field.type === 'date-time') {
    // Require an explicit timezone; local-time parsing would differ across hosts.
    if (!(value instanceof Date) && (typeof value !== 'string' || !/T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(value))) {
      throw new Error('CACHE_DATE_TIMEZONE_REQUIRED:' + path);
    }
    const date = value instanceof Date ? value : new Date(value as string);
    if (!Number.isFinite(date.valueOf())) throw new Error('INVALID_CACHE_INPUT:' + path);
    result = date.toISOString();
  } else if (typeof value === field.type && isScalar(value)) result = value;
  else if (
    field.coerce &&
    field.type === 'number' &&
    typeof value === 'string' &&
    value.trim() &&
    Number.isFinite(Number(value))
  )
    result = Number(value);
  else if (
    field.coerce &&
    field.type === 'string' &&
    (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)))
  )
    result = String(value);
  else if (field.coerce && field.type === 'boolean' && (value === 'true' || value === 'false'))
    result = value === 'true';
  else throw new Error('INVALID_CACHE_INPUT:' + path);
  if (field.format === 'uuid') {
    if (typeof result !== 'string' || !uuid.test(result)) throw new Error('INVALID_CACHE_UUID:' + path);
    result = result.toLowerCase();
  }
  if (field.exclude?.some(item => canonical(item) === canonical(result)))
    throw new Error('CACHE_INPUT_EXCLUDED:' + path);
  if (field.enum && !field.enum.some(item => canonical(item) === canonical(result)))
    throw new Error('CACHE_INPUT_ENUM:' + path);
  return result;
}

export function normalizeFields(
  fields: Readonly<Record<string, CacheInputField>>,
  value: unknown,
  path = 'input',
): Record<string, CacheValue> {
  if (!isRecord(value)) throw new Error('INVALID_CACHE_INPUT:' + path);
  for (const name of Object.keys(value))
    if (!own(fields, name)) throw new Error('UNKNOWN_CACHE_INPUT:' + path + '.' + name);
  return Object.fromEntries(
    Object.entries(fields).flatMap(([name, field]) => {
      const normalized = normalizeField(field, own(value, name) ? value[name] : undefined, path + '.' + name);
      return normalized === OMIT ? [] : [[name, normalized]];
    }),
  );
}

export function validateFields(fields: Readonly<Record<string, CacheInputField>>, depth = 0): void {
  if (!isRecord(fields) || depth > 24) throw new Error('INVALID_CACHE_INPUT_SCHEMA');
  for (const [name, field] of Object.entries(fields)) {
    if (!name || !isRecord(field)) throw new Error('INVALID_CACHE_INPUT_SCHEMA');
    for (const flag of ['required', 'nullable', 'coerce']) {
      if (own(field, flag) && typeof field[flag as keyof typeof field] !== 'boolean')
        throw new Error('INVALID_CACHE_INPUT_SCHEMA');
    }
    if (field.type === 'array') {
      if (field.order !== undefined && !['preserve', 'set'].includes(field.order))
        throw new Error('INVALID_CACHE_ARRAY_ORDER');
      validateFields({ item: field.items }, depth + 1);
    } else if (field.type === 'object') validateFields(field.properties, depth + 1);
    else {
      if (!['string', 'number', 'boolean', 'date-time'].includes(field.type))
        throw new Error('INVALID_CACHE_INPUT_TYPE');
      if (field.format !== undefined && (field.type !== 'string' || field.format !== 'uuid'))
        throw new Error('INVALID_CACHE_INPUT_FORMAT');
      for (const values of [field.enum, field.exclude])
        if (values !== undefined) {
          if (!Array.isArray(values) || !values.every(isScalar)) throw new Error('INVALID_CACHE_INPUT_DOMAIN');
          for (const item of values) {
            const normalized = normalizeField({ ...field, enum: undefined, exclude: undefined }, item, name);
            if (normalized === OMIT || canonical(normalized) !== canonical(item))
              throw new Error('CACHE_INPUT_DOMAIN_NOT_NORMALIZED:' + name);
          }
        }
      if (field.enum && !field.enum.length) throw new Error('EMPTY_CACHE_INPUT_ENUM');
    }
    if (own(field, 'default')) {
      if (!isCacheValue(field.default)) throw new Error('INVALID_CACHE_DEFAULT');
      normalizeField(field, field.default, name);
    }
  }
}

/** A sufficient proof relative to the existing conservative protocol-1 matcher. */
export function selectorValue(
  field: CacheInputField,
  expected: Scalar,
  verifiedExactString = false,
): CacheValue | undefined {
  if (field.type === 'array' || field.type === 'object') return undefined;
  if (verifiedExactString && field.type === 'string' && typeof expected === 'string' && !field.coerce) {
    if (field.enum && !field.enum.some(value => canonical(value) === canonical(expected))) return undefined;
    if (field.exclude?.some(value => canonical(value) === canonical(expected))) return undefined;
    return expected;
  }
  if (field.enum) {
    const matches = field.enum.filter(value =>
      matchesInputSelector({ v: value }, { kind: 'inputs', values: [{ v: expected }] }),
    );
    return matches.length === 1 ? matches[0] : undefined;
  }
  if (expected === null) return field.nullable ? null : undefined;
  if (field.type === 'number') {
    // Numeric strings in v1 may describe numeric API inputs without coerce enabled.
    if (typeof expected === 'string' && expected.trim() && Number.isFinite(Number(expected))) return Number(expected);
    return typeof expected === 'number' ? expected : undefined;
  }
  if (field.type === 'boolean') {
    if (typeof expected === 'boolean') return expected;
    if (typeof expected === 'string' && /^(true|false)$/i.test(expected)) return expected.toLowerCase() === 'true';
  }
  if (field.format === 'uuid' && typeof expected === 'string' && uuid.test(expected)) return expected.toLowerCase();
  // Unrestricted strings may match distinct NOCASE/RTRIM/numeric representations.
  return undefined;
}
