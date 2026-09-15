import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  calculateImpact,
  createImpact as createCore,
  LIMITS,
  validateImpactManifest,
  WriteSet,
  type RowState,
  type Scalar,
  type WriteFact,
} from '@server-driven-impact/core';
import { compileManifest, createImpact, q, type Resources } from '@server-driven-impact/runtime';
import { sqliteAdapter } from '@server-driven-impact/sqlite';

const input = { parse: (value: unknown) => value };
const resources: Resources = {
  records: { table: 'records', idColumn: 'id', scopeColumn: null, columns: ['id', 'status', 'customer', 'value'] },
};
const manifest = {
  protocolVersion: 1 as const,
  reads: {
    ready: [{ resource: 'records', columns: ['id'], bindings: [], filters: [{ column: 'status', value: 'ready' }] }],
  },
};
const known = (status: Scalar, certified = true): RowState => ({
  kind: 'known',
  scope: null,
  fields: { status },
  ...(certified ? { equalityFields: { status } } : {}),
});
const inserted = (after: RowState): WriteFact => ({
  resource: 'records',
  operation: 'insert',
  before: { kind: 'absent' },
  after,
  changedColumns: null,
});

describe('necessary literal equality filters', () => {
  it('derives only necessary AND/common-OR conditions and preserves fixed filters through input mappings', () => {
    const ready = q.eq('status', q.literal('ready'));
    const graph = compileManifest(
      {
        exact: {
          input,
          plan: q.select('records', {
            where: [
              q.and(
                q.or(q.and(ready, q.eq('customer', q.input('a'))), q.and(ready, q.eq('customer', q.input('b')))),
                q.eq('value', q.literal(1)),
              ),
            ],
          }),
        },
        broad: {
          input,
          plan: q.select('records', {
            where: [q.or(ready, q.eq('status', q.literal('draft'))), q.not(q.eq('customer', q.literal('blocked')))],
          }),
        },
        mapped: { input, plan: q.call('exact', () => ({ a: 'a', b: 'b' })) },
      },
      resources,
    );
    expect(graph.reads.exact[0].filters).toEqual([
      { column: 'status', value: 'ready' },
      { column: 'value', value: 1 },
    ]);
    expect(graph.reads.broad[0].filters).toBeUndefined();
    expect(graph.reads.mapped[0].filters).toEqual(graph.reads.exact[0].filters);
    expect(graph.reads.mapped[0].bindings).toEqual([]);
  });
  it('requires certified values and evaluates OLD/NEW separately when a row enters or leaves a filter', () => {
    const core = createCore({ resources, manifest });
    expect(core.explain([inserted(known('draft'))], null)).toEqual({
      impact: { protocolVersion: 1, targets: [] },
      decisions: [{ resource: 'records', endpoint: 'ready', reason: 'filter-excluded' }],
    });
    for (const state of [
      known('draft', false),
      { kind: 'unknown' } as RowState,
      { kind: 'known', scope: null, fields: {}, equalityFields: {} } as RowState,
    ]) {
      expect(core.calculate([inserted(state)], null).targets).toHaveLength(1);
    }
    for (const [before, after] of [
      ['ready', 'draft'],
      ['draft', 'ready'],
    ]) {
      const moved: WriteFact = {
        resource: 'records',
        operation: 'update',
        before: known(before),
        after: known(after),
        changedColumns: ['status'],
      };
      expect(core.calculate([moved], null).targets).toHaveLength(1);
    }
    expect(
      core.calculate(
        [
          {
            resource: 'records',
            operation: 'update',
            before: known('draft'),
            after: known('archived'),
            changedColumns: ['status'],
          },
        ],
        null,
      ).targets,
    ).toEqual([]);
  });
  it.each<[Scalar, Scalar]>([
    [true, 1],
    [1, true],
    [1, '01'],
    ['1', 1],
    ['READY', 'ready'],
    ['ready  ', 'ready'],
    [0.1, 0.100000001],
    [null, null],
  ])('keeps possible SQL equality for certified %s and literal %s', (actual, expected) => {
    const policy = {
      protocolVersion: 1 as const,
      reads: {
        filtered: [
          {
            resource: 'records',
            columns: '*' as const,
            bindings: [],
            filters: [{ column: 'status', value: expected }],
          },
        ],
      },
    };
    expect(
      calculateImpact([inserted(known(actual))], { resources, manifest: policy, scope: null }).targets,
    ).toHaveLength(1);
  });
  it('bounds derived filters and validates persisted filter columns and values', () => {
    const graph = compileManifest(
      {
        many: {
          input,
          plan: q.select('records', {
            where: Array.from({ length: LIMITS.readFilters + 1 }, (_, value) => q.eq('value', q.literal(value))),
          }),
        },
      },
      resources,
    );
    expect(graph.reads.many[0].filters).toHaveLength(LIMITS.readFilters);
    expect(() =>
      validateImpactManifest(
        { ...manifest, reads: { ready: [{ ...manifest.reads.ready[0], filters: [{ column: 'missing', value: 1 }] }] } },
        resources,
      ),
    ).toThrow('UNREGISTERED_COLUMN');
    expect(() =>
      validateImpactManifest(
        {
          ...manifest,
          reads: {
            ready: [
              {
                ...manifest.reads.ready[0],
                filters: Array.from({ length: LIMITS.readFilters + 1 }, () => ({ column: 'status', value: 'ready' })),
              },
            ],
          },
        },
        resources,
      ),
    ).toThrow('INVALID_READ_FILTER');
  });
  it('retains only common certified values when WriteSet detail is summarized', () => {
    const writes = new WriteSet();
    writes.add(Array.from({ length: LIMITS.facts + 1 }, () => inserted(known('draft'))));
    expect(writes.snapshot()).toHaveLength(1);
    expect(calculateImpact(writes.snapshot(), { resources, manifest, scope: null }).targets).toEqual([]);
    writes.add([inserted(known('ready'))]);
    expect(calculateImpact(writes.snapshot(), { resources, manifest, scope: null }).targets).toHaveLength(1);
    writes.add([inserted(known('draft'))]);
    expect(calculateImpact(writes.snapshot(), { resources, manifest, scope: null }).targets).toHaveLength(1);
    const unproved = new WriteSet();
    unproved.add([
      inserted(known('draft', false)),
      ...Array.from({ length: LIMITS.facts }, () => inserted(known('draft'))),
    ]);
    expect(calculateImpact(unproved.snapshot(), { resources, manifest, scope: null }).targets).toHaveLength(1);
  });
});

