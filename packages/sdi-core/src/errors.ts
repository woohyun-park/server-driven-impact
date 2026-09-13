import type { ImpactSet } from './contracts.js';

export interface ImpactUnavailableOptions extends ErrorOptions {
  phase?: 'impact-calculation' | 'cache-invalidation';
  impact?: ImpactSet;
}

export class ImpactUnavailableError<T = unknown> extends Error {
  readonly code = 'IMPACT_UNAVAILABLE';
  readonly commitState = 'committed' as const;
  readonly impactStatus = 'unavailable' as const;
  readonly phase: 'impact-calculation' | 'cache-invalidation';
  readonly impact?: ImpactSet;
  constructor(
    readonly data: T,
    options?: ImpactUnavailableOptions,
  ) {
    super('IMPACT_UNAVAILABLE', options);
    this.name = 'ImpactUnavailableError';
    this.phase = options?.phase ?? 'impact-calculation';
    this.impact = options?.impact;
  }
}
