import { byteLength, canonical, isScalar, LIMITS, type ImpactSet, type Scalar } from '@server-driven-impact/core';
import type {
  CacheCompileOptions,
  CacheContract,
  CacheContractReference,
  CacheDiagnosticReason,
  CacheEndpoint,
  CacheInvalidation,
  CacheInvalidationSet,
  CacheQueryContract,
  CacheValue,
  QueryKey,
  StringComparisonStatus,
} from './types.js';
import { isCacheValue, isRecord, normalizeFields, own, selectorValue, validateFields } from './input.js';
import { renderKey, validateFallback, validateKeySeparation, validateTemplate } from './template.js';
export type * from './types.js';
export { isCacheValue } from './input.js';

export const CACHE_LIMITS = Object.freeze({
  contracts: 32,
  queries: 512,
  invalidations: 512,
  contractBytes: 1_048_576,
  responseBytes: 131_072,
});
const validated = new WeakSet<CacheContract>();
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
function name(value: unknown, code: string): asserts value is string {
  if (typeof value !== 'string' || !value.length) throw new Error(code);
}
export function defineCacheContract<const T extends CacheContract>(contract: T): T {
  if (validated.has(contract)) return contract;
  if (!isCacheValue(contract)) throw new Error('INVALID_CACHE_CONTRACT_JSON');
  name(contract.id, 'INVALID_CACHE_CONTRACT_ID');
  if (!Number.isSafeInteger(contract.version) || contract.version < 1)
    throw new Error('INVALID_CACHE_CONTRACT_VERSION');
  if (!Array.isArray(contract.queries)) throw new Error('CACHE_QUERIES_REQUIRED');
  if (contract.queries.length > CACHE_LIMITS.queries) throw new Error('CACHE_QUERY_LIMIT');
  if (byteLength(contract) > CACHE_LIMITS.contractBytes) throw new Error('CACHE_CONTRACT_BYTE_LIMIT');
  const snapshot = structuredClone(contract);
  const operations = new Set<string>();
  for (const query of snapshot.queries) {
    name(query.operationId, 'INVALID_CACHE_OPERATION_ID');
    name(query.endpoint, 'INVALID_CACHE_ENDPOINT');
    if (operations.has(query.operationId)) throw new Error('DUPLICATE_CACHE_OPERATION:' + query.operationId);
    operations.add(query.operationId);
    if (!['query', 'infinite'].includes(query.kind)) throw new Error('INVALID_CACHE_QUERY_KIND');
    if (query.invalidation !== undefined && !['preserve', 'endpoint'].includes(query.invalidation))
      throw new Error('INVALID_CACHE_INVALIDATION_POLICY');
    validateFields(query.input);
    if (query.pageInput) {
      if (query.kind !== 'infinite') throw new Error('CACHE_PAGE_INPUT_REQUIRES_INFINITE');
      validateFields(query.pageInput);
      if (Object.keys(query.pageInput).some(field => own(query.input, field)))
        throw new Error('CACHE_PAGE_INPUT_OVERLAP');
    }
    validateTemplate(query);
    validateFallback(query);
  }
  validateKeySeparation(snapshot.queries);
  const excluded = new Set<string>();
  if (snapshot.excludedEndpoints !== undefined && !Array.isArray(snapshot.excludedEndpoints))
    throw new Error('INVALID_CACHE_EXCLUSIONS');
  for (const entry of snapshot.excludedEndpoints ?? []) {
    name(entry.endpoint, 'INVALID_CACHE_ENDPOINT');
    if (!['no-store', 'not-consumed'].includes(entry.reason)) throw new Error('INVALID_CACHE_EXCLUSION_REASON');
    if (excluded.has(entry.endpoint) || snapshot.queries.some(query => query.endpoint === entry.endpoint))
      throw new Error('DUPLICATE_CACHE_ENDPOINT_POLICY:' + entry.endpoint);
    excluded.add(entry.endpoint);
  }
  validated.add(snapshot);
  return deepFreeze(snapshot);
}

