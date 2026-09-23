import type { ImpactSet } from '@server-driven-impact/core';

/** Inspect calculated targets in precision tests; unavailability must never pass as no impact. */
export function affectedTargets(impact: ImpactSet) {
  return Object.entries(impact.endpoints).flatMap(([endpoint, value]) => {
    if (value.status === 'unavailable')
      throw new Error(`Unexpected unavailable endpoint: ${endpoint} (${value.codes.join(',')})`);
    return value.targets.map(target => ({ endpoint, ...target }));
  });
}
