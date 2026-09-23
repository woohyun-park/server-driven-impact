import {
  LIMITS,
  byteLength,
  type Assessment,
  type ImpactManifest,
  type ImpactReasonCode,
  type ImpactSet,
  type ValidationReport,
} from './contracts.js';

export function validationReport(
  manifest: ImpactManifest,
  assessment: Assessment = { status: 'verified' },
): ValidationReport {
  return {
    endpoints: Object.fromEntries(
      Object.keys(manifest.reads)
        .sort()
        .map(endpoint => [endpoint, structuredClone(assessment)]),
    ),
  };
}
export function mergeAssessment(left: Assessment, right: Assessment): Assessment {
  const status =
    left.status === 'unavailable' || right.status === 'unavailable'
      ? 'unavailable'
      : left.status === 'conservative' || right.status === 'conservative'
        ? 'conservative'
        : 'verified';
  return status === 'verified'
    ? { status }
    : {
        status,
        codes: [
          ...new Set([
            ...(left.status === 'verified' ? [] : left.codes),
            ...(right.status === 'verified' ? [] : right.codes),
          ]),
        ].sort(),
      };
}
export function assessResource(
  report: ValidationReport,
  manifest: ImpactManifest,
  resource: string,
  assessment: Assessment,
): void {
  for (const [endpoint, reads] of Object.entries(manifest.reads))
    if (reads.some(read => read.resource === resource))
      report.endpoints[endpoint] = mergeAssessment(report.endpoints[endpoint], assessment);
}
export function unavailableImpact(manifest: ImpactManifest, code: ImpactReasonCode): ImpactSet {
  return {
    endpoints: Object.fromEntries(
      Object.keys(manifest.reads)
        .sort()
        .map(endpoint => [endpoint, { status: 'unavailable', codes: [code] }]),
    ),
  };
}
export function applyAssessment(
  impact: ImpactSet,
  report: ValidationReport,
  onWiden?: (endpoint: string) => void,
): ImpactSet {
  for (const [endpoint, value] of Object.entries(impact.endpoints)) {
    const assessment = mergeAssessment(
      value,
      report.endpoints[endpoint] ?? { status: 'unavailable', codes: ['VALIDATION_FAILED'] },
    );
    impact.endpoints[endpoint] =
      assessment.status === 'unavailable' ? assessment : { ...assessment, targets: value.targets ?? [] };
  }
  return boundImpact(impact, onWiden);
}
/** Include endpoint names, assessments and the envelope in the wire budget. */
export function boundImpact(impact: ImpactSet, onWiden?: (endpoint: string) => void): ImpactSet {
  while (byteLength(impact) > LIMITS.impactBytes) {
    const candidates = Object.entries(impact.endpoints)
      .flatMap(([endpoint, value]) =>
        (value.targets ?? [])
          .filter(target => target.selector.kind === 'inputs')
          .map(target => ({ endpoint, target, bytes: byteLength(target) })),
      )
      .sort(
        (a, b) =>
          b.bytes - a.bytes ||
          (a.endpoint < b.endpoint ? -1 : a.endpoint > b.endpoint ? 1 : a.target.scope < b.target.scope ? -1 : 1),
      );
    const largest = candidates[0];
    if (!largest) throw new Error('MANIFEST_TARGET_BUDGET');
    largest.target.selector = { kind: 'all' };
    const value = impact.endpoints[largest.endpoint];
    impact.endpoints[largest.endpoint] = {
      status: 'conservative',
      codes: [...new Set([...(value.status === 'verified' ? [] : value.codes), 'PRECISION_REDUCED' as const])].sort(),
      targets: value.targets!,
    };
    onWiden?.(largest.endpoint);
  }
  return impact;
}
