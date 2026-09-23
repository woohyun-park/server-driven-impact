import type { Scalar, WriteSet, ValidationReport } from '@server-driven-impact/core';
import type { ExecutableQueryPlan, Input, QueryManifest } from '../query/plan.js';
import type { Resources } from '../resources.js';

// Built-in adapters and the integration SDK bind the private collector contract.
export const bindAdapter: unique symbol = Symbol('sdi.adapter');
export type SelectExecutor = (plan: ExecutableQueryPlan, input: Input) => Promise<unknown[]>;
export interface BoundAdapter<Db> {
  readonly artifact?: string;
  validate(): Promise<ValidationReport>;
  query<T>(scope: Scalar, work: (select: SelectExecutor) => Promise<T>): Promise<T>;
  command<T>(
    scope: Scalar,
    writes: WriteSet,
    work: (db: Db) => Promise<T>,
  ): Promise<{ data: T; assessment: ValidationReport }>;
}
export interface ImpactAdapter<Db> {
  readonly [bindAdapter]: (resources: Resources, manifest: QueryManifest) => BoundAdapter<Db>;
}

export { guardDatabase } from './guard.js';
export { CommitStateUnknownError } from './errors.js';
export { identityColumns, validateResources } from '../resources.js';
export type { Resource, Resources } from '../resources.js';
export type { QueryManifest } from '../query/plan.js';
