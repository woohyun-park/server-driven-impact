import { LIMITS, byteLength, validateImpactResources, type ImpactResource } from '@server-driven-impact/core';

export interface Resource extends ImpactResource {
  table: string;
  schema?: string;
  idColumn: string | readonly string[] | null;
  postgresKind?: 'materialized-view';
  physicalRelations?: readonly { schema: string; table: string }[];
  /** @deprecated Built-in adapters derive selector columns from Query Plans. */
  selectorColumns?: readonly string[];
  cascades?: readonly { resource: string; column: string }[];
}

export type Resources = Record<string, Resource>;

export function identityColumns(resource: Resource): readonly string[] {
  return resource.idColumn === null ? [] : typeof resource.idColumn === 'string' ? [resource.idColumn] : resource.idColumn;
}

export function validateResources(resources: Resources): void {
  validateImpactResources(resources);
  const entries = Object.entries(resources);
  if (entries.length > LIMITS.resources || byteLength(resources) > LIMITS.manifestBytes) throw new Error('RESOURCE_LIMIT');
  const tables = new Set<string>();
  for (const [id, resource] of entries) {
    if (!id || id.length > 128) throw new Error('INVALID_RESOURCE');
    for (const name of [resource.schema ?? 'public', resource.table, ...resource.columns, ...(resource.physicalRelations ?? []).flatMap(relation => [relation.schema, relation.table])]) {
      if (!name || name.includes('\0')) throw new Error('INVALID_IDENTIFIER');
    }
    if (resource.postgresKind !== undefined && resource.postgresKind !== 'materialized-view') throw new Error('INVALID_POSTGRES_RESOURCE_KIND');
    if (resource.postgresKind === 'materialized-view' && resource.physicalRelations) throw new Error('INVALID_PHYSICAL_RELATIONS');
    if (resource.physicalRelations && (!resource.physicalRelations.length || new Set(resource.physicalRelations.map(relation => `${relation.schema}.${relation.table}`)).size !== resource.physicalRelations.length)) throw new Error('INVALID_PHYSICAL_RELATIONS');
    const table = `${resource.schema ?? 'public'}.${resource.table}`;
    if (tables.has(table)) throw new Error('DUPLICATE_TABLE');
    tables.add(table);
    const identity = identityColumns(resource);
    if (Array.isArray(resource.idColumn) && identity.length === 0) throw new Error('EMPTY_IDENTITY');
    if (new Set(identity).size !== identity.length) throw new Error('DUPLICATE_IDENTITY_COLUMN');
    for (const name of [...identity, ...(resource.scopeColumn === null ? [] : [resource.scopeColumn]), ...(resource.selectorColumns ?? [])]) {
      if (!resource.columns.includes(name)) throw new Error('UNREGISTERED_COLUMN');
    }
    for (const child of resource.cascades ?? []) {
      if (!Object.hasOwn(resources, child.resource) || !resources[child.resource].columns.includes(child.column)) throw new Error('INVALID_CASCADE');
    }
  }
  function visit(id: string, path: Set<string>) {
    if (path.has(id)) throw new Error('CASCADE_CYCLE');
    for (const child of resources[id].cascades ?? []) visit(child.resource, new Set([...path, id]));
  }
  for (const id of Object.keys(resources)) visit(id, new Set());
}
