export type CommitState = 'committed' | 'unknown';

import { ImpactUnavailableError } from '@server-driven-impact/core';
export { ImpactUnavailableError };

export class CommitStateUnknownError extends Error {
  readonly code = 'COMMIT_STATE_UNKNOWN';
  readonly commitState = 'unknown' as const;
  constructor(options?: ErrorOptions) {
    super('COMMIT_STATE_UNKNOWN', options);
    this.name = 'CommitStateUnknownError';
  }
}

export function isCommitOutcomeError(value: unknown): value is ImpactUnavailableError | CommitStateUnknownError {
  return value instanceof ImpactUnavailableError || value instanceof CommitStateUnknownError;
}
