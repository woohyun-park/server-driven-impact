import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { compilePostgresQuery } from '../../packages/sdi-postgres/src/postgres/query-compiler.js';

const resources = {
  users: { schema: 'app', table: 'users', idColumn: 'id', scopeColumn: null, columns: ['id', 'status', 'role_id'] },
  roles: { schema: 'app', table: 'roles', idColumn: 'id', scopeColumn: null, columns: ['id', 'name'] },
} as const;

describe('PostgreSQL query compiler', () => {
  it('publishes a unique status for every PostgreSQL capability', () => {
    const ledger = JSON.parse(
      readFileSync(new URL('../../spec/server-driven-impact/postgres-capabilities.json', import.meta.url), 'utf8'),
    ) as { capabilities: { id: string; status: string; fixture?: string }[] };
    expect(new Set(ledger.capabilities.map(capability => capability.id)).size).toBe(ledger.capabilities.length);
    expect(
      ledger.capabilities.every(capability =>
        ['verified', 'verified-rejection', 'unsupported', 'planned'].includes(capability.status),
      ),
    ).toBe(true);
    for (const capability of ledger.capabilities)
      if (capability.fixture) {
        const [file, title] = capability.fixture.split('#');
        expect(readFileSync(new URL(file.replace(/^tests\//, ''), import.meta.url), 'utf8'), capability.id).toContain(
          title,
        );
      }
  });
  it('derives base relations and only equality bindings guaranteed by every branch', async () => {
    const plan = await compilePostgresQuery(
      {
        text: `select u.id,r.name from app.users u join app.roles r on r.id=u.role_id
        where u.id=$1 and (u.status=$2 or u.status=$3)`,
        parameters: ['id', 'firstStatus', 'secondStatus'],
      },
      resources,
      17,
    );
    expect(plan.reads).toEqual([
      { resource: 'users', columns: '*', bindings: [{ column: 'id', input: 'id' }] },
      { resource: 'roles', columns: '*', bindings: [] },
    ]);
  });
  it('expands CTE bodies without treating the CTE name as a table', async () => {
    const plan = await compilePostgresQuery(
      { text: 'with picked as (select * from app.users where id=$1) select * from picked', parameters: ['id'] },
      resources,
      14,
    );
    expect(plan.reads).toEqual([{ resource: 'users', columns: '*', bindings: [{ column: 'id', input: 'id' }] }]);
  });
  it('resolves a base table shadowed by its non-recursive CTE name', async () => {
    const plan = await compilePostgresQuery(
      { text: 'with users as (select * from users where id=$1) select * from users', parameters: ['id'] },
      resources,
      18,
    );
    expect(plan.reads).toEqual([{ resource: 'users', columns: '*', bindings: [{ column: 'id', input: 'id' }] }]);
  });
  it('fails closed for hidden or unregistered relations and invalid parameter maps', async () => {
    await expect(
      compilePostgresQuery({ text: 'select * from app.user_view', parameters: [] }, resources, 18),
    ).rejects.toThrow('UNRESOLVED_QUERY_RELATION');
    await expect(
      compilePostgresQuery({ text: 'select * from app.users where id=$2', parameters: ['id'] }, resources, 18),
    ).rejects.toThrow('POSTGRES_QUERY_PARAMETER_MISMATCH');
    await expect(
      compilePostgresQuery({ text: 'delete from app.users', parameters: [] }, resources, 18),
    ).rejects.toThrow('POSTGRES_QUERY_REQUIRES_SELECT');
    await expect(
      compilePostgresQuery({ text: 'select count(*) from app.users', parameters: [] }, resources, 18),
    ).rejects.toThrow('UNRESOLVED_QUERY_FUNCTION');
    await expect(
      compilePostgresQuery({ text: 'select current_timestamp from app.users', parameters: [] }, resources, 18),
    ).rejects.toThrow('POSTGRES_QUERY_REQUIRES_FRESHNESS_POLICY');
  });
  it('widens catalog-expanded view and function dependencies while preserving direct bindings', async () => {
    const catalog = {
      resources,
      resolveRelation: async () => ['users'],
      resolveFunction: async () => ['users'],
    };
    const view = await compilePostgresQuery(
      { text: 'select * from app.user_view where id=$1', parameters: ['id'] },
      resources,
      18,
      { catalog },
    );
    expect(view.reads).toEqual([{ resource: 'users', columns: '*', bindings: [] }]);
    const called = await compilePostgresQuery(
      { text: 'select app.visible_users($1)', parameters: ['id'] },
      resources,
      18,
      { catalog },
    );
    expect(called.reads).toEqual([{ resource: 'users', columns: '*', bindings: [] }]);
    const direct = await compilePostgresQuery(
      { text: 'select count(*) from app.users where id=$1', parameters: ['id'] },
      resources,
      18,
      { catalog: { ...catalog, resolveFunction: async () => [] } },
    );
    expect(direct.reads).toEqual([{ resource: 'users', columns: '*', bindings: [{ column: 'id', input: 'id' }] }]);
  });
  it('keeps self-join read paths as alternatives', async () => {
    const plan = await compilePostgresQuery(
      {
        text: 'select a.id,b.id from app.users a cross join app.users b where a.id=$1 and b.id=$2',
        parameters: ['left', 'right'],
      },
      resources,
      18,
    );
    expect(plan.reads).toEqual([
      { resource: 'users', columns: '*', bindings: [{ column: 'id', input: 'left' }] },
      { resource: 'users', columns: '*', bindings: [{ column: 'id', input: 'right' }] },
    ]);
  });
  it('widens cast parameters until an input codec proves round-trip equality', async () => {
    const plan = await compilePostgresQuery(
      { text: 'select * from app.users where id=$1::text', parameters: ['id'] },
      resources,
      18,
    );
    expect(plan.reads).toEqual([{ resource: 'users', columns: '*', bindings: [] }]);
  });
});

describe('PostgreSQL observed-column precision', () => {
  const catalog = {
    resources,
    resolveRelation: async (reference: { name: string }) => [reference.name],
    resolveFunction: async () => [],
    canPruneColumns: () => true,
  };
  it('includes projection, filter, join, grouping, having and ordering columns', async () => {
    const plan = await compilePostgresQuery(
      {
        text: 'select u.status,r.name,count(*) from app.users u join app.roles r on r.id=u.role_id where u.id=$1 group by u.status,r.name having count(u.role_id)>0 order by u.status limit 2 offset 1',
        parameters: ['id'],
      },
      resources,
      18,
      { catalog },
    );
    expect(plan.reads).toEqual([
      { resource: 'users', columns: ['id', 'role_id', 'status'], bindings: [{ column: 'id', input: 'id' }] },
      { resource: 'roles', columns: ['id', 'name'], bindings: [] },
    ]);
  });
  it('treats count(*) as row membership without depending on unrelated column updates', async () => {
    const plan = await compilePostgresQuery(
      { text: 'select count(*) from app.users where status=$1', parameters: ['status'] },
      resources,
      18,
      { catalog },
    );
    expect(plan.reads).toEqual([
      { resource: 'users', columns: ['status'], bindings: [{ column: 'status', input: 'status' }] },
    ]);
  });
  it.each([
    'select u.* from app.users u',
    'select u from app.users u',
    'select u.id from app.users u join app.roles r using(id)',
    'select u.id from app.users u natural join app.roles r',
    'select u.id from app.users u where exists(select 1 from app.roles r where r.id=u.role_id)',
  ])('widens implicit, whole-row or correlated columns: %s', async text => {
    const plan = await compilePostgresQuery({ text }, resources, 18, { catalog });
    expect(plan.reads.every(read => read.columns === '*')).toBe(true);
  });
  it('requires a catalog proof and retains broad hidden function dependencies', async () => {
    const text = 'select id from app.users';
    const withoutProof = {
      resources,
      resolveRelation: catalog.resolveRelation,
      resolveFunction: catalog.resolveFunction,
    };
    expect((await compilePostgresQuery({ text }, resources, 18, { catalog: withoutProof })).reads[0].columns).toBe('*');
    expect(
      (await compilePostgresQuery({ text }, resources, 18, { catalog: { ...catalog, canPruneColumns: () => false } }))
        .reads[0].columns,
    ).toBe('*');
    const hidden = await compilePostgresQuery(
      { text: 'select app.visible_users(u.id) from app.users u' },
      resources,
      18,
      { catalog: { ...catalog, resolveFunction: async () => ['users'] } },
    );
    expect(hidden.reads).toEqual([{ resource: 'users', columns: '*', bindings: [] }]);
  });
  it('keeps distinct column dependencies for self-join read alternatives', async () => {
    const plan = await compilePostgresQuery(
      {
        text: 'select a.status,b.role_id from app.users a cross join app.users b where a.id=$1 and b.id=$2',
        parameters: ['left', 'right'],
      },
      resources,
      18,
      { catalog },
    );
    expect(plan.reads).toEqual([
      { resource: 'users', columns: ['id', 'status'], bindings: [{ column: 'id', input: 'left' }] },
      { resource: 'users', columns: ['id', 'role_id'], bindings: [{ column: 'id', input: 'right' }] },
    ]);
  });
});
