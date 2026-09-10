import { compileSelect } from './select.js';
import type { SelectPlan } from '@server-driven-impact/runtime';
import type { TransactionSql } from 'postgres';
import { sql, Sql, identifier, join } from './sql.js';
import { WriteSet } from '@server-driven-impact/core';
import { LIMITS, type WriteFact, type Scalar } from '@server-driven-impact/core';
import { identityColumns, type Resources } from '@server-driven-impact/runtime/adapter';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { assertCommandSql } from './command-sql.js';
export type Transaction = Pick<TransactionSql,'unsafe'>;
const MAX_WRITE_FACTS = LIMITS.facts;
export type Row = Record<string, any>; // Database rows are validated at domain/API boundaries.
export type Patch = Record<string,unknown | Sql>;
export class TrackedDb {
  private open = true;
  private savepointId = 0;
  readonly tx: Transaction;
  readonly writes: WriteSet;
  readonly scope: Scalar;
  private resources: Resources;
  constructor(tx: Transaction, writes: WriteSet, scope: Scalar, resources: Resources, private observer?: (event:{resource:string;operation:string;before:Row[];after:Row[]})=>Promise<void>, private readonly databaseObserved = false) { this.tx=tx; this.writes=writes; this.scope=scope; this.resources=resources; }
  close() { this.open = false; }
  async selectPlan(plan: SelectPlan, resources: Resources): Promise<Row[]> {
    const statement = compileSelect(plan, {}, resources);
    return (await this.run(new Sql(statement.text, statement.values))).map(row => row.value);
  }
  private async run(statement: Sql) {
    if (!this.open) throw new Error('WRITE_CONTEXT_CLOSED');
    return this.tx.unsafe(statement.text,statement.values as never[]);
  }
  /** Execute trusted, parameterized PostgreSQL SQL on the owned transaction. */
  async execute(statement: Sql): Promise<Row[]> {
    if (!(statement instanceof Sql)) throw new Error('SQL_FRAGMENT_REQUIRED');
    await assertCommandSql(statement.text);
    return [...await this.run(statement)];
  }
  async copyFrom(statement: Sql, source: AsyncIterable<Uint8Array|string> | Iterable<Uint8Array|string>): Promise<void> {
    if (!(statement instanceof Sql) || statement.values.length || !/^\s*copy\b[\s\S]*\bfrom\s+stdin\b/i.test(statement.text)) throw new Error('COPY_FROM_STDIN_REQUIRED');
    await assertCommandSql(statement.text);
    const query=this.tx.unsafe(statement.text) as unknown as {writable():Promise<NodeJS.WritableStream>};
    await pipeline(Readable.from(source),await query.writable());
  }
  async *copyTo(statement: Sql): AsyncIterable<Uint8Array> {
    if (!(statement instanceof Sql) || statement.values.length || !/^\s*copy\b[\s\S]*\bto\s+stdout\b/i.test(statement.text)) throw new Error('COPY_TO_STDOUT_REQUIRED');
    await assertCommandSql(statement.text);
    const query=this.tx.unsafe(statement.text) as unknown as {readable():Promise<NodeJS.ReadableStream>};
    for await(const chunk of await query.readable())yield chunk as Uint8Array;
  }
  async *cursor(statement: Sql, batchSize=100): AsyncIterable<Row[]> {
    if (!(statement instanceof Sql) || !Number.isInteger(batchSize) || batchSize<1 || batchSize>10000) throw new Error('INVALID_CURSOR_BATCH_SIZE');
    await assertCommandSql(statement.text);
    const query=this.tx.unsafe(statement.text,statement.values as never[]) as unknown as {cursor(rows:number):AsyncIterable<Row[]>};
    for await(const rows of query.cursor(batchSize))yield [...rows];
  }
  async refreshMaterializedView(resource: string, options: {concurrently?:boolean;withData?:boolean} = {}): Promise<void> {
    const definition=this.resources[resource];
    if(!definition || definition.postgresKind!=='materialized-view')throw new Error('MATERIALIZED_VIEW_RESOURCE_REQUIRED');
    if(options.concurrently && options.withData===false)throw new Error('INVALID_REFRESH_OPTIONS');
    const concurrently=options.concurrently ? new Sql(' concurrently') : new Sql('');
    const data=options.withData===false ? new Sql(' with no data') : new Sql(' with data');
    await this.run(sql`refresh materialized view${concurrently} ${this.table(resource)}${data}`);
    this.writes.add([{resource,operation:'unknown',before:{kind:'unknown'},after:{kind:'unknown'},changedColumns:null}]);
  }
  private table(resource: string) {
    if (!Object.hasOwn(this.resources,resource)) throw new Error('UNREGISTERED_RESOURCE');
    const r=this.resources[resource];
    return sql`${identifier(r.schema ?? 'public')}.${identifier(r.table)}`;
  }
  private column(resource: string, name: string) {
    if (!this.resources[resource].columns.includes(name)) throw new Error('UNREGISTERED_COLUMN');
    return identifier(name);
  }
  async select(resource: string, where: Sql = sql`true`, options: {lock?:boolean;order?:Sql;limit?:number} = {}): Promise<Row[]> {
    const suffix = options.limit === undefined ? sql`` : sql`limit ${options.limit}`;
    const rows = await this.run(sql`select to_jsonb(t) as value from ${this.table(resource)} t where ${where} ${options.order ? sql`order by ${options.order}` : sql``} ${suffix} ${options.lock ? sql`for update of t` : sql``}`);
    return rows.map(r => r.value);
  }
  async require(resource: string, where: Sql, lock = false): Promise<Row> {
    const [row] = await this.select(resource,where,{lock,limit:1});
    if (!row) throw Object.assign(new Error('NOT_FOUND'),{code:'P0002'});
    return row;
  }
  async lock(resource: string, where: Sql) {
    await this.run(sql`with locked as materialized (select t.ctid from ${this.table(resource)} t where ${where} for update of t) select count(*) from locked`);
  }
  private rowState(value: Sql, resource: string): Sql {
    const config = this.resources[resource];
    const fields = (config.selectorColumns ?? identityColumns(config)).flatMap(column => [sql`${column}::text`,sql`${value}->${column}`]);
    return sql`case when ${value} is null then jsonb_build_object('kind','absent') else jsonb_build_object('kind','known','scope',${config.scopeColumn === null ? sql`null::jsonb` : sql`${value}->${config.scopeColumn}`},'fields',jsonb_build_object(${join(fields)})) end`;
  }
  private async collect(resource: string, operation: 'insert'|'update'|'delete'|'upsert', mutation: Sql, returnRows: boolean) {
    if (this.databaseObserved) {
      const [result] = await this.run(sql`with ${mutation}
        select count(*)::int as count,
        ${returnRows ? sql`coalesce(jsonb_agg(coalesce(changed.after_row,changed.before_row)),'[]'::jsonb)` : sql`'[]'::jsonb`} as rows
        from changed`);
      return {count:Number(result.count),rows:returnRows ? result.rows as Row[] : []};
    }
    if (this.observer && operation === 'upsert') throw new Error('HOOK_UPSERT_UNSUPPORTED');
    const before = this.rowState(sql`c.before_row`,resource), after = this.rowState(sql`c.after_row`,resource);
    const changed = operation === 'update'
      ? sql`(select coalesce(jsonb_agg(k),'[]'::jsonb) from jsonb_object_keys(coalesce(c.before_row,'{}'::jsonb) || coalesce(c.after_row,'{}'::jsonb)) k where c.before_row->k is distinct from c.after_row->k)`
      : sql`null::jsonb`;
    const detail=sql`jsonb_build_object('resource',${resource}::text,'operation',${operation === 'upsert' ? 'unknown' : operation}::text,'before',${before},'after',${after},'changedColumns',${changed})`;
    const [result] = await this.run(sql`with ${mutation}, n as (select count(*) as count from changed),
      details as materialized (select ${detail} as fact from changed c where (select count from n)<=${MAX_WRITE_FACTS})
      select n.count::int as count,
      ${returnRows || this.observer ? sql`(select coalesce(jsonb_agg(coalesce(c.after_row,c.before_row)),'[]'::jsonb) from (select * from changed limit ${MAX_WRITE_FACTS+1}) c)` : sql`'[]'::jsonb`} as rows,
      ${this.observer ? sql`(select coalesce(jsonb_agg(c.before_row) filter (where c.before_row is not null),'[]'::jsonb) from (select * from changed limit ${MAX_WRITE_FACTS+1}) c)` : sql`'[]'::jsonb`} as before_rows,
      case when n.count <= ${MAX_WRITE_FACTS} and (select coalesce(sum(octet_length(fact::text)),0) from details)<=${LIMITS.factBytes} then
        (select coalesce(jsonb_agg(fact),'[]'::jsonb) from details)
      else jsonb_build_array(jsonb_build_object('resource',${resource}::text,'operation','unknown','before',jsonb_build_object('kind','unknown'),'after',jsonb_build_object('kind','unknown'),'changedColumns',null))
      end as facts from n`);
    if ((returnRows || this.observer) && result.rows.length > MAX_WRITE_FACTS) throw new Error('USE_BATCH_WRITE_WITHOUT_ROWS');
    this.writes.add(result.facts as WriteFact[]);
    if (this.observer && result.count) await this.observer({resource,operation,before:result.before_rows,after:operation === 'delete' ? [] : result.rows});
    return {count:Number(result.count),rows:returnRows ? result.rows as Row[] : []};
  }
  async insert(resource: string, rows: Row[], options: {returnRows?:boolean;conflict?:{keys:string[];patch?:Patch;where?:Sql}} = {}) {
    if (!this.open) throw new Error('WRITE_CONTEXT_CLOSED');
    if (!rows.length) return {count:0,rows:[] as Row[]};
    const names = Object.keys(rows[0]);
    if (rows.some(row => Object.keys(row).sort().join() !== [...names].sort().join())) throw new Error('BATCH_COLUMNS_MUST_MATCH');
    const columns = names.map(name => this.column(resource,name));
    const source = sql`select ${join(columns.map(c => sql`r.${c}`))} from jsonb_populate_recordset(null::${this.table(resource)},${JSON.stringify(rows)}::text::jsonb) r`;
    return this.insertSelect(resource,names,source,options);
  }
  async insertSelect(resource: string, names: string[], source: Sql, options: {returnRows?:boolean;conflict?:{keys:string[];patch?:Patch;where?:Sql}} = {}) {
    const conflict = options.conflict;
    const onConflict = conflict ? sql`on conflict (${join(conflict.keys.map(k => this.column(resource,k)))}) ${conflict.patch
      ? sql`do update set ${this.assignments(resource,conflict.patch)} ${conflict.where ? sql`where ${conflict.where}` : sql``}`
      : sql`do nothing`}` : sql``;
    // UPSERT OLD scope is not universally available. Widen updates conservatively.
    const result = await this.collect(resource,conflict?.patch ? 'upsert' : 'insert',sql`changed as (insert into ${this.table(resource)} as t (${join(names.map(n => this.column(resource,n)))}) ${source} ${onConflict} returning null::jsonb as before_row,to_jsonb(t) as after_row)`,options.returnRows ?? false);
    if (!this.databaseObserved && conflict?.patch && result.count) this.writes.add([{resource,operation:'unknown',before:{kind:'unknown'},after:{kind:'unknown'},changedColumns:null}]);
    return result;
  }
  private assignments(resource: string, patch: Patch) {
    return join(Object.entries(patch).map(([name,value]) => sql`${this.column(resource,name)} = ${value}`));
  }
  async update(resource: string, patch: Patch, where: Sql, options: {returnRows?:boolean;from?:Sql} = {}) {
    if (this.databaseObserved) {
      const from = options.from ? sql`from ${options.from}` : sql``;
      return this.collect(resource,'update',sql`changed as (update ${this.table(resource)} as t set ${this.assignments(resource,patch)} ${from} where ${where} returning null::jsonb as before_row,to_jsonb(t) as after_row)`,options.returnRows ?? false);
    }
    const from = options.from ? sql`, ${options.from}` : sql``;
    return this.collect(resource,'update',sql`before_rows as materialized (select t.ctid as __tracked_tid,t.* from ${this.table(resource)} t ${options.from ? sql`cross join ${options.from}` : sql``} where ${where} for update of t),
      changed as (update ${this.table(resource)} as t set ${this.assignments(resource,patch)} from before_rows b ${from} where t.ctid=b.__tracked_tid and (${where}) returning to_jsonb(b) - '__tracked_tid' as before_row,to_jsonb(t) as after_row)`,options.returnRows ?? false);
  }
  async delete(resource: string, where: Sql) {
    if (this.databaseObserved) return this.collect(resource,'delete',sql`changed as (delete from ${this.table(resource)} as t where ${where} returning to_jsonb(t) as before_row,null::jsonb as after_row)`,false);
    // Hold parent keys while explicitly deleting children; FK cascade remains a safety net.
    await this.lock(resource,where);
    const identity = identityColumns(this.resources[resource]);
    if ((this.resources[resource].cascades?.length ?? 0) && identity.length !== 1) throw new Error('MANUAL_CASCADE_REQUIRES_SINGLE_IDENTITY');
    const parents = identity.length ? sql`select t.${identifier(identity[0])} from ${this.table(resource)} t where ${where}` : sql`select null where false`;
    for (const child of this.resources[resource].cascades ?? []) await this.delete(child.resource,sql`t.${identifier(child.column)} in (${parents})`);
    return this.collect(resource,'delete',sql`changed as (delete from ${this.table(resource)} as t where ${where} returning to_jsonb(t) as before_row,null::jsonb as after_row)`,false);
  }
  async savepoint<T>(work: (db: TrackedDb) => Promise<T>): Promise<T> {
    const name = identifier('tracked_'+(++this.savepointId));
    const child = new TrackedDb(this.tx,this.writes.fork(),this.scope,this.resources,undefined,this.databaseObserved);
    await this.run(sql`savepoint ${name}`);
    try {
      const result = await work(child);
      await this.run(sql`release savepoint ${name}`);
      this.writes.merge(child.writes); return result;
    } catch (error) { await this.run(sql`rollback to savepoint ${name}`); await this.run(sql`release savepoint ${name}`); throw error; }
    finally { child.close(); }
  }
}