describe('literal filters against actual SQLite comparison semantics', () => {
  it('excludes unrelated writes and includes empty-list insertion plus OLD/NEW filter transitions', async () => {
    const database = new DatabaseSync(':memory:');
    try {
      database.exec('create table records(id text primary key,status text,customer text,value integer);');
      const queries = {
        ready: {
          input,
          plan: q.select('records', {
            columns: ['id'],
            where: [q.eq('status', q.literal('ready')), q.eq('customer', q.input('customer'))],
          }),
        },
      };
      const engine = createImpact({ adapter: sqliteAdapter({ database }), resources, queries });
      await engine.validate();
      const context = { scope: null };
      expect(await engine.query('ready', { customer: 'a' }, context)).toEqual([]);
      const unrelated = await engine.command(context, tx =>
        tx.execute("insert into records values('one','draft','a',1)"),
      );
      expect(await engine.query('ready', { customer: 'a' }, context)).toEqual([]);
      expect(unrelated.impact.targets).toEqual([]);
      const entered = await engine.command(context, tx =>
        tx.execute("update records set status='ready' where id='one'"),
      );
      expect(await engine.query('ready', { customer: 'a' }, context)).toEqual([{ id: 'one' }]);
      expect(entered.impact.targets[0].selector).toEqual({ kind: 'inputs', values: [{ customer: 'a' }] });
      const left = await engine.command(context, tx =>
        tx.execute("update records set status='archived' where id='one'"),
      );
      expect(await engine.query('ready', { customer: 'a' }, context)).toEqual([]);
      expect(left.impact.targets[0].selector).toEqual({ kind: 'inputs', values: [{ customer: 'a' }] });
      expect(
        (await engine.command(context, tx => tx.execute("update records set status='draft' where id='one'"))).impact
          .targets,
      ).toEqual([]);
      const first = await engine.command(context, tx =>
        tx.execute("insert into records values('first','ready','b',1)"),
      );
      expect(await engine.query('ready', { customer: 'b' }, context)).toEqual([{ id: 'first' }]);
      expect(first.impact.targets[0].selector).toEqual({ kind: 'inputs', values: [{ customer: 'b' }] });
    } finally {
      database.close();
    }
  });
  it.each([
    { type: 'text collate nocase', literal: 'READY', stored: 'ready' },
    { type: 'text collate rtrim', literal: 'ready  ', stored: 'ready' },
    { type: 'integer', literal: '01', stored: 1 },
    { type: 'text', literal: 1, stored: '1.0' },
    { type: 'real', literal: 0.1000000000000001, stored: 0.1000000000000001 },
  ])('does not miss $type comparisons with literal $literal', async ({ type, literal, stored }) => {
    const database = new DatabaseSync(':memory:');
    try {
      database.exec(`create table records(id text primary key,status ${type},customer text,value integer);`);
      const queries = {
        filtered: {
          input,
          plan: q.select('records', { columns: ['id'], where: [q.eq('status', q.literal(literal))] }),
        },
        nullValue: { input, plan: q.select('records', { columns: ['id'], where: [q.eq('status', q.literal(null))] }) },
      };
      const engine = createImpact({ adapter: sqliteAdapter({ database }), resources, queries });
      await engine.validate();
      const context = { scope: null };
      expect(await engine.query('filtered', {}, context)).toEqual([]);
      const result = await engine.command(context, tx =>
        tx.execute('insert into records values(?,?,?,?)', ['one', stored, 'a', 1]),
      );
      expect(await engine.query('filtered', {}, context)).toEqual([{ id: 'one' }]);
      expect(result.impact.targets.some(target => target.endpoint === 'filtered')).toBe(true);
      expect(await engine.query('nullValue', {}, context)).toEqual([]);
      await engine.command(context, tx => tx.execute('update records set status=null'));
      expect(await engine.query('nullValue', {}, context)).toEqual([]);
    } finally {
      database.close();
    }
  });
});
