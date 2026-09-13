import type { Scalar } from '@server-driven-impact/core';

export type CacheValue = Scalar | readonly CacheValue[] | { readonly [key: string]: CacheValue };
export type QueryKey = readonly CacheValue[];
export type CacheInputType = 'string' | 'number' | 'boolean' | 'date-time' | 'array' | 'object';
interface FieldOptions {
  required?: boolean;
  nullable?: boolean;
  default?: CacheValue;
}
export type CacheInputField =
  | (FieldOptions & {
      type: 'string' | 'number' | 'boolean' | 'date-time';
      coerce?: boolean;
      exclude?: readonly Scalar[];
      /** Finite normalized domain; also permits exhaustive equality proofs. */
      enum?: readonly Scalar[];
      /** UUID input is validated and lowercased on both request and key paths. */
      format?: 'uuid';
    })
  | (FieldOptions & { type: 'array'; items: CacheInputField; order?: 'preserve' | 'set' })
  | (FieldOptions & { type: 'object'; properties: Readonly<Record<string, CacheInputField>> });

/** Tagged nodes avoid confusing literal user objects with template instructions. */
export type CacheKeyNode =
  | { kind: 'literal'; value: CacheValue }
  | { kind: 'input'; field: string }
  | { kind: 'inputs'; fields?: readonly string[]; omitEmpty?: boolean }
  | { kind: 'array'; items: readonly CacheKeyNode[] }
  | { kind: 'object'; fields: Readonly<Record<string, CacheKeyNode>> };

export interface FlatCacheKeyTemplate {
  prefix: QueryKey;
  path?: readonly string[];
  params?: readonly string[];
  /** Required whenever a nonempty params object is present. */
  paramsAnchor?: readonly string[];
  omitEmptyParams?: boolean;
}
export type CacheKeyTemplate = FlatCacheKeyTemplate | { template: CacheKeyNode };
export interface CacheQueryContract {
  operationId: string;
  endpoint: string;
  kind: 'query' | 'infinite';
  input: Readonly<Record<string, CacheInputField>>;
  /** Execution-only page values, never accepted by buildQueryKey. Infinite only. */
  pageInput?: Readonly<Record<string, CacheInputField>>;
  key: CacheKeyTemplate;
  /** Partial TanStack filter proven to cover all generated operation keys. */
  fallback: QueryKey;
  invalidation?: 'preserve' | 'endpoint';
}
export interface CacheContract {
  id: string;
  version: number;
  queries: readonly CacheQueryContract[];
  excludedEndpoints?: readonly { endpoint: string; reason: 'no-store' | 'not-consumed' }[];
}
export interface CacheContractReference {
  id: string;
  version: number;
}
export interface CacheInvalidation {
  queryKey: QueryKey;
  exact: boolean;
}
export interface CacheInvalidationSet {
  protocolVersion: 1;
  contractId: string;
  contractVersion: number;
  scope: Scalar;
  invalidations: readonly CacheInvalidation[];
}
export type CacheDiagnosticReason =
  | 'all'
  | 'endpoint-policy'
  | 'precise'
  | 'missing-field'
  | 'comparison-unproven'
  | 'input-unrepresentable'
  | 'page-input'
  | 'budget'
  | 'excluded';
export interface CacheDiagnostic {
  endpoint: string;
  operationId?: string;
  reason: CacheDiagnosticReason;
  selectorKind?: 'all' | 'inputs';
  selectorFields?: readonly string[];
  filterCount: number;
}
export interface CacheCompileOptions {
  /** Metadata only: no selector values or user input are sent to this callback. */
  explain?: (diagnostic: CacheDiagnostic) => void;
  maxInvalidations?: number;
  maxBytes?: number;
}
export interface CacheEndpoint {
  endpoint: string;
  cache: 'cacheable' | 'no-store';
}
export type StringComparisonStatus = 'verified' | 'comparison-unproven';
