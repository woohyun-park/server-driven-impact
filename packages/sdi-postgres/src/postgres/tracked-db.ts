import type postgres from 'postgres';
import type { TransactionSql } from 'postgres';
import { sql, Sql, identifier } from './sql.js';
import type { WriteSet } from '@server-driven-impact/core';
import type { Scalar } from '@server-driven-impact/core';
import type { Resources } from '@server-driven-impact/runtime/adapter';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { assertCommandSql } from './command-sql.js';
import type { DriverQueryOptions } from './driver-execution.js';
export type Transaction = Pick<TransactionSql, 'unsafe'>;
export type PostgresExecuteResult = postgres.RowList<Record<string, unknown>[]>;
export type Row = Record<string, any>; // Database rows are validated at domain/API boundaries.
export class TrackedDb<TResult = PostgresExecuteResult> {
  private open = true;
  private savepointId = 0;
  readonly tx: Transaction;
  readonly writes: WriteSet;
  readonly scope: Scalar;
  private resources: Resources;
  constructor(
    tx: Transaction,
    writes: WriteSet,
    scope: Scalar,
    resources: Resources,
    private readonly executeStatement: (statement: Sql, options?: DriverQueryOptions) => Promise<TResult> = statement =>
      tx.unsafe(statement.text, statement.values as never[]) as unknown as Promise<TResult>,
  ) {
    this.tx = tx;
    this.writes = writes;
    this.scope = scope;
    this.resources = resources;
  }
  close() {
    this.open = false;
  }
  private async queryRows(statement: Sql): Promise<Row[]> {
    if (!this.open) throw new Error('WRITE_CONTEXT_CLOSED');
    return [...(await this.tx.unsafe(statement.text, statement.values as never[]))];
  }
  /** Execute once and return the selected driver's result container unchanged. */
  async execute(statement: Sql): Promise<TResult> {
    if (!this.open) throw new Error('WRITE_CONTEXT_CLOSED');
    if (!(statement instanceof Sql)) throw new Error('SQL_FRAGMENT_REQUIRED');
    const copy = new Sql(statement.text, [...statement.values]);
    await assertCommandSql(copy.text);
    return this.executeStatement(copy);
  }
  async query(
    query: string | { text: string; values?: readonly unknown[]; rowMode?: 'array'; types?: unknown; name?: string },
    values?: readonly unknown[],
  ): Promise<TResult> {
    if (!this.open) throw new Error('WRITE_CONTEXT_CLOSED');
    if (
      query &&
      typeof query === 'object' &&
      Object.keys(query).some(key => !['text', 'values', 'rowMode', 'types', 'name'].includes(key))
    )
      throw new Error('UNSUPPORTED_QUERY_OPTION');
    const config = typeof query === 'string' ? { text: query, values } : { ...query, values: values ?? query?.values };
    if (!config || typeof config.text !== 'string' || (config.values !== undefined && !Array.isArray(config.values)))
      throw new Error('INVALID_QUERY_CONFIG');
    // Snapshot before async validation so callers cannot switch SQL after it passed.
    const text = config.text,
      parameters = [...(config.values ?? [])];
    const options = { rowMode: config.rowMode, types: config.types, name: config.name };
    if (options.rowMode !== undefined && options.rowMode !== 'array') throw new Error('INVALID_ROW_MODE');
    await assertCommandSql(text);
    return this.executeStatement(new Sql(text, parameters), options);
  }
  async copyFrom(
    statement: Sql,
    source: AsyncIterable<Uint8Array | string> | Iterable<Uint8Array | string>,
  ): Promise<void> {
    if (
      !(statement instanceof Sql) ||
      statement.values.length ||
      !/^\s*copy\b[\s\S]*\bfrom\s+stdin\b/i.test(statement.text)
    )
      throw new Error('COPY_FROM_STDIN_REQUIRED');
    if (!this.open) throw new Error('WRITE_CONTEXT_CLOSED');
    const text = statement.text;
    await assertCommandSql(text);
    const query = this.tx.unsafe(text) as unknown as { writable(): Promise<NodeJS.WritableStream> };
    await pipeline(Readable.from(source), await query.writable());
  }
  async *copyTo(statement: Sql): AsyncIterable<Uint8Array> {
    if (
      !(statement instanceof Sql) ||
      statement.values.length ||
      !/^\s*copy\b[\s\S]*\bto\s+stdout\b/i.test(statement.text)
    )
      throw new Error('COPY_TO_STDOUT_REQUIRED');
    if (!this.open) throw new Error('WRITE_CONTEXT_CLOSED');
    const text = statement.text;
    await assertCommandSql(text);
    const query = this.tx.unsafe(text) as unknown as { readable(): Promise<NodeJS.ReadableStream> };
    for await (const chunk of await query.readable()) yield chunk as Uint8Array;
  }
  async *cursor(statement: Sql, batchSize = 100): AsyncIterable<Row[]> {
    if (!(statement instanceof Sql) || !Number.isInteger(batchSize) || batchSize < 1 || batchSize > 10000)
      throw new Error('INVALID_CURSOR_BATCH_SIZE');
    if (!this.open) throw new Error('WRITE_CONTEXT_CLOSED');
    const text = statement.text,
      values = [...statement.values];
    await assertCommandSql(text);
    const query = this.tx.unsafe(text, values as never[]) as unknown as { cursor(rows: number): AsyncIterable<Row[]> };
    for await (const rows of query.cursor(batchSize)) yield [...rows];
  }
  async refreshMaterializedView(
    resource: string,
    options: { concurrently?: boolean; withData?: boolean } = {},
  ): Promise<void> {
    const definition = this.resources[resource];
    if (definition?.postgresKind !== 'materialized-view') throw new Error('MATERIALIZED_VIEW_RESOURCE_REQUIRED');
    if (options.concurrently && options.withData === false) throw new Error('INVALID_REFRESH_OPTIONS');
    const concurrently = options.concurrently ? new Sql(' concurrently') : new Sql('');
    const data = options.withData === false ? new Sql(' with no data') : new Sql(' with data');
    await this.queryRows(sql`refresh materialized view${concurrently} ${this.table(resource)}${data}`);
    this.writes.add([
      { resource, operation: 'unknown', before: { kind: 'unknown' }, after: { kind: 'unknown' }, changedColumns: null },
    ]);
  }
  private table(resource: string) {
    if (!Object.hasOwn(this.resources, resource)) throw new Error('UNREGISTERED_RESOURCE');
    const r = this.resources[resource];
    return sql`${identifier(r.schema ?? 'public')}.${identifier(r.table)}`;
  }
  async savepoint<T>(work: (db: TrackedDb<TResult>) => Promise<T>): Promise<T> {
    const name = identifier('tracked_' + ++this.savepointId);
    const child = new TrackedDb(this.tx, this.writes.fork(), this.scope, this.resources, this.executeStatement);
    await this.queryRows(sql`savepoint ${name}`);
    try {
      const result = await work(child);
      await this.queryRows(sql`release savepoint ${name}`);
      this.writes.merge(child.writes);
      return result;
    } catch (error) {
      await this.queryRows(sql`rollback to savepoint ${name}`);
      await this.queryRows(sql`release savepoint ${name}`);
      throw error;
    } finally {
      child.close();
    }
  }
}
