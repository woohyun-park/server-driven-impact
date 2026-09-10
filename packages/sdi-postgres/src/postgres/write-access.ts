import { identityColumns, type Resources } from '@server-driven-impact/runtime/adapter';

/** Omitted policy preserves existing access. An explicit map defaults to read-only. */
export type PostgresWriteAccess = Readonly<Record<string, {
  insert?: boolean;
  update?: true | readonly string[];
  delete?: boolean;
}>>;

export function snapshotWriteAccess(policy: PostgresWriteAccess | undefined): PostgresWriteAccess | undefined {
  if (policy === undefined) return undefined;
  return Object.freeze(Object.fromEntries(Object.entries(policy).map(([id, access]) => [id, Object.freeze({
    ...access, ...(Array.isArray(access.update) ? { update: Object.freeze([...access.update]) } : {}),
  })])));
}
export function validateWriteAccess(policy: PostgresWriteAccess | undefined, resources: Resources): void {
  for (const [id, access] of Object.entries(policy ?? {})) {
    if (!Object.hasOwn(resources,id)) throw new Error(`UNREGISTERED_WRITE_RESOURCE:${id}`);
    for (const column of Array.isArray(access.update) ? access.update : [])
      if (!resources[id].columns.includes(column) || identityColumns(resources[id]).includes(column)) throw new Error(`INVALID_UPDATE_COLUMN:${id}:${column}`);
  }
}
export function assertWriteAccess(policy: PostgresWriteAccess | undefined, resource: string, operation: 'insert'|'update'|'delete', columns: readonly string[] = []): void {
  if (policy === undefined) return;
  const permission = Object.hasOwn(policy,resource) ? policy[resource][operation] : undefined;
  if (permission === true) return;
  if (operation === 'update' && Array.isArray(permission) && columns.length && columns.every(column => permission.includes(column))) return;
  throw new Error(`WRITE_NOT_ALLOWED:${resource}:${operation}`);
}
