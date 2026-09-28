import {
  assessResource,
  canonical,
  mergeAssessment,
  validationReport,
  type ValidationReport,
} from '@server-driven-impact/core';
import type { QueryManifest, Resources } from '@server-driven-impact/runtime/adapter';
import { validateCatalog } from './catalog.js';
import { observationRelations, observerFingerprint, observerInternals, observerLayout } from './observer.js';
import { literal } from './sql.js';
import { catalogHashFunction, recordValidationFunction, validationRelation } from './transaction-gate.js';
import type { Transaction } from './tracked-db.js';

export interface ValidationSnapshot {
  report: ValidationReport;
  equalityResources: ReadonlySet<string>;
  validatedAt: string;
  /** Present only when the catalog hash did not move during validation; required to record the snapshot. */
  catalog?: { hash: string; schemas: string[] };
}
/** A snapshot computed by an owner-side migration or refresh, as returned to callers. */
export interface PostgresStoredValidation {
  fingerprint: string;
  report: ValidationReport;
  equalityResources: string[];
  validatedAt: string;
  /** False when the catalog changed during validation or another recorder held the lock. */
  recorded: boolean;
}
/** The preamble's view of the stored snapshot. */
export interface StoredRead {
  snapshot?: ValidationSnapshot;
  /** Schemas the last recorder hashed; seeds the next live validation so it validates once. */
  seedSchemas: string[];
  /** Database clock when the row was read. */
  now?: string;
}

async function verifyObservers(
  database: Transaction,
  resources: Resources,
  manifest: QueryManifest,
  report: ValidationReport,
): Promise<void> {
  const fingerprint = observerFingerprint(resources, manifest);
  const layout = observerLayout(fingerprint);
  const rows = await database.unsafe(
    `select fingerprint,definition_hashes from ${layout.internalSchema}.${layout.metadataTable} where singleton=true`,
  );
  if (
    rows[0]?.fingerprint !== fingerprint ||
    !rows[0]?.definition_hashes ||
    typeof rows[0].definition_hashes !== 'object'
  )
    throw new Error('OBSERVER_MANIFEST_MISMATCH');
  const definitionHashes = rows[0].definition_hashes as Record<string, string>;
  const resourceTables = Object.values(resources).flatMap(observationRelations);
  const installed = resourceTables.length
    ? await database.unsafe(`
      select ns.nspname as schema_name,c.relname as table_name,t.tgname,t.tgenabled,
             fns.nspname as function_schema,p.proname as function_name,
             t.tgtype as trigger_type,
             (t.tgtype & 1) <> 0 as row_level,(t.tgtype & 2) <> 0 as before_trigger,
             (t.tgtype & 64) <> 0 as instead_trigger,t.tgoldtable,t.tgnewtable,
             p.prosecdef,p.proconfig,l.lanname,md5(pg_get_functiondef(p.oid)) as function_hash
      from pg_trigger t
      join pg_class c on c.oid=t.tgrelid
      join pg_namespace ns on ns.oid=c.relnamespace
      join pg_proc p on p.oid=t.tgfoid
      join pg_namespace fns on fns.oid=p.pronamespace
      join pg_language l on l.oid=p.prolang
      where not t.tgisinternal and t.tgname like 'sdi_observe_%'
        and (ns.nspname,c.relname) in (${resourceTables.map(resource => `(${literal(resource.schema ?? 'public')},${literal(resource.table)})`).join(',')})
      order by ns.nspname,c.relname,t.tgname`)
    : [];
  const actual = new Map(installed.map(row => [`${row.schema_name}.${row.table_name}.${row.tgname}`, row]));
  for (const [resourceId, resource] of Object.entries(resources)) {
    for (const relation of observationRelations(resource)) {
      for (const operation of ['delete', 'insert', 'truncate', 'update']) {
        const key = `${relation.schema}.${relation.table}.sdi_observe_${operation}`;
        const row = actual.get(key);
        const expectedFunction = observerInternals.functionName(resourceId, operation);
        const expectedOld = operation === 'delete' || operation === 'update' ? 'sdi_old_rows' : null;
        const expectedNew = operation === 'insert' || operation === 'update' ? 'sdi_new_rows' : null;
        const expectedType = { insert: 4, delete: 8, update: 16, truncate: 32 }[operation];
        if (
          !row ||
          !['O', 'A'].includes(row.tgenabled) ||
          Number(row.trigger_type) !== expectedType ||
          row.row_level ||
          row.before_trigger ||
          row.instead_trigger ||
          row.tgoldtable !== expectedOld ||
          row.tgnewtable !== expectedNew ||
          row.prosecdef ||
          row.lanname !== 'plpgsql' ||
          !Array.isArray(row.proconfig) ||
          !row.proconfig.includes('search_path=pg_catalog, pg_temp') ||
          row.function_schema !== layout.internalSchema ||
          row.function_name !== expectedFunction ||
          definitionHashes[expectedFunction] !== row.function_hash
        ) {
          assessResource(report, manifest, resourceId, { status: 'unavailable', codes: ['OBSERVER_UNVERIFIED'] });
        }
        actual.delete(key);
      }
    }
  }
  if (actual.size) throw new Error(`OBSERVER_COVERAGE_MISMATCH:${actual.keys().next().value}`);
  const expectedFunctions = Object.entries(resources)
    .filter(([, resource]) => resource.postgresKind !== 'materialized-view')
    .flatMap(([resource]) =>
      ['delete', 'insert', 'truncate', 'update'].map(operation => observerInternals.functionName(resource, operation)),
    )
    .sort();
  if (canonical(Object.keys(definitionHashes).sort()) !== canonical(expectedFunctions))
    throw new Error('OBSERVER_DEFINITION_SET_MISMATCH');
}

