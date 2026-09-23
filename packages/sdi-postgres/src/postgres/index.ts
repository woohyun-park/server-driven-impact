import { guardDatabase } from '@server-driven-impact/runtime/adapter';
import type postgres from 'postgres';
import type { WriteSet } from '@server-driven-impact/core';
import {
  canonical,
  mergeAssessment,
  validationReport,
  assessResource,
  type ValidationReport,
  type Scalar,
} from '@server-driven-impact/core';
import {
  bindAdapter,
  type ImpactAdapter,
  type QueryManifest,
  type Resources,
} from '@server-driven-impact/runtime/adapter';
import type { ExecutableQueryPlan, Input } from '@server-driven-impact/runtime';
import { TrackedDb, type PostgresExecuteResult, type Transaction } from './tracked-db.js';
import { executeDriver, type DriverExecution, type DriverQueryOptions } from './driver-execution.js';
import { compileSelect } from './select.js';
import { validateCatalog } from './catalog.js';
import { sql, Sql } from './sql.js';
import {
  observationRelations,
  observerFingerprint,
  observerInternals,
  observerLayout,
  rowsToFacts,
  type ObserverRow,
} from './observer.js';
import { randomUUID } from 'node:crypto';
import { CommitStateUnknownError } from '@server-driven-impact/runtime/adapter';
import { createPostgresCatalogResolver } from './catalog-resolver.js';
import { releaseTransactionConnection } from './connection.js';
import { commandPreambleSql, ISOLATION_LEVELS, transactionReadPreambleSql, type IsolationLevel } from './preamble.js';
import type { PostgresSetupTransaction } from './public-types.js';

export { sql, Sql, identifier, join } from './sql.js';
export type { IsolationLevel } from './preamble.js';
export { generateObserverMigration, observerFingerprint } from './observer.js';
export { installPostgresTransactionGate } from './transaction-gate.js';
export { compilePostgresQuery, type PostgresMajor, type PostgresQuerySource } from './query-compiler.js';
export { createPostgresCatalogResolver };
export type {
  PostgresCatalogResolver,
  CatalogRelationReference,
  CatalogFunctionReference,
} from './catalog-resolver.js';
export type { CatalogPolicyDependency } from './catalog-resolver.js';
export type { PolicyCommand, PolicyAnalysisContext } from './policy-analysis.js';
export { resolvePostgresResources } from './catalog.js';
export { migratePostgresArtifacts, migratePostgresQueries } from './migration.js';
export {
  compilePostgresArtifacts,
  type PostgresArtifacts,
  type PostgresSourceDefinition,
  type PostgresArtifactOptions,
} from './artifact.js';
export type { PostgresMigrationDatabase } from './migration.js';
export type { PostgresExecuteResult, Row, Transaction } from './tracked-db.js';
/** Native PostgreSQL operations bound to SDI's observed transaction. */
interface CommandOperations<TResult> {
  readonly scope: Scalar;
  execute(statement: Sql): Promise<TResult>;
  query(text: string, values?: readonly unknown[]): Promise<TResult>;
  copyFrom(statement: Sql, source: AsyncIterable<Uint8Array | string> | Iterable<Uint8Array | string>): Promise<void>;
  copyTo(statement: Sql): AsyncIterable<Uint8Array>;
  cursor(statement: Sql, batchSize?: number): AsyncIterable<Record<string, unknown>[]>;
  refreshMaterializedView(resource: string, options?: { concurrently?: boolean; withData?: boolean }): Promise<void>;
  savepoint<T>(work: (db: CommandOperations<TResult>) => Promise<T>): Promise<T>;
}
export interface PostgresPendingQuery<TResult> extends PromiseLike<TResult> {
  catch<TResult2 = never>(reject: (error: unknown) => TResult2 | PromiseLike<TResult2>): Promise<TResult | TResult2>;
  finally(callback: () => void): Promise<TResult>;
  execute(): Promise<TResult>;
  cursor(batchSize?: number): AsyncIterable<Record<string, unknown>[]>;
}
export interface PostgresCommandDb<TResult = PostgresExecuteResult>
  extends Omit<CommandOperations<TResult>, 'savepoint'> {
  (strings: TemplateStringsArray, ...values: unknown[]): PostgresPendingQuery<TResult>;
  unsafe(text: string, values?: readonly unknown[]): PostgresPendingQuery<TResult>;
  savepoint<T>(work: (db: PostgresCommandDb<TResult>) => Promise<T>): Promise<T>;
}
function nativeClient<TResult>(db: CommandOperations<TResult>): PostgresCommandDb<TResult> {
  const pending = (statement: Sql): PostgresPendingQuery<TResult> => {
    let execution: Promise<TResult> | undefined;
    let streaming = false;
    const run = () =>
      streaming
        ? Promise.reject(new Error('QUERY_ALREADY_EXECUTED'))
        : // biome-ignore lint/suspicious/noAssignInExpressions: intentional `??=` memoization - caches the single query execution promise so repeated `run()` calls (then/catch/execute) share one in-flight request instead of re-querying.
          (execution ??= db.query(statement.text, statement.values));
    return {
      // biome-ignore lint/suspicious/noThenProperty: intentional thenable - PostgresPendingQuery is awaited directly by callers, matching the lazy pending-query API used across the postgres adapter.
      then: (resolve, reject) => run().then(resolve, reject),
      catch: reject => run().catch(reject),
      finally: callback => run().finally(callback),
      execute: run,
      cursor(batchSize) {
        if (execution || streaming) throw new Error('QUERY_ALREADY_EXECUTED');
        streaming = true;
        return db.cursor(statement, batchSize);
      },
    };
  };
  return Object.freeze(
    Object.assign((strings: TemplateStringsArray, ...values: unknown[]) => pending(sql(strings, ...values)), db, {
      unsafe: (text: string, values: readonly unknown[] = []) => pending(new Sql(text, [...values])),
      savepoint: <T>(work: (db: PostgresCommandDb<TResult>) => Promise<T>) =>
        db.savepoint(child => work(nativeClient(child))),
    }),
  );
}
type PostgresDatabase<T extends Record<string, unknown> = Record<string, never>> = postgres.Sql<T>;
const quarantinedDatabases = new WeakSet<object>();
function quoteRole(value: string): string {
  if (!value || value.includes('\0')) throw new Error('INVALID_POSTGRES_ROLE');
  return `"${value.replaceAll('"', '""')}"`;
}
export interface PostgresOptions<T extends Record<string, unknown> = Record<string, never>> {
  database: PostgresDatabase<T>;
  /** Verified claims, RLS role and transaction settings. No business writes here. */
  setup?: (tx: PostgresSetupTransaction, scope: Scalar) => Promise<void>;
  /** Defaults to repeatable read. */
  isolationLevel?: IsolationLevel;
}

