import type { Scalar, WriteSet } from '@server-driven-impact/core';
import type { ExecutableQueryPlan, Input, QueryManifest } from '../query/plan.js';
import type { Resources } from '../resources.js';

// Built-in adapters and the integration SDK bind the private collector contract.
export const bindAdapter: unique symbol = Symbol('sdi.adapter');
export type SelectExecutor = (plan: ExecutableQueryPlan, input: Input) => Promise<unknown[]>;
export interface BoundAdapter<Db> {
  readonly artifact?: string;
  validate(): Promise<void>;
  query<T>(scope: Scalar, work: (select: SelectExecutor) => Promise<T>): Promise<T>;
  command<T>(scope: Scalar, writes: WriteSet, work: (db: Db) => Promise<T>): Promise<T>;
}
export interface ImpactAdapter<Db> {
  readonly [bindAdapter]: (resources: Resources, manifest: QueryManifest) => BoundAdapter<Db>;
}

export { predicates, validatePatch } from './database.js';
export type { CommandDb, DataRow, InsertOptions, UpdateOptions, Where, WriteResult } from './database.js';
export { guardDatabase } from './guard.js';
export { CommitStateUnknownError, ImpactUnavailableError, isCommitOutcomeError } from './errors.js';
export { e, remoteDb } from './operations.js';
export type { Expr, OperationsDb, Row } from './operations.js';
export { identityColumns, validateResources } from '../resources.js';
export type { Resource, Resources } from '../resources.js';
export type { QueryManifest } from '../query/plan.js';
