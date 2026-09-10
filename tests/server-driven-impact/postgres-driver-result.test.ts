import { Readable, Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { WriteSet } from '@server-driven-impact/core';
import { sql, type PostgresCommandDb } from '@server-driven-impact/postgres';
import type { PgCommandDb } from '@server-driven-impact/postgres/pg';
import { TrackedDb } from '../../packages/sdi-postgres/src/postgres/tracked-db.js';
import { Sql } from '../../packages/sdi-postgres/src/postgres/sql.js';

describe('PostgreSQL driver result contract', () => {
  it('returns the driver result by reference, executes once, and preserves it through savepoints', async () => {
    const result = { marker: 'driver-result' } as const;
    let executions = 0;
    const tracked = new TrackedDb(
      { unsafe: async () => [] } as never,
      new WriteSet(),
      null,
      { rows: { table: 'rows', idColumn: 'id', scopeColumn: null, columns: ['id'] } },
      async () => { executions++; return result; },
    );

    expect(await tracked.execute(new Sql('update rows set id=id'))).toBe(result);
    expect(executions).toBe(1);
    expect(await tracked.savepoint(child => child.execute(new Sql('select 1')))).toBe(result);
    expect(executions).toBe(2);
    tracked.close();
    await expect(tracked.execute(new Sql('select 1'))).rejects.toThrow('WRITE_CONTEXT_CLOSED');
  });
});

function driverResultTypes(pg: PgCommandDb, postgres: PostgresCommandDb) {
  void pg.execute(sql`update rows set id=id`).then(result => {
    const rowCount: number | null = result.rowCount;
    const rows: Record<string, unknown>[] = result.rows;
    void rowCount; void rows;
  });
  void pg.savepoint(db => db.execute(sql`select 1`)).then(result => {
    const rowCount: number | null = result.rowCount;
    void rowCount;
  });
  void postgres.execute(sql`update rows set id=id`).then(result => {
    const count: number = result.count;
    const rows: Record<string, unknown>[] = result;
    void count; void rows;
  });
}
void driverResultTypes;

it('snapshots stream SQL before async validation to prevent post-validation mutation', async () => {
  const executed: string[] = [];
  const tracked = new TrackedDb({unsafe:(text:string)=>{
    executed.push(text);
    return {
      async writable() {return new Writable({write(_chunk,_encoding,done){done();}});},
      async readable() {return Readable.from(['row']);},
      async *cursor() {yield [{id:'one'}];},
    };
  }} as never,new WriteSet(),null,{});
  const input = new Sql('copy rows from stdin');
  const copying = tracked.copyFrom(input,['one\n']);
  Object.assign(input,{text:'commit'});
  await copying;
  const output = new Sql('copy rows to stdout');
  const reading = tracked.copyTo(output)[Symbol.asyncIterator]();
  const first = reading.next(); Object.assign(output,{text:'rollback'}); await first; await reading.return?.();
  const select = new Sql('select 1');
  const cursor = tracked.cursor(select)[Symbol.asyncIterator]();
  const next = cursor.next(); Object.assign(select,{text:'commit'}); await next; await cursor.return?.();
  expect(executed).toEqual(['copy rows from stdin','copy rows to stdout','select 1']);
});