/** Inventory is supplied by a runtime or SDK generator, not inferred from impacts. */
export function validateCacheContractCoverage(candidate: CacheContract, endpoints: readonly CacheEndpoint[]): void {
  const contract = defineCacheContract(candidate);
  const inventory = new Map<string, CacheEndpoint>();
  for (const endpoint of endpoints) {
    name(endpoint.endpoint, 'INVALID_CACHE_ENDPOINT');
    if (!['cacheable', 'no-store'].includes(endpoint.cache)) throw new Error('INVALID_CACHE_ENDPOINT_POLICY');
    if (inventory.has(endpoint.endpoint)) throw new Error('DUPLICATE_CACHE_INVENTORY_ENDPOINT:' + endpoint.endpoint);
    inventory.set(endpoint.endpoint, endpoint);
    const excluded = contract.excludedEndpoints?.find(entry => entry.endpoint === endpoint.endpoint);
    const registered = contract.queries.some(query => query.endpoint === endpoint.endpoint);
    if (!excluded && !registered) throw new Error('CACHE_ENDPOINT_UNCOVERED:' + endpoint.endpoint);
    if (endpoint.cache === 'no-store' && registered)
      throw new Error('CACHE_ENDPOINT_REQUIRES_NO_STORE:' + endpoint.endpoint);
    if (endpoint.cache === 'cacheable' && excluded?.reason === 'no-store')
      throw new Error('CACHE_ENDPOINT_NOT_NO_STORE:' + endpoint.endpoint);
  }
  for (const entry of [...contract.queries, ...(contract.excludedEndpoints ?? [])]) {
    if (!inventory.has(entry.endpoint)) throw new Error('CACHE_ENDPOINT_NOT_REGISTERED:' + entry.endpoint);
  }
}
function operation(contract: CacheContract, operationId: string): CacheQueryContract {
  const query = defineCacheContract(contract).queries.find(candidate => candidate.operationId === operationId);
  if (!query) throw new Error('UNKNOWN_CACHE_OPERATION:' + operationId);
  return query;
}
function normalize(query: CacheQueryContract, input: Record<string, unknown>): Record<string, CacheValue> {
  const normalized = normalizeFields(query.input, input);
  if (!('template' in query.key)) {
    const params = query.key.params?.filter(field => own(normalized, field)) ?? [];
    if (params.length && query.key.paramsAnchor?.some(field => !own(normalized, field)))
      throw new Error('CACHE_PARAMS_ANCHOR_REQUIRED');
  }
  return normalized;
}
export function normalizeCacheInput(
  contract: CacheContract,
  operationId: string,
  input: Record<string, unknown>,
): Record<string, CacheValue> {
  return normalize(operation(contract, operationId), input);
}
/** Send this normalized input to the API as well as using its queryKey. */
export function prepareCacheQuery(
  contract: CacheContract,
  operationId: string,
  input: Record<string, unknown>,
): { input: Record<string, CacheValue>; queryKey: QueryKey } {
  const query = operation(contract, operationId);
  const normalized = normalize(query, input);
  return { input: normalized, queryKey: renderKey(query, normalized).queryKey };
}
export function buildQueryKey(contract: CacheContract, operationId: string, input: Record<string, unknown>): QueryKey {
  return prepareCacheQuery(contract, operationId, input).queryKey;
}
export function buildQueryExecutionInput(
  contract: CacheContract,
  operationId: string,
  input: Record<string, unknown>,
  pageInput: Record<string, unknown>,
): Record<string, CacheValue> {
  const query = operation(contract, operationId);
  if (query.kind !== 'infinite') throw new Error('CACHE_PAGE_INPUT_REQUIRES_INFINITE');
  return { ...normalize(query, input), ...normalizeFields(query.pageInput ?? {}, pageInput, 'pageInput') };
}

