import { byteLength, canonical, isScalar, type Scalar } from '@server-driven-impact/core';
import { CACHE_LIMITS, isCacheValue, type CacheContractReference, type CacheInvalidationSet } from '@server-driven-impact/cache-contract';
import { matchQuery, type QueryClient } from '@tanstack/query-core';

export type RefetchType = 'active' | 'inactive' | 'all' | 'none';

export type QueryClientLike = Pick<QueryClient, 'invalidateQueries' | 'cancelQueries'>;

export interface ApplyCacheInvalidationsOptions {
  contract: CacheContractReference;
  scope: Scalar;
  refetchType?: RefetchType;
  cancelRefetch?: boolean;
  /** Also cancels first reads that have no cached data. Default: false. */
  cancelInFlight?: boolean;
  /** Propagate refetch failures separately from the already committed command. Default: true. */
  throwOnError?: boolean;
}

function exactMatch(candidate: unknown, filter: unknown): boolean {
  try { return canonical(candidate) === canonical(filter); }
  catch { return false; }
}

export function validateCacheInvalidationSet(
  payload: unknown,
  expected: Pick<ApplyCacheInvalidationsOptions, 'contract' | 'scope'>,
): asserts payload is CacheInvalidationSet {
  if (!payload || typeof payload !== 'object') throw new Error('UNSUPPORTED_CACHE_INVALIDATION_PROTOCOL');
  const candidate = payload as CacheInvalidationSet;
  validatePayload(candidate, expected);
}

function validatePayload(payload: CacheInvalidationSet, expected: Pick<ApplyCacheInvalidationsOptions, 'contract' | 'scope'>): void {
  if (!payload || payload.protocolVersion !== 1) throw new Error('UNSUPPORTED_CACHE_INVALIDATION_PROTOCOL');
  if (typeof payload.contractId !== 'string' || !payload.contractId.length || !Number.isSafeInteger(payload.contractVersion) || payload.contractVersion < 1) {
    throw new Error('INVALID_CACHE_CONTRACT_REFERENCE');
  }
  if (!isScalar(payload.scope) || !isScalar(expected.scope)) throw new Error('INVALID_CACHE_SCOPE');
  if (payload.contractId !== expected.contract.id || payload.contractVersion !== expected.contract.version) {
    throw new Error('CACHE_CONTRACT_MISMATCH');
  }
  if (!exactMatch(payload.scope, expected.scope)) throw new Error('CACHE_SCOPE_MISMATCH');
  if (!Array.isArray(payload.invalidations) || payload.invalidations.length > CACHE_LIMITS.invalidations) throw new Error('INVALID_CACHE_INVALIDATIONS');
  for (const invalidation of payload.invalidations) {
    if (!invalidation || !Array.isArray(invalidation.queryKey) || !invalidation.queryKey.length || !isCacheValue(invalidation.queryKey) || typeof invalidation.exact !== 'boolean') {
      throw new Error('INVALID_CACHE_INVALIDATION');
    }
  }
  if (byteLength(payload) > CACHE_LIMITS.responseBytes) throw new Error('CACHE_INVALIDATION_BYTE_LIMIT');
}

/**
 * Invalidates the union of all instructions through one TanStack Query call.
 * Await the returned promise when mutation completion must include active refetches.
 */
export async function applyCacheInvalidations(
  queryClient: QueryClientLike,
  payload: unknown,
  options: ApplyCacheInvalidationsOptions,
): Promise<void> {
  validateCacheInvalidationSet(payload, options);
  const unique = structuredClone([...new Map(payload.invalidations.map(value => [`${value.exact}:${canonical(value.queryKey)}`, value])).values()]);
  if (!unique.length) return;
  const predicate: NonNullable<Parameters<QueryClient['invalidateQueries']>[0]>['predicate'] =
    query => unique.some(invalidation => matchQuery(invalidation,query));
  if (options.cancelInFlight) await queryClient.cancelQueries({predicate});
  await queryClient.invalidateQueries({
    predicate,
    refetchType: options.refetchType ?? 'active',
  }, {cancelRefetch: options.cancelRefetch,throwOnError:options.throwOnError ?? true});
}
