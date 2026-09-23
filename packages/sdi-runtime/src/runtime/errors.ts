export class CommitStateUnknownError extends Error {
  readonly code = 'COMMIT_STATE_UNKNOWN';
  readonly commitState = 'unknown' as const;
  constructor(options?: ErrorOptions) {
    super('COMMIT_STATE_UNKNOWN', options);
    this.name = 'CommitStateUnknownError';
  }
}