/** Rows of the statement that returned `column`; drivers disagree on multi-statement result shapes. */
export function columnValue(result: unknown, column: string): unknown {
  const [row] = [result].flat(2).filter(value => value && typeof value === 'object' && column in value) as Record<
    string,
    unknown
  >[];
  return row?.[column];
}

function baseSchemas(resources: Resources, manifest: QueryManifest, fingerprint: string): string[] {
  return [
    // The policy resolver resolves unqualified names through public.
    'public',
    observerLayout(fingerprint).internalSchema,
    ...(manifest.postgres?.catalog?.schemas ?? []),
    ...Object.values(resources).flatMap(resource => [
      resource.schema ?? 'public',
      ...(resource.physicalRelations ?? []).map(relation => relation.schema),
    ]),
  ];
}

async function catalogHash(database: Transaction, schemas: ReadonlySet<string>): Promise<string | undefined> {
  const array = `array[${[...schemas].sort().map(literal).join(',')}]::text[]`;
  try {
    const result = await database.unsafe(
      `savepoint sdi_catalog_hash;select ${catalogHashFunction}(${array}) as sdi_catalog_hash;release savepoint sdi_catalog_hash`,
    );
    const hash = columnValue(result, 'sdi_catalog_hash');
    return typeof hash === 'string' ? hash : undefined;
  } catch {
    await database.unsafe('rollback to savepoint sdi_catalog_hash;release savepoint sdi_catalog_hash');
    return undefined;
  }
}

async function validateOnce(
  database: Transaction,
  resources: Resources,
  manifest: QueryManifest,
  visitedSchemas: Set<string>,
): Promise<ValidationSnapshot> {
  const report = validationReport(manifest);
  let equalityResources: ReadonlySet<string> = new Set();
  await database.unsafe('savepoint sdi_validation');
  try {
    equalityResources = await validateCatalog(database, resources, manifest, report, visitedSchemas);
    await verifyObservers(database, resources, manifest, report);
    await database.unsafe('release savepoint sdi_validation');
  } catch (error) {
    await database.unsafe('rollback to savepoint sdi_validation');
    await database.unsafe('release savepoint sdi_validation');
    equalityResources = new Set();
    const message = error instanceof Error ? error.message : '';
    const code = message.startsWith('OBSERVER_')
      ? 'OBSERVER_UNVERIFIED'
      : message === 'POSTGRES_ARTIFACT_DRIFT' || message.startsWith('UNRESOLVED_RLS_')
        ? 'CATALOG_DRIFT'
        : 'VALIDATION_FAILED';
    for (const endpoint of Object.keys(report.endpoints))
      report.endpoints[endpoint] = mergeAssessment(report.endpoints[endpoint], {
        status: 'unavailable',
        codes: [code],
      });
  }
  return { report, equalityResources, validatedAt: new Date().toISOString() };
}

/**
 * Full catalog and observer validation inside the caller's transaction. It never aborts that
 * transaction: failures roll back to a savepoint and mark every endpoint unavailable. The catalog hash is
 * taken before and after over every schema validation read; a snapshot is recordable only if it held.
 */
export async function computeValidation(
  database: Transaction,
  resources: Resources,
  manifest: QueryManifest,
  seedSchemas: readonly string[] = [],
): Promise<ValidationSnapshot> {
  const candidate = new Set([
    ...seedSchemas,
    ...baseSchemas(resources, manifest, observerFingerprint(resources, manifest)),
  ]);
  let result!: ValidationSnapshot;
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = await catalogHash(database, candidate);
    const visited = new Set<string>();
    result = await validateOnce(database, resources, manifest, visited);
    const unseen = [...visited].filter(schema => !candidate.has(schema));
    if (unseen.length) {
      // Validation read a schema the hash did not cover; widen it and prove the snapshot again.
      for (const schema of unseen) candidate.add(schema);
      continue;
    }
    const after = before === undefined ? undefined : await catalogHash(database, candidate);
    return before !== undefined && before === after
      ? { ...result, catalog: { hash: before, schemas: [...candidate].sort() } }
      : result;
  }
  return result;
}