type Decision = { filters: CacheInvalidation[]; reason: CacheDiagnosticReason };
function broad(query: CacheQueryContract, reason: CacheDiagnosticReason): Decision {
  return { filters: [{ queryKey: query.fallback, exact: false }], reason };
}
type StringComparison = (endpoint: string, input: string) => StringComparisonStatus;
function forValue(
  query: CacheQueryContract,
  value: Record<string, Scalar>,
  stringComparison?: StringComparison,
): Decision {
  const known: Record<string, CacheValue> = Object.create(null);
  const flat = 'template' in query.key ? undefined : query.key;
  const anchors = flat?.paramsAnchor ?? [];
  for (const [field, expected] of Object.entries(value)) {
    if (query.pageInput && own(query.pageInput, field)) return broad(query, 'page-input');
    if (!own(query.input, field)) return broad(query, 'input-unrepresentable');
    const definition = query.input[field];
    // A default can hide an omitted field, which protocol 1 must also match.
    if (own(definition, 'default') || (!definition.required && !anchors.includes(field)))
      return broad(query, 'missing-field');
    const stringStatus =
      definition.type === 'string' && definition.required && !definition.coerce && definition.format !== 'uuid'
        ? stringComparison?.(query.endpoint, field)
        : undefined;
    const normalized = selectorValue(definition, expected, stringStatus === 'verified');
    if (normalized === undefined) return broad(query, 'comparison-unproven');
    known[field] = normalized;
  }
  if (flat) {
    if ((flat.path ?? []).some(field => !own(known, field))) return broad(query, 'missing-field');
    const base: CacheValue[] = [...flat.prefix, ...(flat.path ?? []).map(field => known[field])];
    const selectedParams = (flat.params ?? []).filter(field => own(known, field));
    if (!selectedParams.length) return { filters: [{ queryKey: base, exact: !flat.params }], reason: 'precise' };
    if (selectedParams.some(field => !query.input[field].required)) {
      if (!anchors.length || !anchors.every(field => own(known, field))) return broad(query, 'missing-field');
      return {
        filters: [
          { queryKey: flat.omitEmptyParams ? base : [...base, {}], exact: true },
          { queryKey: [...base, Object.fromEntries(selectedParams.map(field => [field, known[field]]))], exact: false },
        ],
        reason: 'precise',
      };
    }
  }
  return { filters: [renderKey(query, known, true)], reason: 'precise' };
}
export function validateCacheCompileOptions(options: CacheCompileOptions): void {
  for (const [value, maximum] of [
    [options.maxInvalidations, CACHE_LIMITS.invalidations],
    [options.maxBytes, CACHE_LIMITS.responseBytes],
  ]) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1 || value > maximum!))
      throw new Error('INVALID_CACHE_COMPILE_LIMIT');
  }
  if (options.explain !== undefined && typeof options.explain !== 'function') throw new Error('INVALID_CACHE_EXPLAIN');
}
function compile(
  candidate: CacheContract,
  impact: ImpactSet,
  scope: Scalar,
  options: CacheCompileOptions,
  stringComparison?: StringComparison,
): CacheInvalidationSet {
  const contract = defineCacheContract(candidate);
  validateCacheCompileOptions(options);
  if (!isScalar(scope)) throw new Error('INVALID_CACHE_SCOPE');
  if (impact?.protocolVersion !== 1) throw new Error('UNSUPPORTED_IMPACT_VERSION');
  if (!Array.isArray(impact.targets) || impact.targets.length > LIMITS.endpoints)
    throw new Error('INVALID_IMPACT_TARGETS');
  const invalidations: CacheInvalidation[] = [];
  const affected = new Set<CacheQueryContract>();
  for (const target of impact.targets) {
    if (!target || typeof target.endpoint !== 'string' || !['caller', 'global'].includes(target.scope))
      throw new Error('INVALID_IMPACT_TARGET');
    const queries = contract.queries.filter(query => query.endpoint === target.endpoint);
    if (!queries.length) {
      if (!contract.excludedEndpoints?.some(entry => entry.endpoint === target.endpoint))
        throw new Error('CACHE_ENDPOINT_UNCOVERED:' + target.endpoint);
      options.explain?.({ endpoint: target.endpoint, reason: 'excluded', filterCount: 0 });
      continue;
    }
    const selector = target.selector;
    // Mirror protocol-1's fail-open selector matching, never silently drop it.
    const values =
      selector?.kind === 'inputs' &&
      Array.isArray(selector.values) &&
      selector.values.length > 0 &&
      selector.values.length <= LIMITS.selectors &&
      selector.values.every(value => isRecord(value) && Object.values(value).every(isScalar))
        ? selector.values
        : undefined;
    for (const query of queries) {
      affected.add(query);
      const decisions =
        query.invalidation === 'endpoint'
          ? [broad(query, 'endpoint-policy')]
          : values
            ? values.map(value => forValue(query, value, stringComparison))
            : [broad(query, 'all')];
      for (const decision of decisions) {
        invalidations.push(...decision.filters);
        options.explain?.({
          endpoint: query.endpoint,
          operationId: query.operationId,
          reason: decision.reason,
          selectorKind: values ? 'inputs' : 'all',
          selectorFields: values ? [...new Set(values.flatMap(Object.keys))].sort() : [],
          filterCount: decision.filters.length,
        });
      }
    }
  }
  const unique = (values: CacheInvalidation[]) => [
    ...new Map(values.map(value => [value.exact + ':' + canonical(value.queryKey), value])).values(),
  ];
  const payload = (values: CacheInvalidation[]): CacheInvalidationSet => ({
    protocolVersion: 1,
    contractId: contract.id,
    contractVersion: contract.version,
    scope,
    invalidations: unique(values),
  });
  const fits = (value: CacheInvalidationSet) =>
    value.invalidations.length <= (options.maxInvalidations ?? CACHE_LIMITS.invalidations) &&
    byteLength(value) <= (options.maxBytes ?? CACHE_LIMITS.responseBytes);
  let result = payload(invalidations);
  if (!fits(result)) {
    result = payload(
      [...affected].flatMap(query => {
        options.explain?.({
          endpoint: query.endpoint,
          operationId: query.operationId,
          reason: 'budget',
          filterCount: 1,
        });
        return broad(query, 'budget').filters;
      }),
    );
  }
  if (!fits(result)) throw new Error('CACHE_INVALIDATION_LIMIT');
  return deepFreeze(result);
}
export function compileCacheInvalidations(
  candidate: CacheContract,
  impact: ImpactSet,
  scope: Scalar,
  options: CacheCompileOptions = {},
): CacheInvalidationSet {
  return compile(candidate, impact, scope, options);
}
export function cacheContractOpenApiExtension(candidate: CacheContract): Readonly<Record<string, unknown>> {
  const contract = defineCacheContract(candidate);
  return deepFreeze({
    contractId: contract.id,
    contractVersion: contract.version,
    queries: contract.queries,
    excludedEndpoints: contract.excludedEndpoints ?? [],
  });
}
export interface CacheContractRegistry {
  resolve(reference: CacheContractReference): CacheContract;
  compile(reference: CacheContractReference, impact: ImpactSet, scope: Scalar): CacheInvalidationSet;
}
export function createCacheContractRegistry(
  contracts: readonly CacheContract[],
  options: {
    endpoints?: readonly CacheEndpoint[];
    compile?: CacheCompileOptions;
    /** Runtime-owned evidence. Ordinary consumers should use compileCacheInvalidations. */
    stringComparison?: StringComparison;
  } = {},
): CacheContractRegistry {
  if (contracts.length > CACHE_LIMITS.contracts) throw new Error('CACHE_CONTRACT_LIMIT');
  const compileOptions = { ...options.compile };
  validateCacheCompileOptions(compileOptions);
  const entries = new Map<string, CacheContract>();
  for (const candidate of contracts) {
    const contract = defineCacheContract(candidate);
    if (options.endpoints) validateCacheContractCoverage(contract, options.endpoints);
    const key = contract.id + ':' + contract.version;
    if (entries.has(key)) throw new Error('DUPLICATE_CACHE_CONTRACT:' + key);
    entries.set(key, contract);
  }
  const resolve = (reference: CacheContractReference) => {
    const contract = entries.get(reference.id + ':' + reference.version);
    if (!contract) throw new Error('UNSUPPORTED_CACHE_CONTRACT:' + reference.id + ':' + reference.version);
    return contract;
  };
  return Object.freeze({
    resolve,
    compile(reference: CacheContractReference, impact: ImpactSet, scope: Scalar) {
      return compile(resolve(reference), impact, scope, compileOptions, options.stringComparison);
    },
  });
}
