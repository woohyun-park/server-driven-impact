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
      undefined,
      true,
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
