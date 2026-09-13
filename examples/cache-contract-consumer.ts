import type { Scalar } from '@server-driven-impact/core';
import type { CacheContractReference, CacheInvalidationSet } from '@server-driven-impact/cache-contract';
import { applyCacheInvalidations } from '@server-driven-impact/tanstack-query';
import type { QueryClient } from '@tanstack/query-core';

/** An application transport maps ImpactUnavailableError to committed + business data. */
export interface CommittedReply<T> {
  commitState: 'committed';
  data: T;
  cacheInvalidation?: CacheInvalidationSet;
}
export type ConsumptionResult<T> =
  | { status: 'retired-session' }
  | { status: 'committed'; data: T; followUpErrors: unknown[] };

/** Example application coordinator, deliberately not part of the SDI executor. */
export async function consumeCommittedReply<T>(options: {
  response: Promise<CommittedReply<T>>;
  queryClient: QueryClient; // Captured at request start; never look up a new user's client.
  contract: CacheContractReference;
  scope: Scalar;
  isCurrentSession: () => boolean; // Compare an auth generation, not just a user ID.
  afterCommit: (data: T) => Promise<void>;
}): Promise<ConsumptionResult<T>> {
  const response = await options.response; // Transport/unknown-commit failures are handled outside.
  if (!options.isCurrentSession()) return { status: 'retired-session' };
  const followUpErrors: unknown[] = [];
  try {
    await options.afterCommit(response.data);
  } catch (error) {
    followUpErrors.push(error);
  }
  if (!options.isCurrentSession()) return { status: 'retired-session' };
  try {
    if (response.cacheInvalidation) {
      await applyCacheInvalidations(options.queryClient, response.cacheInvalidation, {
        contract: options.contract,
        scope: options.scope,
        cancelInFlight: true,
      });
    } else {
      // No trustworthy impact instructions after a committed failure: broad resync.
      await options.queryClient.cancelQueries();
      if (!options.isCurrentSession()) return { status: 'retired-session' };
      await options.queryClient.invalidateQueries({}, { throwOnError: true });
    }
  } catch (error) {
    followUpErrors.push(error);
  }
  if (!options.isCurrentSession()) return { status: 'retired-session' };
  // Follow-up errors are for refresh UI/telemetry, never command retry or rollback.
  return { status: 'committed', data: response.data, followUpErrors };
}
