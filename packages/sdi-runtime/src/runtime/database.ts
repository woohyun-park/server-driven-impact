import { isScalar, type Scalar } from '@server-driven-impact/core';
import { identityColumns, type Resources } from '../resources.js';
import { q, type Predicate, type SelectOptions } from '../query/plan.js';

export type Where = Record<string, Scalar> | Predicate[];
export type DataRow = Record<string, unknown>;
export interface WriteResult { count: number; rows: DataRow[] }
export interface InsertOptions { returnRows?: boolean }
export interface UpdateOptions extends InsertOptions { where: Where; set: DataRow }
export interface CommandDb {
  select(resource: string, options?: SelectOptions): Promise<DataRow[]>;
  insert(resource: string, rows: DataRow[], options?: InsertOptions): Promise<WriteResult>;
  update(resource: string, options: UpdateOptions): Promise<WriteResult>;
  delete(resource: string, options: { where: Where }): Promise<WriteResult>;
  savepoint<T>(work: (db: CommandDb) => Promise<T>): Promise<T>;
}
export function predicates(where: Where): Predicate[] {
  if (Array.isArray(where)) return where;
  if (!where || typeof where !== 'object' || Object.getPrototypeOf(where) !== Object.prototype) throw new Error('INVALID_WHERE');
  return Object.entries(where).map(([field, value]) => {
    if (!isScalar(value)) throw new Error('NON_SCALAR_WHERE');
    return value === null ? q.filter(field, 'is-null') : q.eq(field, q.literal(value));
  });
}
export function validatePatch(resource: string, patch: DataRow, resources: Resources): void {
  if (!Object.hasOwn(resources, resource)) throw new Error('UNREGISTERED_RESOURCE');
  if (!patch || !Object.keys(patch).length) throw new Error('EMPTY_PATCH');
  if (identityColumns(resources[resource]).some(column => Object.hasOwn(patch,column))) throw new Error('PRIMARY_KEY_UPDATE_UNSUPPORTED');
  for (const [column, value] of Object.entries(patch)) {
    if (!resources[resource].columns.includes(column)) throw new Error('UNREGISTERED_COLUMN');
    if (value === undefined || typeof value === 'function' || typeof value === 'symbol') throw new Error('INVALID_WRITE_VALUE');
  }
}
