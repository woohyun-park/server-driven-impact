export class ImpactUnavailableError<T = unknown> extends Error {
  readonly code = 'IMPACT_UNAVAILABLE';
  readonly commitState = 'committed' as const;
  readonly impactStatus = 'unavailable' as const;
  constructor(readonly data: T, options?: ErrorOptions) {
    super('IMPACT_UNAVAILABLE', options);
    this.name = 'ImpactUnavailableError';
  }
}

