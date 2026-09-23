export type Scalar = string | number | boolean | null;
export type RowState =
  | { kind: 'absent' }
  | { kind: 'unknown' }
  | {
      kind: 'known';
      scope: Scalar;
      fields: Record<string, Scalar>;
      /** Observer-certified scalar equality values; absent means filtering is unproved. */
      equalityFields?: Record<string, Scalar>;
    };
export interface WriteFact {
  resource: string;
  operation: 'insert' | 'update' | 'delete' | 'unknown';
  before: RowState;
  after: RowState;
  changedColumns: string[] | null;
}
export interface ReadDependency {
  resource: string;
  columns: '*' | string[];
  bindings: { column: string; input: string }[];
  /** Necessary literal equalities, interpreted as a conjunction. */
  filters?: { column: string; value: Scalar }[];
}
/** Database-independent input consumed by the impact calculator. */
export interface ImpactManifest {
  reads: Record<string, ReadDependency[]>;
}
export type Selector = { kind: 'all' } | { kind: 'inputs'; values: Record<string, Scalar>[] };
export const IMPACT_REASON_CODES = [
  'VALIDATION_FAILED',
  'CATALOG_DRIFT',
  'RESOURCE_DRIFT',
  'OBSERVER_UNVERIFIED',
  'PRECISION_REDUCED',
  'OBSERVATION_FAILED',
  'CALCULATION_FAILED',
] as const;
export type ImpactReasonCode = (typeof IMPACT_REASON_CODES)[number];
/** Relative to the last validation snapshot pinned by this command; does not detect DDL after validation. */
export type Assessment =
  | { status: 'verified' }
  | { status: 'conservative'; codes: ImpactReasonCode[] }
  | { status: 'unavailable'; codes: ImpactReasonCode[] };
export interface ValidationReport {
  endpoints: Record<string, Assessment>;
}
export interface EndpointTarget {
  scope: 'caller' | 'global';
  selector: Selector;
}
/** Relative to the last validation snapshot pinned by this command; does not detect DDL after validation.
 * Empty targets prove no impact only with complete dependencies and observation in that snapshot.
 */
export type EndpointImpact =
  | { status: 'verified'; targets: EndpointTarget[] }
  | { status: 'conservative'; codes: ImpactReasonCode[]; targets: EndpointTarget[] }
  | { status: 'unavailable'; codes: ImpactReasonCode[]; targets?: never };
