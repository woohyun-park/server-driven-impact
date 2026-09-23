import { expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import Ajv from 'ajv/dist/2020.js';
import { DatabaseSync } from 'node:sqlite';
import {
  createImpact as createCore,
  applyAssessment,
  validationReport,
  mergeAssessment,
  LIMITS,
  byteLength,
  type EndpointImpact,
  type ImpactManifest,
  type WriteFact,
} from '@server-driven-impact/core';
import { createImpact, q } from '@server-driven-impact/runtime';
import { sqliteAdapter } from '@server-driven-impact/sqlite';

const resources = { r: { columns: ['id', 'value'], scopeColumn: null } };
const manifest: ImpactManifest = {
  reads: {
    detail: [{ resource: 'r', columns: '*', bindings: [{ column: 'id', input: 'id' }] }],
    all: [{ resource: 'r', columns: '*', bindings: [] }],
    independent: [],
  },
};
const insert = (id: string): WriteFact => ({
  resource: 'r',
  operation: 'insert',
  before: { kind: 'absent' },
  after: { kind: 'known', scope: null, fields: { id } },
  changedColumns: null,
});

it('distinguishes verified no impact, naturally broad impact, and precision loss', () => {
  const core = createCore({ resources, manifest });
  expect(core.calculate([], null).endpoints.detail).toEqual({ status: 'verified', targets: [] });
  const precise = core.calculate([insert('a')], null);
  expect(precise.endpoints.all).toEqual({
    status: 'verified',
    targets: [{ scope: 'global', selector: { kind: 'all' } }],
  });
  expect(precise.endpoints.independent).toEqual({ status: 'verified', targets: [] });
  expect(core.calculate([{ ...insert('a'), after: { kind: 'unknown' } }], null).endpoints.detail).toEqual({
    status: 'conservative',
    codes: ['PRECISION_REDUCED'],
    targets: [{ scope: 'global', selector: { kind: 'all' } }],
  });
  expect(
    core.calculate(
      Array.from({ length: LIMITS.selectors + 1 }, (_, index) => insert(String(index))),
      null,
    ).endpoints.detail,
  ).toMatchObject({ status: 'conservative', codes: ['PRECISION_REDUCED'] });
});

it('unions sorted codes, gives unavailability precedence and removes intermediate targets', () => {
  expect(
    mergeAssessment(
      { status: 'unavailable', codes: ['OBSERVATION_FAILED', 'VALIDATION_FAILED'] },
      { status: 'conservative', codes: ['VALIDATION_FAILED', 'PRECISION_REDUCED'] },
    ),
  ).toEqual({ status: 'unavailable', codes: ['OBSERVATION_FAILED', 'PRECISION_REDUCED', 'VALIDATION_FAILED'] });
  const impact = createCore({ resources, manifest }).calculate([{ ...insert('a'), after: { kind: 'unknown' } }], null);
  const report = validationReport(manifest);
  report.endpoints.detail = { status: 'unavailable', codes: ['OBSERVER_UNVERIFIED'] };
  expect(applyAssessment(impact, report).endpoints.detail).toEqual({
    status: 'unavailable',
    codes: ['OBSERVER_UNVERIFIED', 'PRECISION_REDUCED'],
  });
  expect(impact.endpoints.all.status).toBe('conservative');
  const unavailable: EndpointImpact = { status: 'unavailable', codes: ['CALCULATION_FAILED'] };
  const typeCheck = () => {
    // @ts-expect-error Unavailable targets cannot be iterated without narrowing status.
    unavailable.targets.map(() => undefined);
  };
  void typeCheck;
  // @ts-expect-error Unavailable entries cannot carry partial targets.
  const invalid: EndpointImpact = { status: 'unavailable', codes: ['CALCULATION_FAILED'], targets: [] };
  void invalid;
});

it('budgets the entire endpoint envelope and marks byte widening conservative', () => {
  const core = createCore({ resources, manifest });
  const impact = core.calculate([insert('a'.repeat(LIMITS.impactBytes))], null);
  expect(byteLength(impact)).toBeLessThanOrEqual(LIMITS.impactBytes);
  expect(impact.endpoints.detail).toEqual({
    status: 'conservative',
    codes: ['PRECISION_REDUCED'],
    targets: [{ scope: 'global', selector: { kind: 'all' } }],
  });
  const oversized = {
    reads: Object.fromEntries(
      Array.from({ length: LIMITS.endpoints }, (_, index) => [String(index) + '界'.repeat(120), []]),
    ),
  };
  expect(() => createCore({ resources, manifest: oversized })).toThrow('MANIFEST_TARGET_BUDGET');
});

it('disables filters, bindings and column exclusions for conservative validation', () => {
  const core = createCore({ resources, manifest });
  const report = validationReport(manifest);
  report.endpoints.detail = { status: 'conservative', codes: ['PRECISION_REDUCED'] };
  expect(applyAssessment(core.calculate([insert('one')], null, report), report).endpoints.detail).toEqual({
    status: 'conservative',
    codes: ['PRECISION_REDUCED'],
    targets: [{ scope: 'global', selector: { kind: 'all' } }],
  });
});

it('SQLite caches failed reports, isolates resource drift, and recovers only on explicit validation', async () => {
  const database = new DatabaseSync(':memory:');
  database.exec(
    'pragma foreign_keys=on; create table first(id text primary key, value text); create table second(id text primary key)',
  );
  const engine = createImpact({
    adapter: sqliteAdapter({ database }),
    resources: {
      first: { table: 'first', idColumn: 'id', scopeColumn: null, columns: ['id'] },
      second: { table: 'second', idColumn: 'id', scopeColumn: null, columns: ['id'] },
    },
    queries: {
      first: { input: { parse: () => ({}) }, plan: q.select('first') },
      second: { input: { parse: () => ({}) }, plan: q.select('second') },
    },
  });
  try {
    const first = await engine.command({ scope: null }, db => db.execute("insert into second values ('a')"));
    expect(first.commitState).toBe('committed');
    expect(first.impact.endpoints.first).toEqual({ status: 'unavailable', codes: ['RESOURCE_DRIFT'] });
    expect(first.impact.endpoints.second.status).toBe('verified');
    database.exec('alter table first drop column value');
    const cached = await engine.command({ scope: null }, async () => 'saved');
    expect(cached.impact.endpoints.first.status).toBe('unavailable');
    const report = await engine.validate();
    report.endpoints.first = { status: 'unavailable', codes: ['VALIDATION_FAILED'] };
    expect((await engine.command({ scope: null }, async () => 'saved')).impact.endpoints.first).toEqual({
      status: 'verified',
      targets: [],
    });
  } finally {
    database.close();
  }
});

it('the protocol schema rejects targets on unavailable endpoints', () => {
  const validate = new Ajv.default({ strict: true, allowUnionTypes: true }).compile(
    JSON.parse(
      readFileSync(new URL('../../spec/server-driven-impact/schemas/impact-set.schema.json', import.meta.url), 'utf8'),
    ),
  );
  expect(validate({ endpoints: { list: { status: 'unavailable', codes: ['OBSERVATION_FAILED'] } } })).toBe(true);
  expect(validate({ protocolVersion: 2, endpoints: { list: { status: 'verified', targets: [] } } })).toBe(false);
  expect(
    validate({
      endpoints: { list: { status: 'unavailable', codes: ['OBSERVATION_FAILED'], targets: [] } },
    }),
  ).toBe(false);
});

it('the manifest schema accepts unversioned reads and rejects an obsolete version field', () => {
  const validate = new Ajv.default({ strict: true, allowUnionTypes: true }).compile(
    JSON.parse(
      readFileSync(
        new URL('../../spec/server-driven-impact/schemas/query-manifest.schema.json', import.meta.url),
        'utf8',
      ),
    ),
  );
  expect(validate(manifest)).toBe(true);
  expect(validate({ ...manifest, protocolVersion: 1 })).toBe(false);
});

it('SQLite rolls back collection SQL errors before commit', async () => {
  const database = new DatabaseSync(':memory:');
  database.exec('pragma foreign_keys=on; create table records(id text primary key)');
  const engine = createImpact({
    adapter: sqliteAdapter({ database }),
    resources: { records: { table: 'records', idColumn: 'id', scopeColumn: null, columns: ['id'] } },
    queries: { records: { input: { parse: () => ({}) }, plan: q.select('records') } },
  });
  await engine.validate();
  const prepare = database.prepare.bind(database);
  const spy = vi.spyOn(database, 'prepare').mockImplementation(text => {
    if (text.startsWith('select resource from')) throw new Error('collection failed');
    return prepare(text);
  });
  try {
    await expect(
      engine.command({ scope: null }, db => db.execute("insert into records values ('rollback')")),
    ).rejects.toThrow('collection failed');
    expect(prepare('select * from records').all()).toEqual([]);
  } finally {
    spy.mockRestore();
    database.close();
  }
});

it('SQLite preserves committed data when a collected row cannot be converted', async () => {
  const database = new DatabaseSync(':memory:');
  database.exec('pragma foreign_keys=on; create table records(id text primary key)');
  const engine = createImpact({
    adapter: sqliteAdapter({ database }),
    resources: { records: { table: 'records', idColumn: 'id', scopeColumn: null, columns: ['id'] } },
    queries: { records: { input: { parse: () => ({}) }, plan: q.select('records') } },
  });
  await engine.validate();
  const prepare = database.prepare.bind(database);
  const spy = vi.spyOn(database, 'prepare').mockImplementation(text => {
    if (text.startsWith('select resource,operation')) return { all: () => [null] } as never;
    return prepare(text);
  });
  const data = { saved: true };
  const work = vi.fn(async (db: import('@server-driven-impact/sqlite').SqliteCommandDb) => {
    await db.execute("insert into records values ('saved')");
    return data;
  });
  try {
    const result = await engine.command({ scope: null }, work);
    expect(result.data).toBe(data);
    expect(result.commitState).toBe('committed');
    expect(result.impact.endpoints.records).toEqual({ status: 'unavailable', codes: ['OBSERVATION_FAILED'] });
    expect(prepare('select * from records').all()).toEqual([{ id: 'saved' }]);
    expect(work).toHaveBeenCalledOnce();
  } finally {
    spy.mockRestore();
    database.close();
  }
});

it('SQLite attempts writes even when a missing registered table prevents observer installation', async () => {
  const database = new DatabaseSync(':memory:');
  database.exec('pragma foreign_keys=on; create table present(id text primary key)');
  const engine = createImpact({
    adapter: sqliteAdapter({ database }),
    resources: {
      missing: { table: 'missing', idColumn: 'id', scopeColumn: null, columns: ['id'] },
      present: { table: 'present', idColumn: 'id', scopeColumn: null, columns: ['id'] },
    },
    queries: { present: { input: { parse: () => ({}) }, plan: q.select('present') } },
  });
  try {
    const result = await engine.command({ scope: null }, db => db.execute("insert into present values ('saved')"));
    expect(result.commitState).toBe('committed');
    expect(result.impact.endpoints.present.status).toBe('unavailable');
    expect(database.prepare('select * from present').all()).toEqual([{ id: 'saved' }]);
    await expect(
      engine.command({ scope: null }, db => db.execute("insert into missing values ('failed')")),
    ).rejects.toThrow('no such table');
  } finally {
    database.close();
  }
});