/** Record through the guarded function; never fails the caller's transaction. Returns whether it was stored. */
export async function recordValidation(
  database: Transaction,
  fingerprint: string,
  snapshot: ValidationSnapshot,
): Promise<boolean> {
  if (!snapshot.catalog) return false;
  await database.unsafe('savepoint sdi_record_validation');
  try {
    const [row] = await database.unsafe(
      `select ${recordValidationFunction}($1,$2,array(select jsonb_array_elements_text($3::text::jsonb)),$4::text::jsonb,$5::text::jsonb) as recorded`,
      // Text parameters cast in SQL: drivers disagree on how strings and arrays bind to jsonb and text[].
      [
        fingerprint,
        snapshot.catalog.hash,
        JSON.stringify(snapshot.catalog.schemas),
        JSON.stringify(snapshot.report),
        JSON.stringify([...snapshot.equalityResources].sort()),
      ],
    );
    await database.unsafe('release savepoint sdi_record_validation');
    return row?.recorded === true;
  } catch {
    await database.unsafe('rollback to savepoint sdi_record_validation;release savepoint sdi_record_validation');
    return false;
  }
}

/** Owner-side validation and record. Run after every DDL statement of the surrounding transaction. */
export async function storeValidation(
  database: Transaction,
  resources: Resources,
  manifest: QueryManifest,
): Promise<PostgresStoredValidation> {
  const fingerprint = observerFingerprint(resources, manifest);
  const [previous] = await database.unsafe(`select catalog_schemas from ${validationRelation}`);
  const seed = Array.isArray(previous?.catalog_schemas) ? (previous.catalog_schemas as string[]) : [];
  const snapshot = await computeValidation(database, resources, manifest, seed);
  const recorded = await recordValidation(database, fingerprint, snapshot);
  const [row] = recorded ? await database.unsafe(`select validated_at from ${validationRelation}`) : [];
  return {
    fingerprint,
    report: snapshot.report,
    equalityResources: [...snapshot.equalityResources].sort(),
    validatedAt: row ? new Date(row.validated_at).toISOString() : snapshot.validatedAt,
    recorded,
  };
}

function parseRow(row: Record<string, unknown>, manifest: QueryManifest): ValidationSnapshot | undefined {
  const { report, equality_resources: equality, validated_at: validatedAt } = row;
  const endpoints = (report as ValidationReport | undefined)?.endpoints;
  if (
    !endpoints ||
    typeof endpoints !== 'object' ||
    !Object.keys(manifest.reads).every(endpoint => Object.hasOwn(endpoints, endpoint)) ||
    !Array.isArray(equality) ||
    !equality.every(resource => typeof resource === 'string') ||
    typeof validatedAt !== 'string' ||
    Number.isNaN(Date.parse(validatedAt))
  )
    return undefined;
  return {
    report: structuredClone(report as ValidationReport),
    equalityResources: new Set(equality),
    validatedAt: new Date(validatedAt).toISOString(),
  };
}

/** Parse the `sdi_validation` column; a missing, mismatched or malformed row yields no snapshot. */
export function readStored(value: unknown, manifest: QueryManifest): StoredRead {
  const read = (typeof value === 'string' ? JSON.parse(value) : value) as Record<string, unknown> | null | undefined;
  const row = read?.row && typeof read.row === 'object' ? (read.row as Record<string, unknown>) : undefined;
  const schemas = row?.catalog_schemas;
  return {
    snapshot: row && read?.match === true ? parseRow(row, manifest) : undefined,
    seedSchemas: Array.isArray(schemas) ? schemas.filter((schema): schema is string => typeof schema === 'string') : [],
    now: typeof read?.now === 'string' ? new Date(read.now).toISOString() : undefined,
  };
}

/**
 * Scalar subquery for the stored snapshot, inlined because the preamble has no parameters. With the
 * catalog gate the row matches only if the catalog still has the recorded hash; CASE keeps the hash
 * from running for another artifact's row.
 */
export function storedValidationExpression(fingerprint: string, catalogGate: boolean): string {
  if (!/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error('INVALID_OBSERVER_FINGERPRINT');
  const gate = catalogGate ? `v.catalog_hash = ${catalogHashFunction}(v.catalog_schemas)` : 'true';
  return `(select jsonb_build_object('now',clock_timestamp(),'row',to_jsonb(v),'match',coalesce(case when v.fingerprint=${literal(fingerprint)} then ${gate} else false end,false)) from (select 1) one left join ${validationRelation} v on true)`;
}
