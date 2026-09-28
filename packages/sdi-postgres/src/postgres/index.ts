import { guardDatabase } from '@server-driven-impact/runtime/adapter';
import type postgres from 'postgres';
import type { WriteSet } from '@server-driven-impact/core';
import {
  mergeAssessment,
  assessResource,
  type ValidationReport,
  type ValidationResult,
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
import { sql, Sql } from './sql.js';
import { observerFingerprint, observerInternals, rowsToFacts, type ObserverRow } from './observer.js';
import { preloadCommandSqlParser } from './command-sql.js';
import { controlSetupError } from './transaction-gate.js';
import {
  columnValue,
  computeValidation,
  readStored,
  recordValidation,
  storedValidationExpression,
  type ValidationSnapshot,
} from './validation.js';
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
export { migratePostgresArtifacts, migratePostgresQueries, refreshPostgresValidation } from './migration.js';
export type { PostgresStoredValidation } from './validation.js';
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
      const readTransaction = async <V>(
        work: (transaction: Transaction) => Promise<V>,
        readOnly = true,
      ): Promise<V> => {
        const session = await reserve();
        let broken = false;
        try {
          try {
            await session.unsafe(transactionReadPreambleSql(isolationLevel, readOnly));
          } catch (cause) {
            throw controlSetupError(cause);
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
      // Live validation is the fallback when no stored snapshot passes the catalog gate. Its creator records
      // the result so the next process can use it; it is cached per bound adapter until an explicit
      // validate(), and concurrent commands share one computation.
      let liveValidation: Promise<ValidationSnapshot> | undefined;
      const live = (database: Transaction, seedSchemas: readonly string[], refresh = false) => {
        if (refresh || !liveValidation) {
          const current = (async () => {
            const snapshot = await computeValidation(database, resources, manifest, seedSchemas);
            await recordValidation(database, fingerprint, snapshot);
            return snapshot;
          })();
          liveValidation = current;
          current.catch(() => {
            if (liveValidation === current) liveValidation = undefined;
          });
        }
        return liveValidation;
      };
      // The catalog hash scans catalog rows, so only the first read of a bound adapter pays for it. Later
      // commands accept the row that passed that gate, or a row recorded after the decision (a newer full
      // validation); anything else falls back to the live snapshot.
      let decision: { validatedAt?: string; at: string } | undefined;
      const resolveSnapshot = async (
        database: Transaction,
        value: unknown,
        gated: boolean,
        refresh = false,
      ): Promise<{ snapshot: ValidationSnapshot; source: 'stored' | 'live' }> => {
        const read = readStored(value, manifest);
        let stored = read.snapshot;
        if (gated) decision = { validatedAt: stored?.validatedAt, at: read.now ?? new Date(0).toISOString() };
        else if (
          stored &&
          decision &&
          stored.validatedAt !== decision.validatedAt &&
          !(stored.validatedAt > decision.at)
        )
          stored = undefined;
        if (stored) return { snapshot: stored, source: 'stored' };
        return { snapshot: await live(database, read.seedSchemas, refresh), source: 'live' };
      };
      const validate = async (): Promise<ValidationResult> =>
        // Read-write: a live validation here records its snapshot, which makes this a deployment preflight.
        readTransaction(async tx => {
          let result: unknown;
          try {
            result = await tx.unsafe(`select ${storedValidationExpression(fingerprint, true)} as sdi_validation`);
          } catch (cause) {
            throw controlSetupError(cause);
          }
          const { snapshot, source } = await resolveSnapshot(tx, columnValue(result, 'sdi_validation'), true, true);
          return { report: structuredClone(snapshot.report), source, validatedAt: snapshot.validatedAt };
        }, false);
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
          preloadCommandSqlParser();
          const session = await reserve();
          let assessment!: ValidationReport;
          let equalityResources!: ReadonlySet<string>;
          const token = randomUUID();
          const transactionState: {
            value: 'before-commit' | 'commit-in-flight' | 'committed' | 'commit-rejected' | 'commit-unknown';
          } = { value: 'before-commit' };
          let broken = false;
          let data!: V;
          let observed!: ObserverRow[];
          try {
            let preamble: unknown;
            const catalogGate = decision === undefined;
            try {
              preamble = await session.unsafe(
                commandPreambleSql({ isolationLevel, token, scope, fingerprint, catalogGate }),
              );
            } catch (cause) {
              throw controlSetupError(cause);
            }
            // Validate before setup so live validation runs with the connection role, as the stored one did.
            const { snapshot } = await resolveSnapshot(session, columnValue(preamble, 'sdi_validation'), catalogGate);
            assessment = structuredClone(snapshot.report);
            equalityResources = snapshot.equalityResources;
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
