import type { Scalar, WriteSet } from '@server-driven-impact/core';
import type { ExecutableQueryPlan, Input, QueryManifest } from '../query/plan.js';
import type { Resources } from '../resources.js';

// Built-in adapters and the integration SDK bind the private collector contract.
export const bindAdapter: unique symbol = Symbol('sdi.adapter');
export type SelectExecutor = (plan: ExecutableQueryPlan, input: Input) => Promise<unknown[]>;
export interface VerifiedStringComparison { endpoint: string; input: string }
export function verifiedStringComparisons(
  manifest: QueryManifest,
  exactColumn: (resource: string, column: string) => boolean,
): readonly VerifiedStringComparison[] {
  const result: VerifiedStringComparison[] = [];
  for (const [endpoint,reads] of Object.entries(manifest.reads)) {
    const inputs = new Set(reads.flatMap(read => read.bindings.map(binding => binding.input)));
    for (const input of inputs) {
      const bindings = reads.flatMap(read => read.bindings.filter(binding => binding.input === input).map(binding => ({resource:read.resource,column:binding.column})));
      if (bindings.length && bindings.every(binding => exactColumn(binding.resource,binding.column))) result.push({endpoint,input});
    }
  }
  return Object.freeze(result.map(proof => Object.freeze(proof)));
}
export interface BoundAdapter<Db> {
  readonly artifact?: string;
  validate(): Promise<void>;
  /** Available only after validate() has checked the live database catalog. */
  verifiedStringComparisons?(): readonly VerifiedStringComparison[];
  query<T>(scope: Scalar, work: (select: SelectExecutor) => Promise<T>): Promise<T>;
  command<T>(scope: Scalar, writes: WriteSet, work: (db: Db) => Promise<T>): Promise<T>;
}
export interface ImpactAdapter<Db> {
  readonly [bindAdapter]: (resources: Resources, manifest: QueryManifest) => BoundAdapter<Db>;
}

export { guardDatabase } from './guard.js';
export { CommitStateUnknownError, ImpactUnavailableError, isCommitOutcomeError } from './errors.js';
export { identityColumns, validateResources } from '../resources.js';
export type { Resource, Resources } from '../resources.js';
export type { QueryManifest } from '../query/plan.js';
