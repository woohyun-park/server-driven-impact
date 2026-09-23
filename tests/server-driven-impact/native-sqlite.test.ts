import { affectedTargets } from './impact-assertions.js';
import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { createImpact, q, type Resources } from '@server-driven-impact/runtime';
import { sqliteAdapter, type SqliteStatement } from '@server-driven-impact/sqlite';
import { matchesInputSelector } from '@server-driven-impact/core';

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
function fixture() {
  const database = new DatabaseSync(':memory:');
  databases.push(database);
  database.exec(
    'pragma foreign_keys=on; create table rows(id text primary key, customer text); create table notes(id text primary key, body text)',
  );
  const resources: Resources = {
    rows: { table: 'rows', idColumn: 'id', scopeColumn: null, columns: ['id', 'customer'] },
    notes: { table: 'notes', idColumn: 'id', scopeColumn: null, columns: ['id', 'body'] },
  };
  const input = { parse: (value: unknown) => value as Record<string, unknown> };
  const queries = {
    list: { input, plan: q.select('rows', { where: [q.eq('customer', q.input('customer'))] }) },
    note: { input, plan: q.select('notes', { where: [q.eq('id', q.input('id'))] }) },
  };
  return {
    database,
    resources,
    queries,
    engine: createImpact({ adapter: sqliteAdapter({ database }), resources, queries }),
  };
}
describe('SQLite native statement lifecycle and collection', () => {
  it('preserves synchronous run/get/all results and closes escaped statements and savepoint children', async () => {
    const { engine, database } = fixture();
    await engine.validate();
    let escaped!: SqliteStatement, child!: SqliteStatement;
    const result = await engine.command({ scope: null }, async tx => {
      escaped = tx.prepare('insert into rows values(?,?)');
      expect(escaped.run('one', 'a').changes).toBe(1);
      expect(tx.prepare('select * from rows').get()).toMatchObject({ id: 'one', customer: 'a' });
      await expect(
        tx.savepoint(async inner => {
          child = inner.prepare('insert into rows values(?,?)');
          child.run('rolled', 'b');
          throw new Error('cancel');
        }),
      ).rejects.toThrow('cancel');
      expect(() => child.run('late-child', 'x')).toThrow('WRITE_CONTEXT_CLOSED');
      return tx.prepare('select * from rows').all();
    });
    expect(result.data).toHaveLength(1);
    expect(affectedTargets(result.impact).find(t => t.endpoint === 'list')?.selector).toEqual({
      kind: 'inputs',
      values: [{ customer: 'a' }],
    });
    expect(() => escaped.run('late', 'x')).toThrow('WRITE_CONTEXT_CLOSED');
    expect(database.prepare('select count(*) as n from rows').get()?.n).toBe(1);
  });
  it('prevents observer mutation and shared-engine observer drift', async () => {
    const { engine, database, resources } = fixture();
    await engine.validate();
    await expect(
      engine.command({ scope: null }, tx => tx.execute('delete from temp.sdi_observed_facts')),
    ).rejects.toThrow('SQLITE_OBSERVER_ACCESS_FORBIDDEN');
    const byId = createImpact({
      adapter: sqliteAdapter({ database }),
      resources,
      queries: {
        id: {
          input: { parse: v => v as Record<string, unknown> },
          plan: q.select('rows', { where: [q.eq('id', q.input('id'))] }),
        },
      },
    });
    await byId.validate();
    const first = await engine.command({ scope: null }, async tx =>
      tx.prepare('insert into rows values(?,?)').run('one', 'customer'),
    );
    expect(affectedTargets(first.impact).find(t => t.endpoint === 'list')?.selector).toEqual({
      kind: 'inputs',
      values: [{ customer: 'customer' }],
    });
    const second = await byId.command({ scope: null }, async tx =>
      tx.prepare('update rows set customer=? where id=?').run('next', 'one'),
    );
    expect(affectedTargets(second.impact)[0].selector).toEqual({ kind: 'inputs', values: [{ id: 'one' }] });
  });
  it('rejects UPDATE OR REPLACE before a conflicting row can disappear without an observer event', async () => {
    const { engine, database } = fixture();
    await engine.validate();
    database.exec("insert into rows values('1','A'),('2','B')");
    expect(database.prepare('pragma recursive_triggers').get()?.recursive_triggers).toBe(0);
    await expect(
      engine.command({ scope: null }, tx => tx.execute("update or replace rows set id='2' where id='1'")),
    ).rejects.toThrow('SQLITE_REPLACE_UNSUPPORTED');
    await expect(
      engine.command({ scope: null }, async tx =>
        tx
          .prepare(
            "with target as (select '1' as id) update /* conflict policy */ or replace rows set id='2' where id in (select id from target)",
          )
          .run(),
      ),
    ).rejects.toThrow('SQLITE_REPLACE_UNSUPPORTED');
    expect(database.prepare('select * from rows order by id').all()).toEqual([
      { id: '1', customer: 'A' },
      { id: '2', customer: 'B' },
    ]);
  });
  it('keeps independent resource selectors narrow when a large batch overflows', async () => {
    const { engine } = fixture();
    await engine.validate();
    const result = await engine.command({ scope: null }, async tx => {
      tx.prepare('insert into notes values(?,?)').run('single', 'text');
      const insert = tx.prepare('insert into rows values(?,?)');
      for (let i = 0; i < 250; i++) insert.run(String(i), 'many');
    });
    const note = affectedTargets(result.impact).find(t => t.endpoint === 'note')!;
    expect(note.selector).toEqual({ kind: 'inputs', values: [{ id: 'single' }] });
    expect(
      matchesInputSelector(
        { customer: 'many' },
        affectedTargets(result.impact).find(t => t.endpoint === 'list')!.selector,
      ),
    ).toBe(true);
  });
});
