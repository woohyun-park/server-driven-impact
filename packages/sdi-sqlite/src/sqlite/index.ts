import type { DatabaseSync, SQLInputValue, StatementSync } from 'node:sqlite';
import type { WriteSet } from '@server-driven-impact/core';
import { LIMITS, canonical, isScalar, type Scalar, type WriteFact, type RowState } from '@server-driven-impact/core';
import {
  bindAdapter,
  identityColumns,
  verifiedStringComparisons,
  type ImpactAdapter,
  type QueryManifest,
  type Resources,
  type SelectExecutor,
  type VerifiedStringComparison,
} from '@server-driven-impact/runtime/adapter';
import { guardDatabase } from '@server-driven-impact/runtime/adapter';
import type { Input } from '@server-driven-impact/runtime';
import { compileSelect } from './select.js';
import { createHash } from 'node:crypto';
import { ImpactUnavailableError } from '@server-driven-impact/runtime/adapter';

export type DataRow = Record<string, unknown>;
export type SqliteStatement = Pick<StatementSync, 'all' | 'get' | 'run'>;
export interface SqliteCommandDb {
  prepare(text: string): SqliteStatement;
  /** Execute one trusted native SQLite statement on the owned transaction. */
  execute(text: string, values?: readonly SQLInputValue[]): Promise<DataRow[]>;
  savepoint<T>(work: (db: SqliteCommandDb) => Promise<T>): Promise<T>;
}
export interface SqliteOptions {
  database: DatabaseSync;
}
const queues = new WeakMap<DatabaseSync, Promise<unknown>>();
function serial<T>(database: DatabaseSync, work: () => Promise<T>): Promise<T> {
  const next = (queues.get(database) ?? Promise.resolve()).then(work, work);
  queues.set(
    database,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}
function ident(name: string): string {
  if (!name || name.includes('\0')) throw new Error('INVALID_IDENTIFIER');
  return '"' + name.replaceAll('"', '""') + '"';
}
function sqlTokens(text: string, requireSingleStatement = false): string[] {
  const tokens: string[] = [];
  let statementEnded = false;
  for (let index = 0; index < text.length; ) {
    const char = text[index],
      next = text[index + 1];
    if (/\s/.test(char)) {
      index++;
      continue;
    }
    if (char === '-' && next === '-') {
      const end = text.indexOf('\n', index + 2);
      index = end < 0 ? text.length : end + 1;
      continue;
    }
    if (char === '/' && next === '*') {
      const end = text.indexOf('*/', index + 2);
      if (end < 0) throw new Error('SQLITE_INVALID_SQL');
      index = end + 2;
      continue;
    }
    if (char === ';') {
      statementEnded = true;
      index++;
      continue;
    }
    if (requireSingleStatement && statementEnded) throw new Error('SQLITE_SINGLE_STATEMENT_REQUIRED');
    if (char === "'") {
      index++;
      while (index < text.length) {
        if (text[index] === "'") {
          if (text[index + 1] === "'") {
            index += 2;
            continue;
          }
          index++;
          break;
        }
        index++;
      }
      continue;
    }
    if (char === '"' || char === '`' || char === '[') {
      const close = char === '[' ? ']' : char;
      let value = '';
      index++;
      while (index < text.length) {
        if (text[index] === close) {
          if (close !== ']' && text[index + 1] === close) {
            value += close;
            index += 2;
            continue;
          }
          index++;
          break;
        }
        value += text[index++];
      }
      if (value) tokens.push(value.toUpperCase());
      continue;
    }
    const word = text.slice(index).match(/^[A-Za-z_][A-Za-z0-9_]*/)?.[0];
    if (word) {
      tokens.push(word.toUpperCase());
      index += word.length;
      continue;
    }
    index++;
  }
  return tokens;
}
function value(input: unknown): SQLInputValue {
  // SQLite returns INTEGER booleans as numbers. Require that explicit representation
  // rather than returning a falsely narrow boolean input selector.
  if (!isScalar(input) || typeof input === 'boolean') throw new Error('SQLITE_REQUIRES_TEXT_NUMBER_OR_NULL');
  if (typeof input === 'number' && Number.isInteger(input) && !Number.isSafeInteger(input))
    throw new Error('UNSAFE_INTEGER');
  return input;
}
function bindings(values: unknown[]): Record<string, SQLInputValue> {
  return Object.fromEntries(values.map((v, i) => [String(i + 1), value(v)]));
}
function validateCatalog(database: DatabaseSync, resources: Resources): ReadonlySet<string> {
  const exactStringColumns = new Set<string>();
  if (!database.prepare('pragma foreign_keys').get()?.foreign_keys) throw new Error('SQLITE_FOREIGN_KEYS_REQUIRED');
  for (const [id, resource] of Object.entries(resources)) {
    if (resource.schema && resource.schema !== 'main') throw new Error('SQLITE_MAIN_SCHEMA_ONLY');
    const entry = database.prepare('select type, sql from sqlite_schema where name=?').get(resource.table);
    if (entry?.type !== 'table' || /CREATE\s+VIRTUAL\s+TABLE/i.test(String(entry.sql)))
      throw new Error('UNSUPPORTED_TABLE:' + id);
    const schemaTokens = sqlTokens(String(entry.sql));
    if (
      schemaTokens.some(
        (token, index) =>
          token === 'ON' && schemaTokens[index + 1] === 'CONFLICT' && schemaTokens[index + 2] === 'REPLACE',
      )
    )
      throw new Error('SQLITE_SCHEMA_REPLACE_UNSUPPORTED:' + id);
    const collations = schemaTokens.flatMap((token, index) =>
      token === 'COLLATE' && schemaTokens[index + 1] ? [schemaTokens[index + 1]] : [],
    );
    if (collations.some(name => !['BINARY', 'NOCASE', 'RTRIM'].includes(name)))
      throw new Error('SQLITE_CUSTOM_COLLATION_UNSUPPORTED:' + id);
    const columns = database.prepare(`pragma table_xinfo(${ident(resource.table)})`).all();
    const pk = columns.filter(c => Number(c.pk) > 0);
    const identity = identityColumns(resource);
    if (identity.length !== 1 || pk.length !== 1 || pk[0].name !== identity[0] || columns.some(c => c.hidden))
      throw new Error('UNSUPPORTED_TABLE:' + id);
    if (canonical(columns.map(c => c.name).sort()) !== canonical([...resource.columns].sort()))
      throw new Error('COLUMN_DRIFT:' + id);
    if (columns.some(c => !['TEXT', 'INTEGER', 'REAL'].includes(String(c.type).toUpperCase())))
      throw new Error('SQLITE_UNSUPPORTED_COLUMN_TYPE:' + id);
    // Structured selects do not emit an explicit COLLATE clause. If the table has
    // any non-BINARY declaration, stay broad until column-level parsing is proven.
    if (!collations.some(name => name !== 'BINARY'))
      for (const column of columns) {
        if (String(column.type).toUpperCase() === 'TEXT') exactStringColumns.add(canonical([id, String(column.name)]));
      }
  }
  return exactStringColumns;
}

const collectorTable = 'sdi_observed_facts';
const collectorResources = 'sdi_observed_resources';
const activeObservers = new WeakMap<DatabaseSync, { key: string; triggers: string[] }>();
function triggerName(resource: string, operation: string) {
  return `sdi_${createHash('sha256').update(resource).digest('hex').slice(0, 12)}_${operation}`;
}
function quoted(value: string) {
  return "'" + value.replaceAll("'", "''") + "'";
}
function stateSql(
  alias: 'old' | 'new',
  resource: Resources[string],
  fields: readonly string[],
  filterColumns: readonly string[],
) {
  const scope = resource.scopeColumn === null ? 'null' : `${alias}.${ident(resource.scopeColumn)}`;
  const values = fields.flatMap(field => [quoted(field), `${alias}.${ident(field)}`]).join(',');
  const equality = filterColumns.flatMap(field => [quoted(field), `${alias}.${ident(field)}`]).join(',');
  return `json_object('kind','known','scope',${scope},'fields',json_object(${values})${equality ? `,'equalityFields',json_object(${equality})` : ''})`;
}
function installObservers(database: DatabaseSync, resources: Resources, manifest: QueryManifest) {
  for (const name of activeObservers.get(database)?.triggers ?? [])
    database.exec(`drop trigger if exists temp.${ident(name)}`);
  database.exec(`create temp table if not exists ${ident(collectorTable)}(
    resource text not null,operation text not null,before_state text not null,after_state text not null,changed_columns text
  );create temp table if not exists ${ident(collectorResources)}(resource text primary key, widened integer not null default 0)`);
  for (const [resourceId, resource] of Object.entries(resources)) {
    const filterColumns = [
      ...new Set(
        Object.values(manifest.reads)
          .flat()
          .filter(read => read.resource === resourceId)
          .flatMap(read => (read.filters ?? []).map(filter => filter.column)),
      ),
    ];
    const fields = [
      ...new Set([
        ...(resource.scopeColumn === null ? [] : [resource.scopeColumn]),
        ...identityColumns(resource),
        ...Object.values(manifest.reads)
          .flat()
          .filter(read => read.resource === resourceId)
          .flatMap(read => [
            ...read.bindings.map(binding => binding.column),
            ...(read.filters ?? []).map(filter => filter.column),
          ]),
      ]),
    ].sort();
    for (const operation of ['insert', 'update', 'delete'] as const) {
      const name = ident(triggerName(resourceId, operation));
      database.exec(`drop trigger if exists temp.${name}`);
      const before =
        operation === 'insert'
          ? quoted(JSON.stringify({ kind: 'absent' }))
          : stateSql('old', resource, fields, filterColumns);
      const after =
        operation === 'delete'
          ? quoted(JSON.stringify({ kind: 'absent' }))
          : stateSql('new', resource, fields, filterColumns);
      const differs = (column: string) =>
        `quote(old.${ident(column)}) collate binary is not quote(new.${ident(column)}) collate binary`;
      const changed =
        operation === 'update'
          ? `json_object(${resource.columns.flatMap(column => [quoted(column), differs(column)]).join(',')})`
          : 'null';
      const when = operation === 'update' ? ` when ${resource.columns.map(differs).join(' or ')}` : '';
      database.exec(`create temp trigger ${name} after ${operation} on main.${ident(resource.table)}${when} begin
        insert or ignore into ${ident(collectorResources)}(resource) values(${quoted(resourceId)});
        insert into ${ident(collectorTable)}(resource,operation,before_state,after_state,changed_columns)
          select ${quoted(resourceId)},${quoted(operation)},${before},${after},${changed}
          where (select widened from ${ident(collectorResources)} where resource=${quoted(resourceId)})=0;
        update ${ident(collectorResources)} set widened=1 where resource=(
          select resource from ${ident(collectorTable)} group by resource
          order by sum(length(cast(before_state as blob))+length(cast(after_state as blob))+coalesce(length(cast(changed_columns as blob)),0)) desc limit 1
        ) and (
          (select count(*) from ${ident(collectorTable)})>${LIMITS.facts}
          or (select coalesce(sum(length(cast(before_state as blob))+length(cast(after_state as blob))+coalesce(length(cast(changed_columns as blob)),0)),0) from ${ident(collectorTable)})>${LIMITS.factBytes}
        );
        delete from ${ident(collectorTable)} where resource in (select resource from ${ident(collectorResources)} where widened=1);
      end`);
    }
  }
}
function observedFacts(database: DatabaseSync): WriteFact[] {
  const broad: WriteFact[] = database
    .prepare(`select resource from ${ident(collectorResources)} where widened=1 order by resource`)
    .all()
    .map(row => ({
      resource: String(row.resource),
      operation: 'unknown',
      before: { kind: 'unknown' },
      after: { kind: 'unknown' },
      changedColumns: null,
    }));
  const rows = database
    .prepare(`select resource,operation,before_state,after_state,changed_columns from ${ident(collectorTable)}`)
    .all();
  return [
    ...broad,
    ...rows.map(row => {
      const parseState = (value: unknown): RowState => {
        try {
          const parsed = JSON.parse(String(value)) as RowState;
          if (parsed.kind === 'absent') return parsed;
          if (
            parsed.kind === 'known' &&
            isScalar(parsed.scope) &&
            parsed.fields &&
            Object.values(parsed.fields).every(isScalar)
          )
            return parsed;
        } catch {}
        return { kind: 'unknown' };
      };
      let changedColumns: string[] | null = null;
      try {
        const changed = JSON.parse(String(row.changed_columns));
        if (changed && typeof changed === 'object' && !Array.isArray(changed))
          changedColumns = Object.entries(changed)
            .filter(([, value]) => value === 1 || value === true)
            .map(([column]) => column);
      } catch {}
      return {
        resource: String(row.resource),
        operation: row.operation as WriteFact['operation'],
        before: parseState(row.before_state),
        after: parseState(row.after_state),
        changedColumns,
      };
    }),
  ];
}
function assertNativeStatement(text: string) {
  if (!text.trim() || text.includes('\0')) throw new Error('SQLITE_SINGLE_STATEMENT_REQUIRED');
  let tokens: string[];
  try {
    tokens = sqlTokens(text, true);
  } catch (error) {
    if (error instanceof Error && error.message === 'SQLITE_SINGLE_STATEMENT_REQUIRED') throw error;
    throw new Error('SQLITE_SINGLE_STATEMENT_REQUIRED', { cause: error });
  }
  if (!tokens.length) throw new Error('SQLITE_SINGLE_STATEMENT_REQUIRED');
  if (tokens.some(token => [collectorTable.toUpperCase(), collectorResources.toUpperCase()].includes(token)))
    throw new Error('SQLITE_OBSERVER_ACCESS_FORBIDDEN');
  if (
    [
      'BEGIN',
      'COMMIT',
      'END',
      'ROLLBACK',
      'SAVEPOINT',
      'RELEASE',
      'ATTACH',
      'DETACH',
      'PRAGMA',
      'VACUUM',
      'CREATE',
      'ALTER',
      'DROP',
    ].includes(tokens[0])
  )
    throw new Error('SQLITE_TRANSACTION_OR_DDL_FORBIDDEN');
  // SQLite may omit DELETE triggers for REPLACE unless recursive_triggers is on.
  // Reject it instead of silently losing the OLD selector membership.
  if (
    tokens[0] === 'REPLACE' ||
    tokens.some(
      (token, index) =>
        ['INSERT', 'UPDATE'].includes(token) && tokens[index + 1] === 'OR' && tokens[index + 2] === 'REPLACE',
    )
  )
    throw new Error('SQLITE_REPLACE_UNSUPPORTED');
}

export function sqliteAdapter(options: SqliteOptions): ImpactAdapter<SqliteCommandDb> {
  const database = options?.database;
  if (!database || typeof database.prepare !== 'function') throw new Error('SQLITE_CONNECTION_REQUIRED');
  return Object.freeze({
    [bindAdapter](resources: Resources, manifest: QueryManifest) {
      let comparisonsValidated = false;
      let stringComparisons: readonly VerifiedStringComparison[] = [];
      const key = canonical({ resources, reads: manifest.reads });
      const prepare = (force = false) => {
        if (!force && activeObservers.get(database)?.key === key) return;
        installObservers(database, resources, manifest);
        activeObservers.set(database, {
          key,
          triggers: Object.keys(resources).flatMap(id => ['insert', 'update', 'delete'].map(op => triggerName(id, op))),
        });
      };
      const validate = () =>
        serial(database, async () => {
          comparisonsValidated = false;
          stringComparisons = [];
          const exactStringColumns = validateCatalog(database, resources);
          prepare(true);
          stringComparisons = verifiedStringComparisons(manifest, (resource, column) =>
            exactStringColumns.has(canonical([resource, column])),
          );
          comparisonsValidated = true;
        });
      const select: SelectExecutor = async (plan, input: Input) => {
        if (plan.kind !== 'select') throw new Error('POSTGRES_QUERY_REQUIRES_POSTGRES_ADAPTER');
        const statement = compileSelect(plan, input, resources);
        return database
          .prepare(statement.text)
          .all(bindings(statement.values))
          .map(row => JSON.parse(String(row.value)) as DataRow);
      };
      function dbFor(): SqliteCommandDb {
        let savepointId = 0;
        const db: SqliteCommandDb = {
          prepare(text) {
            assertNativeStatement(text);
            const statement = database.prepare(text);
            return {
              all: statement.all.bind(statement),
              get: statement.get.bind(statement),
              run: statement.run.bind(statement),
            };
          },
          async execute(text, values = []) {
            assertNativeStatement(text);
            return database.prepare(text).all(...values) as DataRow[];
          },
          async savepoint<T>(work: (child: SqliteCommandDb) => Promise<T>): Promise<T> {
            const name = ident('sdi_' + ++savepointId);
            database.exec('savepoint ' + name);
            try {
              const data = await work(db);
              database.exec('release savepoint ' + name);
              return data;
            } catch (error) {
              database.exec('rollback to savepoint ' + name);
              database.exec('release savepoint ' + name);
              throw error;
            }
          },
        };
        return db;
      }
      async function transaction<T>(readOnly: boolean, work: () => Promise<T>): Promise<T> {
        return serial(database, async () => {
          if (database.isTransaction) throw new Error('SQLITE_CONNECTION_ALREADY_IN_TRANSACTION');
          database.exec(readOnly ? 'begin' : 'begin immediate');
          try {
            const data = await work();
            database.exec('commit');
            return data;
          } catch (error) {
            if (database.isTransaction) database.exec('rollback');
            throw error;
          }
        });
      }
      return {
        validate,
        verifiedStringComparisons: () => stringComparisons,
        query: <T>(_scope: Scalar, work: (execute: SelectExecutor) => Promise<T>) =>
          transaction(true, () => work(select)),
        command: <T>(_scope: Scalar, writes: WriteSet, work: (db: SqliteCommandDb) => Promise<T>) =>
          serial(database, async () => {
            prepare();
            if (database.isTransaction) throw new Error('SQLITE_CONNECTION_ALREADY_IN_TRANSACTION');
            database.exec(`delete from ${ident(collectorTable)};delete from ${ident(collectorResources)}`);
            database.exec('begin immediate');
            let committed = false;
            let data!: T;
            try {
              const guarded = guardDatabase(dbFor(), {
                syncFactories: new Set(['prepare']),
                syncMethods: new Set(['all', 'get', 'run']),
              });
              try {
                data = await work(guarded.db);
                guarded.finish();
              } finally {
                guarded.close();
                await guarded.settle();
              }
              database.exec('commit');
              committed = true;
              try {
                const facts = observedFacts(database);
                if (!comparisonsValidated)
                  for (const fact of facts)
                    for (const row of [fact.before, fact.after]) if (row.kind === 'known') delete row.equalityFields;
                writes.add(facts);
                database.exec(`delete from ${ident(collectorTable)};delete from ${ident(collectorResources)}`);
              } catch (cause) {
                throw new ImpactUnavailableError(data, { cause });
              }
              return data;
            } catch (error) {
              if (!committed && database.isTransaction) database.exec('rollback');
              if (!committed)
                database.exec(`delete from ${ident(collectorTable)};delete from ${ident(collectorResources)}`);
              throw error;
            }
          }),
      };
    },
  });
}
