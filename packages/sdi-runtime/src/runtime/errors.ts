export type CommitState = 'committed' | 'unknown';

export class ImpactUnavailableError<T = unknown> extends Error {
  readonly code = 'IMPACT_UNAVAILABLE';
  readonly commitState = 'committed' as const;
  readonly impactStatus = 'unavailable' as const;
  constructor(readonly data: T, options?: ErrorOptions) {
    super('IMPACT_UNAVAILABLE', options);
    this.name = 'ImpactUnavailableError';
  }
}

export class CommitStateUnknownError extends Error {
  readonly code = 'COMMIT_STATE_UNKNOWN';
  readonly commitState = 'unknown' as const;
  constructor(options?: ErrorOptions) {
    super('COMMIT_STATE_UNKNOWN', options);
    this.name = 'CommitStateUnknownError';
  }
}

export function isCommitOutcomeError(value: unknown): value is
  | ImpactUnavailableError
  | CommitStateUnknownError {
  return value instanceof ImpactUnavailableError || value instanceof CommitStateUnknownError;
}
