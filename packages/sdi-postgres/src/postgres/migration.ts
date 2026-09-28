import type { ImpactSet } from '@server-driven-impact/core';
import type { QueryManifest, Resources } from '@server-driven-impact/runtime/adapter';
import { resolvePostgresResources } from './catalog.js';
import { generateObserverMigration, observerFingerprint } from './observer.js';
import type { Transaction } from './tracked-db.js';
import {
  controlSetupError,
  installPostgresTransactionGate,
  transactionGateExclusiveLockSql,
} from './transaction-gate.js';
import { storeValidation, type PostgresStoredValidation } from './validation.js';
import {
  compilePostgresArtifacts,
  type PostgresArtifactOptions,
  type PostgresArtifacts,
  type PostgresSourceDefinition,
} from './artifact.js';

export interface PostgresMigrationDatabase extends Transaction {
  begin<T>(options: string, work: (transaction: Transaction) => Promise<T>): Promise<T>;
}

const migrationLock = 'select pg_advisory_xact_lock($1,$2)';
const migrationLockKeys = [0x534449, 0x5047];

/**
 * Run cooperating DDL and observer regeneration in one serialized transaction.
 * The returned resource snapshot must be used to construct the next engine. Validation problems are
 * recorded and returned, never thrown: callers that want to block a deployment inspect `validation`.
 */
export async function migratePostgresArtifacts(
  database: PostgresMigrationDatabase,
  resources: Resources,
  manifest: QueryManifest,
  options: {
    runtimeRole?: string;
    change?: (transaction: Transaction) => Promise<void>;
  } = {},
): Promise<{ resources: Resources; fingerprint: string; validation: PostgresStoredValidation; impact: ImpactSet }> {
  if (manifest.postgres) throw new Error('NATIVE_QUERY_DEFINITIONS_REQUIRED_USE_MIGRATE_POSTGRES_QUERIES');
  return database.begin('isolation level read committed', async transaction => {
    await transaction.unsafe(migrationLock, migrationLockKeys);
    await installPostgresTransactionGate(transaction, options.runtimeRole);
    await transaction.unsafe(transactionGateExclusiveLockSql);
    await options.change?.(transaction);
    const resolved = await resolvePostgresResources(transaction, resources);
    await transaction.unsafe(generateObserverMigration(resolved, manifest, { runtimeRole: options.runtimeRole }));
    const validation = await storeValidation(transaction, resolved, manifest);
    return {
      resources: resolved,
      fingerprint: observerFingerprint(resolved, manifest),
      validation,
      impact: {
        endpoints: Object.fromEntries(
          Object.keys(manifest.reads)
            .sort()
            .map(endpoint => [
              endpoint,
              {
                status: 'verified' as const,
                targets: [{ scope: 'global' as const, selector: { kind: 'all' as const } }],
              },
            ]),
        ),
      },
    };
  });
}

export async function migratePostgresQueries(
  database: PostgresMigrationDatabase,
  resources: Resources,
  definitions: Record<string, PostgresSourceDefinition>,
  options: PostgresArtifactOptions & { runtimeRole?: string; change?: (transaction: Transaction) => Promise<void> },
): Promise<PostgresArtifacts & { fingerprint: string; validation: PostgresStoredValidation; impact: ImpactSet }> {
  // READ COMMITTED takes the catalog snapshot after a waiting advisory lock is
  // granted. SERIALIZABLE could retain the pre-migration snapshot from the lock SELECT.
  return database.begin('isolation level read committed', async transaction => {
    await transaction.unsafe(migrationLock, migrationLockKeys);
    await installPostgresTransactionGate(transaction, options.runtimeRole);
    await transaction.unsafe(transactionGateExclusiveLockSql);
    await options.change?.(transaction);
    const artifact = await compilePostgresArtifacts(transaction, resources, definitions, options);
    await transaction.unsafe(
      generateObserverMigration(artifact.resources, artifact.manifest, { runtimeRole: options.runtimeRole }),
    );
    const validation = await storeValidation(transaction, artifact.resources, artifact.manifest);
    return {
      ...artifact,
      fingerprint: observerFingerprint(artifact.resources, artifact.manifest),
      validation,
      impact: {
        endpoints: Object.fromEntries(
          Object.keys(definitions)
            .sort()
            .map(endpoint => [
              endpoint,
              {
                status: 'verified' as const,
                targets: [{ scope: 'global' as const, selector: { kind: 'all' as const } }],
              },
            ]),
        ),
      },
    };
  });
}

/**
 * Recompute and record the validation snapshot without DDL. Run it with owner credentials after any
 * schema change applied outside the migration helpers (static SQL, dashboards, platform upgrades).
 */
export async function refreshPostgresValidation(
  database: PostgresMigrationDatabase,
  resources: Resources,
  manifest: QueryManifest,
): Promise<PostgresStoredValidation> {
  return database.begin('isolation level read committed', async transaction => {
    await transaction.unsafe(migrationLock, migrationLockKeys);
    try {
      return await storeValidation(transaction, resources, manifest);
    } catch (cause) {
      throw controlSetupError(cause);
    }
  });
}