export interface ImpactSet {
  endpoints: Record<string, EndpointImpact>;
}
export interface CommandResult<T> {
  data: T;
  commitState: 'committed';
  impact: ImpactSet;
}
/** Database-independent resource policy consumed by the impact calculator. */
export interface ImpactResource {
  scopeColumn: string | null;
  columns: readonly string[];
}
export type ImpactResources = Record<string, ImpactResource>;
export const LIMITS = Object.freeze({
  facts: 200,
  selectors: 100,
  readFilters: 100,
  factBytes: 131072,
  impactBytes: 131072,
  manifestBytes: 1048576,
  endpoints: 512,
  resources: 128,
});
export function isScalar(value: unknown): value is Scalar {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  );
}
/** UTF-16 code unit order, independent of host locale. JSON values only. */
export function canonical(value: unknown): string {
  if (isScalar(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (
    value &&
    typeof value === 'object' &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  )
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map(key => JSON.stringify(key) + ':' + canonical((value as Record<string, unknown>)[key]))
        .join(',') +
      '}'
    );
  throw new Error('NON_JSON_VALUE');
}
export function byteLength(value: unknown): number {
  return new TextEncoder().encode(canonical(value)).length;
}
export function matchesInputSelector(input: Record<string, unknown>, selector: unknown): boolean {
  if (!selector || typeof selector !== 'object') return true;
  const s = selector as { kind?: unknown; values?: unknown };
  if (s.kind !== 'inputs' || !Array.isArray(s.values) || !s.values.length || s.values.length > LIMITS.selectors)
    return true;
  if (s.values.some(v => !v || typeof v !== 'object' || Array.isArray(v) || !Object.values(v).every(isScalar)))
    return true;
  return s.values.some(v =>
    Object.entries(v).every(([key, expected]) => !Object.hasOwn(input, key) || scalarMayEqual(input[key], expected)),
  );
}
export function scalarMayEqual(actual: unknown, expected: unknown): boolean {
  if (actual === expected) return true;
  if (actual === null || expected === null) return false;
  if (typeof actual === 'string' && typeof expected === 'string') {
    // Cover SQLite's built-in NOCASE and RTRIM collations conservatively. ASCII
    // folding deliberately matches more cache entries for non-ASCII strings.
    const asciiFold = (value: string) => value.replace(/[A-Z]/g, char => char.toLowerCase());
    return asciiFold(actual) === asciiFold(expected) || actual.replace(/ +$/, '') === expected.replace(/ +$/, '');
  }
  const numeric = (value: unknown): number | undefined => {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value !== 'string' || !value.trim()) return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  };
  const left = numeric(actual),
    right = numeric(expected);
  if (left !== undefined && right !== undefined && left === right) return true;
  if (typeof actual === 'boolean' && typeof expected === 'string') return expected.toLowerCase() === String(actual);
  if (typeof expected === 'boolean' && typeof actual === 'string') return actual.toLowerCase() === String(expected);
  return false;
}
export function validateImpactResources(resources: ImpactResources): void {
  const entries = Object.entries(resources);
  if (
    entries.length > LIMITS.resources ||
    byteLength(Object.fromEntries(entries.map(([id, r]) => [id, { scopeColumn: r.scopeColumn, columns: r.columns }]))) >
      LIMITS.manifestBytes
  )
    throw new Error('RESOURCE_LIMIT');
  for (const [id, r] of entries) {
    if (!id || id.length > 128 || !Array.isArray(r.columns) || new Set(r.columns).size !== r.columns.length)
      throw new Error('INVALID_RESOURCE');
    for (const name of [...r.columns, ...(r.scopeColumn === null ? [] : [r.scopeColumn])])
      if (!name || name.includes('\0')) throw new Error('INVALID_IDENTIFIER');
    if (r.scopeColumn !== null && !r.columns.includes(r.scopeColumn)) throw new Error('UNREGISTERED_COLUMN');
  }
}
export function validateImpactManifest(manifest: ImpactManifest, resources: ImpactResources): void {
  if (
    !manifest ||
    typeof manifest !== 'object' ||
    !manifest.reads ||
    typeof manifest.reads !== 'object' ||
    Array.isArray(manifest.reads) ||
    Object.keys(manifest).some(key => !['reads', 'sources', 'dependents', 'postgres'].includes(key))
  )
    throw new Error('INVALID_MANIFEST');
  if (
    Object.keys(manifest.reads).length > LIMITS.endpoints ||
    byteLength({ reads: manifest.reads }) > LIMITS.manifestBytes
  )
    throw new Error('MANIFEST_LIMIT');
  for (const [endpoint, reads] of Object.entries(manifest.reads)) {
    if (!endpoint || endpoint.length > 128) throw new Error('INVALID_ENDPOINT');
    for (const read of reads) {
      if (!Object.hasOwn(resources, read.resource)) throw new Error('UNREGISTERED_RESOURCE');
      const r = resources[read.resource];
      if (
        read.filters !== undefined &&
        (!Array.isArray(read.filters) ||
          read.filters.length > LIMITS.readFilters ||
          read.filters.some(filter => !filter || typeof filter.column !== 'string' || !isScalar(filter.value)))
      )
        throw new Error('INVALID_READ_FILTER');
      for (const c of [
        ...(read.columns === '*' ? [] : read.columns),
        ...read.bindings.map(b => b.column),
        ...(read.filters ?? []).map(filter => filter.column),
      ])
        if (!r.columns.includes(c)) throw new Error('UNREGISTERED_COLUMN');
      for (const b of read.bindings) if (!b.input || b.input.length > 128) throw new Error('INVALID_BINDING');
    }
  }
  // Even full widening must fit the output budget.
  const broad = Object.fromEntries(
    Object.keys(manifest.reads).map(endpoint => [
      endpoint,
      {
        status: 'conservative',
        codes: [...IMPACT_REASON_CODES].sort(),
        targets: ['caller', 'global'].map(scope => ({ scope, selector: { kind: 'all' } })),
      },
    ]),
  );
  if (byteLength({ endpoints: broad }) > LIMITS.impactBytes) throw new Error('MANIFEST_TARGET_BUDGET');
}