function commandDb<TResult>(tracked: TrackedDb<TResult>): CommandOperations<TResult> {
  return Object.freeze({
    scope: tracked.scope,
    execute: statement => tracked.execute(statement),
    query: (text, values) => tracked.query(text, values),
    copyFrom: (statement, source) => tracked.copyFrom(statement, source),
    copyTo: statement => tracked.copyTo(statement),
    cursor: (statement, batchSize) => tracked.cursor(statement, batchSize),
    refreshMaterializedView: (resource, refreshOptions) => tracked.refreshMaterializedView(resource, refreshOptions),
    savepoint: <T>(work: (db: CommandOperations<TResult>) => Promise<T>) =>
      tracked.savepoint(child => work(commandDb(child))),
  } satisfies CommandOperations<TResult>);
}

export function postgresAdapter<T extends Record<string, unknown>>(
  options: PostgresOptions<T>,
): ImpactAdapter<PostgresCommandDb> {
  if (!options) throw new Error('POSTGRES_CONNECTION_REQUIRED');
  if ('writeAccess' in options || 'routines' in options) throw new Error('POSTGRES_LEGACY_COMMAND_OPTIONS_REMOVED');
  if ('query' in options || 'command' in options || 'connectionMode' in options)
    throw new Error('POSTGRES_CONNECTION_OPTIONS_REMOVED');
  if (!options.database || typeof options.database.reserve !== 'function')
    throw new Error('POSTGRES_CONNECTION_REQUIRED');
  const isolationLevel = options.isolationLevel ?? 'repeatable read';
  if (!ISOLATION_LEVELS.includes(isolationLevel)) throw new Error('INVALID_ISOLATION_LEVEL');
  return Object.freeze({
    [bindAdapter](resources: Resources, manifest: QueryManifest) {
      const reserve = async () => {
        if (quarantinedDatabases.has(options.database)) throw new Error('POSTGRES_CONNECTION_QUARANTINED');
        return options.database.reserve();
      };
      const release = async (session: Awaited<ReturnType<typeof reserve>>, broken: boolean) => {
        if (!(await releaseTransactionConnection(session, broken))) quarantinedDatabases.add(options.database);
      };
      const fingerprint = observerFingerprint(resources, manifest);
      const layout = observerLayout(fingerprint);
      const performValidation = async (
        database: Transaction,
        report: ValidationReport,
      ): Promise<ReadonlySet<string>> => {
        const validatedEqualityResources = await validateCatalog(database, resources, manifest, report);
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
            and (ns.nspname,c.relname) in (${resourceTables.map(resource => `('${(resource.schema ?? 'public').replaceAll("'", "''")}','${resource.table.replaceAll("'", "''")}')`).join(',')})
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
            ['delete', 'insert', 'truncate', 'update'].map(operation =>
              observerInternals.functionName(resource, operation),
            ),
          )
          .sort();
        if (canonical(Object.keys(definitionHashes).sort()) !== canonical(expectedFunctions))
          throw new Error('OBSERVER_DEFINITION_SET_MISMATCH');
        return validatedEqualityResources;
      };
      const readTransaction = async <V>(work: (transaction: Transaction) => Promise<V>): Promise<V> => {
        const session = await reserve();
        let broken = false;
        try {
          try {
            await session.unsafe(transactionReadPreambleSql(isolationLevel));
          } catch (cause) {
            const code = cause && typeof cause === 'object' && 'code' in cause ? String(cause.code) : '';
            if (code === '42P01') throw new Error('POSTGRES_TRANSACTION_GATE_NOT_INITIALIZED', { cause });
            throw cause;
          }
          const data = await work(session);
          await session.unsafe('commit');
          return data;
        } catch (error) {
          try {
            await session.unsafe('rollback');
          } catch {
            broken = true;
          }
          throw error;
        } finally {
          await release(session, broken);
        }
      };
      const runValidation = async () => {
        const report = validationReport(manifest);
        let equalityResources: ReadonlySet<string> = new Set();
        try {
          equalityResources = await readTransaction(tx => performValidation(tx, report));
        } catch (error) {
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
        // The promise, not its completion order, selects the next command's snapshot.
        return { report, equalityResources };
      };
      let commandValidation: ReturnType<typeof runValidation> | undefined;
      const validate = async () => {
        const current = runValidation();
        commandValidation = current;
        return structuredClone((await current).report);
      };
      const ensureCommandValidated = () => (commandValidation ??= runValidation());
      return {
        artifact: fingerprint,
        validate,
        async query<V>(
          scope: Scalar,
          work: (select: (plan: ExecutableQueryPlan, input: Input) => Promise<unknown[]>) => Promise<V>,
        ): Promise<V> {
          const result = await readTransaction(async tx => {
            await options.setup?.(tx, scope);
            if (manifest.postgres?.catalog?.effectiveRole) {
              const [role] = await tx.unsafe('select current_user as role');
              if (role.role !== manifest.postgres.catalog.effectiveRole)
                throw new Error('POSTGRES_ARTIFACT_ROLE_MISMATCH');
            }
            let currentSearchPath: string | undefined;
            const data = await work(async (plan, input) => {
              if (plan.kind === 'postgres-query') {
                if (plan.searchPath) {
                  const searchPath = plan.searchPath.map(schema => `"${schema.replaceAll('"', '""')}"`).join(',');
                  if (searchPath !== currentSearchPath) {
                    await tx.unsafe("select set_config('search_path',$1,true)", [searchPath]);
                    currentSearchPath = searchPath;
                  }
                }
                return [...(await tx.unsafe(plan.text, plan.parameters.map(field => input[field]) as never[]))];
              }
              const statement = compileSelect(plan, input, resources);
              return (await tx.unsafe(statement.text, statement.values as never[])).map(row => row.value);
            });
            return { data };
          });
          return result.data;
        },
        async command<V>(
          scope: Scalar,
          writes: WriteSet,
          work: (db: PostgresCommandDb) => Promise<V>,
        ): Promise<{ data: V; assessment: ValidationReport }> {
          const snapshot = await ensureCommandValidated();
          const assessment = structuredClone(snapshot.report);
          const equalityResources = snapshot.equalityResources;
          const session = await reserve();
          const token = randomUUID();
          const transactionState: {
            value: 'before-commit' | 'commit-in-flight' | 'committed' | 'commit-rejected' | 'commit-unknown';
          } = { value: 'before-commit' };
          let broken = false;
          let data!: V;
          let observed!: ObserverRow[];
          try {
            await session.unsafe(commandPreambleSql({ isolationLevel, token, scope }));
            if (options.setup) {
              const [beforeSetup] = await session.unsafe(
                'select current_user as current_role,session_user as session_role',
              );
              if (!beforeSetup || beforeSetup.current_role !== beforeSetup.session_role)
                throw new Error('POSTGRES_INITIAL_ROLE_STATE_UNSUPPORTED');
              await options.setup(session, scope);
              const [afterSetup] = await session.unsafe(
                'select current_user as current_role,session_user as session_role',
              );
              if (!afterSetup || afterSetup.session_role !== beforeSetup.session_role)
                throw new Error('POSTGRES_SESSION_AUTHORIZATION_CHANGE_UNSUPPORTED');
              if (afterSetup.current_role !== beforeSetup.current_role) {
                const role = quoteRole(String(afterSetup.current_role));
                await session.unsafe(
                  `reset role;grant select,insert,delete on pg_temp.${observerInternals.collectorTable} to ${role};set local role ${role}`,
                );
              }
            }
            const nativeExecution = (session as Transaction & Partial<DriverExecution<PostgresExecuteResult>>)[
              executeDriver
            ];
            const executeStatement = nativeExecution
              ? (statement: Sql, driverOptions?: DriverQueryOptions) =>
                  nativeExecution.call(session, statement.text, statement.values, driverOptions)
              : (statement: Sql) =>
                  session.unsafe(statement.text, statement.values as never[]) as Promise<PostgresExecuteResult>;
            const tracked = new TrackedDb(session, writes, scope, resources, executeStatement);
            const guarded = guardDatabase(commandDb(tracked));
            let workFailed = false;
            let workError: unknown;
            try {
              data = await work(nativeClient(guarded.db));
              guarded.finish();
            } catch (error) {
              workFailed = true;
              workError = error;
            }
            // Close admission before waiting so work cannot enqueue a late raw,
            // ORM, savepoint, cursor or COPY operation behind the drain boundary.
            guarded.close();
            let settleFailed = false;
            let settleError: unknown;
            try {
              await guarded.settle();
            } catch (error) {
              broken = true;
              settleFailed = true;
              settleError = error;
            } finally {
              tracked.close();
            }
            if (workFailed) throw workError;
            if (settleFailed) throw settleError;
            // This is a deliberate Command contract: deferred constraints and
            // constraint triggers must succeed at the observation boundary.
            await session.unsafe('set constraints all immediate');
            observed = [
              ...(await session.unsafe(
                `delete from pg_temp.${observerInternals.collectorTable} where token=$1 returning resource,operation,before_state,after_state,changed_columns`,
                [token],
              )),
            ] as unknown as ObserverRow[];
            // Keep the token and a sealed phase through COMMIT. Any registered
            // write scheduled after the drain aborts instead of committing unseen.
            await session.unsafe("select set_config('sdi.observation_phase','sealed',true)");
            try {
              transactionState.value = 'commit-in-flight';
              await session.unsafe('commit');
              transactionState.value = 'committed';
            } catch (cause) {
              const code = cause && typeof cause === 'object' && 'code' in cause ? String(cause.code) : '';
              // A PostgreSQL SQLSTATE means the server rejected COMMIT (for example,
              // a deferred constraint). Driver/network codes do not establish whether
              // the server committed before the connection was lost.
              if (/^[0-9A-Z]{5}$/.test(code) && !code.startsWith('08') && code !== '40003') {
                transactionState.value = 'commit-rejected';
                throw cause;
              }
              transactionState.value = 'commit-unknown';
              throw new CommitStateUnknownError({ cause });
            }
          } catch (error) {
            if (transactionState.value === 'commit-unknown') broken = true;
            if (transactionState.value === 'before-commit' || transactionState.value === 'commit-rejected')
              try {
                await session.unsafe('rollback');
              } catch {
                broken = true;
              }
            throw error;
          } finally {
            await release(session, broken);
          }
          for (const row of observed) {
            try {
              const facts = rowsToFacts([row]);
              for (const fact of facts)
                if (!equalityResources.has(fact.resource))
                  for (const state of [fact.before, fact.after])
                    if (state.kind === 'known') delete state.equalityFields;
              writes.add(facts);
            } catch {
              // Only isolate rows whose resource identity is known. Validation already
              // marks any endpoint whose dependency completeness is unproved.
              if (typeof row?.resource === 'string' && Object.hasOwn(resources, row.resource))
                assessResource(assessment, manifest, row.resource, {
                  status: 'unavailable',
                  codes: ['OBSERVATION_FAILED'],
                });
              else
                for (const endpoint of Object.keys(assessment.endpoints))
                  assessment.endpoints[endpoint] = mergeAssessment(assessment.endpoints[endpoint], {
                    status: 'unavailable',
                    codes: ['OBSERVATION_FAILED'],
                  });
            }
          }
          return { data, assessment };
        },
      };
    },
  });
}
