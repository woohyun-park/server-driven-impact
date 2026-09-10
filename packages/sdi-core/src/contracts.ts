export type Scalar = string | number | boolean | null;
export type RowState = { kind: 'absent' } | { kind: 'unknown' } | {
  kind: 'known'; scope: Scalar; fields: Record<string, Scalar>;
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
}
/** Database-independent input consumed by the impact calculator. */
export interface ImpactManifest {
  protocolVersion: 1;
  reads: Record<string, ReadDependency[]>;
}
export type Selector = { kind: 'all' } | { kind: 'inputs'; values: Record<string, Scalar>[] };
export interface ImpactTarget { endpoint: string; scope: 'caller' | 'global'; selector: Selector }
export interface ImpactSet { protocolVersion: 1; targets: ImpactTarget[] }
/** Database-independent resource policy consumed by the impact calculator. */
export interface ImpactResource {
  scopeColumn: string | null;
  columns: readonly string[];
}
export type ImpactResources = Record<string, ImpactResource>;
export const LIMITS = Object.freeze({ facts: 200, selectors: 100, factBytes: 131072, impactBytes: 131072, manifestBytes: 1048576, endpoints: 512, resources: 128 });
export function isScalar(value: unknown): value is Scalar {
  return value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value));
}
/** UTF-16 code unit order, independent of host locale. JSON values only. */
export function canonical(value: unknown): string {
  if (isScalar(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object' && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null))
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical((value as Record<string,unknown>)[key])).join(',') + '}';
  throw new Error('NON_JSON_VALUE');
}
export function byteLength(value: unknown): number { return new TextEncoder().encode(canonical(value)).length; }
export function matchesInputSelector(input: Record<string, unknown>, selector: unknown): boolean {
  if (!selector || typeof selector !== 'object') return true;
  const s = selector as {kind?: unknown; values?: unknown};
  if (s.kind !== 'inputs' || !Array.isArray(s.values) || !s.values.length || s.values.length > LIMITS.selectors) return true;
  if (s.values.some(v => !v || typeof v !== 'object' || Array.isArray(v) || !Object.values(v).every(isScalar))) return true;
  return s.values.some(v => Object.entries(v).every(([key,expected]) => !Object.hasOwn(input,key) || input[key] === expected));
}
export function validateImpactResources(resources: ImpactResources): void {
  const entries = Object.entries(resources);
  if (entries.length > LIMITS.resources || byteLength(Object.fromEntries(entries.map(([id,r])=>[id,{scopeColumn:r.scopeColumn,columns:r.columns}]))) > LIMITS.manifestBytes) throw new Error('RESOURCE_LIMIT');
  for (const [id,r] of entries) {
    if (!id || id.length > 128 || !Array.isArray(r.columns) || new Set(r.columns).size !== r.columns.length) throw new Error('INVALID_RESOURCE');
    for (const name of [...r.columns,...(r.scopeColumn === null ? [] : [r.scopeColumn])]) if (!name || name.includes('\0')) throw new Error('INVALID_IDENTIFIER');
    if (r.scopeColumn !== null && !r.columns.includes(r.scopeColumn)) throw new Error('UNREGISTERED_COLUMN');
  }
}
export function validateImpactManifest(manifest: ImpactManifest, resources: ImpactResources): void {
  if (manifest.protocolVersion !== 1) throw new Error('UNSUPPORTED_MANIFEST_VERSION');
  if (Object.keys(manifest.reads).length > LIMITS.endpoints || byteLength({protocolVersion:manifest.protocolVersion,reads:manifest.reads}) > LIMITS.manifestBytes) throw new Error('MANIFEST_LIMIT');
  for (const [endpoint,reads] of Object.entries(manifest.reads)) {
    if (!endpoint || endpoint.length > 128) throw new Error('INVALID_ENDPOINT');
    for (const read of reads) {
      if (!Object.hasOwn(resources,read.resource)) throw new Error('UNREGISTERED_RESOURCE');
      const r = resources[read.resource];
      for (const c of [...(read.columns === '*' ? [] : read.columns),...read.bindings.map(b => b.column)]) if (!r.columns.includes(c)) throw new Error('UNREGISTERED_COLUMN');
      for (const b of read.bindings) if (!b.input || b.input.length > 128) throw new Error('INVALID_BINDING');
    }
  }
  // Even full widening must fit the output budget.
  const broad = Object.keys(manifest.reads).flatMap(endpoint => ['caller','global'].map(scope => ({endpoint,scope,selector:{kind:'all'}})));
  if (byteLength({protocolVersion:1,targets:broad}) > LIMITS.impactBytes) throw new Error('MANIFEST_TARGET_BUDGET');
}
