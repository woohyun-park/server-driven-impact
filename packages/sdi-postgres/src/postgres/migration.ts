import type { ImpactSet } from '@server-driven-impact/core';
import type { QueryManifest, Resources } from '@server-driven-impact/runtime/adapter';
import { resolvePostgresResources, validateCatalog } from './catalog.js';
import { generateObserverMigration, observerFingerprint } from './observer.js';
import type { Transaction } from './tracked-db.js';
import { compilePostgresArtifacts, type PostgresArtifactOptions, type PostgresArtifacts, type PostgresSourceDefinition } from './artifact.js';

export interface PostgresMigrationDatabase extends Transaction {
  begin<T>(options:string,work:(transaction:Transaction)=>Promise<T>):Promise<T>;
}

/**
 * Run cooperating DDL and observer regeneration in one serialized transaction.
 * The returned resource snapshot must be used to construct the next engine.
 */
export async function migratePostgresArtifacts(
  database: PostgresMigrationDatabase,
  resources: Resources,
  manifest: QueryManifest,
  options: {
    runtimeRole?: string;
    change?: (transaction:Transaction)=>Promise<void>;
  } = {},
): Promise<{resources:Resources;fingerprint:string;impact:ImpactSet}> {
  if(manifest.postgres)throw new Error('NATIVE_QUERY_DEFINITIONS_REQUIRED_USE_MIGRATE_POSTGRES_QUERIES');
  return database.begin('isolation level read committed',async transaction=>{
    await transaction.unsafe('select pg_advisory_xact_lock($1,$2)',[0x534449,0x5047]);
    await options.change?.(transaction);
    const resolved=await resolvePostgresResources(transaction,resources);
    await transaction.unsafe(generateObserverMigration(resolved,manifest,{runtimeRole:options.runtimeRole}));
    await validateCatalog(transaction,resolved,manifest);
    return {
      resources:resolved,
      fingerprint:observerFingerprint(resolved,manifest),
      impact:{protocolVersion:1,targets:Object.keys(manifest.reads).sort().map(endpoint=>({endpoint,scope:'global',selector:{kind:'all'}}))},
    };
  });
}

export async function migratePostgresQueries(
  database: PostgresMigrationDatabase, resources: Resources,
  definitions: Record<string, PostgresSourceDefinition>,
  options: PostgresArtifactOptions & { runtimeRole?: string; change?: (transaction:Transaction)=>Promise<void> },
): Promise<PostgresArtifacts & { fingerprint: string; impact: ImpactSet }> {
  // READ COMMITTED takes the catalog snapshot after a waiting advisory lock is
  // granted. SERIALIZABLE could retain the pre-migration snapshot from the lock SELECT.
  return database.begin('isolation level read committed',async transaction=>{
    await transaction.unsafe('select pg_advisory_xact_lock($1,$2)',[0x534449,0x5047]);
    await options.change?.(transaction);
    const artifact = await compilePostgresArtifacts(transaction, resources, definitions, options);
    await transaction.unsafe(generateObserverMigration(artifact.resources,artifact.manifest,{runtimeRole:options.runtimeRole}));
    await validateCatalog(transaction,artifact.resources,artifact.manifest);
    return {...artifact, fingerprint:observerFingerprint(artifact.resources,artifact.manifest),
      impact:{protocolVersion:1 as const,targets:Object.keys(definitions).sort().map(endpoint=>({endpoint,scope:'global' as const,selector:{kind:'all' as const}}))}};
  });
}
