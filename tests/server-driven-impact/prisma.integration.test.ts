import { affectedTargets } from './impact-assertions.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import type { SqlDriverAdapterFactory } from '@prisma/driver-adapter-utils';
import { createImpact, defineQueries, compileManifest, q } from '@server-driven-impact/runtime';
import { generateObserverMigration } from '@server-driven-impact/postgres';
import { prismaAdapter } from '@server-driven-impact/postgres/prisma';
import { matchesInputSelector, type ImpactSet } from '@server-driven-impact/core';

interface Effect {
  id: number;
  value: string;
  children?: { id: number; effectId: number }[];
}
interface Client {
  $disconnect(): Promise<void>;
  $queryRawUnsafe<T = unknown[]>(query: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
  $transaction<T>(
    work: (client: Client) => Promise<T>,
    options?: { isolationLevel?: string; timeout?: number },
  ): Promise<T>;
  effect: {
    create(args: unknown): Promise<Effect>;
    findMany(args?: unknown): Promise<Effect[]>;
    delete(args: unknown): Promise<Effect>;
  };
}
const adminUrl = process.env.SDI_POSTGRES_ADMIN_URL;
const runtimeUrl = process.env.SDI_POSTGRES_RUNTIME_URL;
const enabled = !!adminUrl && !!runtimeUrl;
if (process.env.SDI_POSTGRES_REQUIRED === '1' && !enabled) throw new Error('POSTGRES_FIXTURES_REQUIRED');
for (const url of [adminUrl, runtimeUrl])
  if (url && !['127.0.0.1', 'localhost', '::1'].includes(new URL(url).hostname)) throw new Error('LOCAL_FIXTURES_ONLY');

describe.skipIf(!enabled)('Prisma 7.10 native observer conformance', () => {
  const schema = `sdi_prisma_${randomUUID().replaceAll('-', '')}`;
  const admin = enabled ? new Pool({ connectionString: adminUrl, max: 1 }) : undefined!;
  const pool = enabled ? new Pool({ connectionString: runtimeUrl, max: 4 }) : undefined!;
  let fixtureDirectory: string | undefined;
  let PrismaClient: new (options: { adapter: SqlDriverAdapterFactory }) => Client;
  const resources = {
    effects: { schema, table: 'sdi_prisma_effect', idColumn: 'id', scopeColumn: null, columns: ['id', 'value'] },
    children: { schema, table: 'sdi_prisma_child', idColumn: 'id', scopeColumn: null, columns: ['id', 'effectId'] },
    audits: { schema, table: 'sdi_prisma_audit', idColumn: 'id', scopeColumn: null, columns: ['id'] },
  } as const;
  const input = { parse: (value: unknown) => value as { id: number } };
  const queries = defineQueries({
    effect: { input, plan: q.select('effects', { where: [q.eq('id', q.input('id'))] }) },
    child: { input, plan: q.select('children', { where: [q.eq('effectId', q.input('id'))] }) },
    audit: { input, plan: q.select('audits', { where: [q.eq('id', q.input('id'))] }) },
  });
  const engine = enabled
    ? createImpact({
        resources,
        queries,
        adapter: prismaAdapter({ database: pool, schema, createClient: adapter => new PrismaClient({ adapter }) }),
      })
    : undefined!;
  const included = (impact: ImpactSet, endpoint: string, id: number) =>
    affectedTargets(impact).some(
      target => target.endpoint === endpoint && matchesInputSelector({ id }, target.selector),
    );
  const run = (work: (client: Client) => Promise<unknown>) => engine.command({ scope: 'test' }, work);

  beforeAll(async () => {
    mkdirSync(resolve('.local'), { recursive: true });
    fixtureDirectory = mkdtempSync(resolve('.local/prisma-fixture-'));
    writeFileSync(
      resolve(fixtureDirectory, 'schema.prisma'),
      readFileSync('scripts/experiments/prisma-transaction/schema.prisma'),
    );
    execFileSync(
      process.execPath,
      ['node_modules/prisma/build/index.js', 'generate', '--schema', resolve(fixtureDirectory, 'schema.prisma')],
      { stdio: 'pipe' },
    );
    PrismaClient = (await import(pathToFileURL(resolve(fixtureDirectory, 'generated/index.js')).href)).PrismaClient;
    await admin.query(`CREATE SCHEMA "${schema}";
      CREATE TABLE "${schema}".sdi_prisma_effect(id int PRIMARY KEY, value text NOT NULL);
      CREATE TABLE "${schema}".sdi_prisma_child(id int PRIMARY KEY, "effectId" int NOT NULL REFERENCES "${schema}".sdi_prisma_effect(id) ON DELETE CASCADE);
      CREATE TABLE "${schema}".sdi_prisma_audit(id int PRIMARY KEY REFERENCES "${schema}".sdi_prisma_effect(id) DEFERRABLE INITIALLY DEFERRED);
      CREATE FUNCTION "${schema}".deferred_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN INSERT INTO "${schema}".sdi_prisma_audit VALUES(NEW.id); RETURN NEW; END $$;
      CREATE CONSTRAINT TRIGGER deferred_audit AFTER INSERT ON "${schema}".sdi_prisma_effect DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "${schema}".deferred_audit();
      GRANT USAGE ON SCHEMA "${schema}" TO routine_runtime;
      GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA "${schema}" TO routine_runtime;`);
    await admin.query(
      generateObserverMigration(resources, compileManifest(queries, resources), { runtimeRole: 'routine_runtime' }),
    );
    await engine.validate();
  });
  afterAll(async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
    if (fixtureDirectory) rmSync(fixtureDirectory, { recursive: true, force: true });
  });

  it('collects nested model writes and deferred commit effects with precise inputs', async () => {
    const result = await run(async client => {
      const before = await client.$queryRawUnsafe<{ pid: number }[]>('SELECT pg_backend_pid() AS pid');
      const effect = await client.effect.create({
        data: { id: 1, value: 'first', children: { create: { id: 101 } } },
        include: { children: true },
      });
      expect(await client.$queryRawUnsafe(`SELECT * FROM "${schema}".sdi_prisma_audit WHERE id=1`)).toEqual([]);
      const after = await client.$queryRawUnsafe<{ pid: number }[]>('SELECT pg_backend_pid() AS pid');
      expect(after).toEqual(before);
      return effect;
    });
    expect(result.data).toMatchObject({ id: 1, value: 'first', children: [{ id: 101, effectId: 1 }] });
    for (const endpoint of ['effect', 'child', 'audit']) {
      expect(included(result.impact, endpoint, 1)).toBe(true);
      expect(included(result.impact, endpoint, 99)).toBe(false);
    }
    expect(JSON.stringify(result)).not.toContain('writeSet');
  });

  it('rolls back a rejected nested write while keeping a later successful write', async () => {
    const result = await run(async client => {
      await expect(
        client.effect.create({ data: { id: 2, value: 'cancel', children: { create: { id: 101 } } } }),
      ).rejects.toThrow();
      return client.effect.create({ data: { id: 3, value: 'keep' } });
    });
    expect(included(result.impact, 'effect', 2)).toBe(false);
    expect(included(result.impact, 'audit', 2)).toBe(false);
    expect(included(result.impact, 'effect', 3)).toBe(true);
    expect(included(result.impact, 'audit', 3)).toBe(true);
    expect((await admin.query(`SELECT id FROM "${schema}".sdi_prisma_effect WHERE id=2`)).rows).toEqual([]);
  });

  it('maps interactive Prisma transactions to guarded savepoints and rejects child isolation changes', async () => {
    const result = await run(async client => {
      await expect(
        client.$transaction(async tx => {
          await tx.effect.create({ data: { id: 4, value: 'cancel' } });
          throw new Error('cancel');
        }),
      ).rejects.toThrow('cancel');
      await expect(client.$transaction(async () => 1, { isolationLevel: 'Serializable' })).rejects.toThrow(
        'PRISMA_NESTED_ISOLATION_UNSUPPORTED',
      );
      return client.$transaction(tx => tx.effect.create({ data: { id: 5, value: 'keep' } }));
    });
    expect(included(result.impact, 'effect', 4)).toBe(false);
    expect(included(result.impact, 'audit', 5)).toBe(true);
  });

  it('rejects outer rollback, deferred commit failure, and late lazy execution', async () => {
    let captured!: Client;
    let lazy!: Promise<Effect[]>;
    await expect(
      run(async client => {
        captured = client;
        lazy = client.effect.findMany();
        await client.effect.create({ data: { id: 6, value: 'rollback' } });
        throw new Error('outer rollback');
      }),
    ).rejects.toThrow('outer rollback');
    await expect(captured.effect.findMany()).rejects.toThrow('WRITE_CONTEXT_CLOSED');
    await expect(lazy).rejects.toThrow('WRITE_CONTEXT_CLOSED');
    await expect(
      run(client => client.$executeRawUnsafe(`INSERT INTO "${schema}".sdi_prisma_audit VALUES(999)`)),
    ).rejects.toMatchObject({ code: '23503' });
    expect((await admin.query(`SELECT id FROM "${schema}".sdi_prisma_effect WHERE id=6`)).rows).toEqual([]);
  });

  it('isolates concurrent commands and observes native cascading writes', async () => {
    const results = await Promise.all(
      [7, 8].map(id =>
        run(client =>
          client.effect.create({ data: { id, value: 'parallel', children: { create: { id: id + 100 } } } }),
        ),
      ),
    );
    for (let index = 0; index < results.length; index++) {
      expect(included(results[index].impact, 'effect', index + 7)).toBe(true);
      expect(included(results[index].impact, 'effect', 8 - index)).toBe(false);
    }
    // Delete the audit first because its deferred FK intentionally has no cascade.
    const result = await run(async client => {
      await client.$executeRawUnsafe(`DELETE FROM "${schema}".sdi_prisma_audit WHERE id=7`);
      return client.effect.delete({ where: { id: 7 } });
    });
    expect(included(result.impact, 'child', 7)).toBe(true);
    expect(included(result.impact, 'child', 8)).toBe(false);
  });

  it('settles an unawaited interactive transaction before rejecting the command', async () => {
    let entered!: () => void;
    let release!: () => void;
    const active = new Promise<void>(resolve => {
      entered = resolve;
    });
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    let transaction!: Promise<unknown>;
    await expect(
      run(async client => {
        transaction = client.$transaction(async tx => {
          await tx.effect.create({ data: { id: 9, value: 'unawaited' } });
          entered();
          await gate;
          return 9;
        });
        void transaction.catch(() => {});
        await active;
      }),
    ).rejects.toThrow('UNAWAITED_DATABASE_OPERATION');
    release();
    await expect(transaction).rejects.toThrow();
    expect((await admin.query(`SELECT id FROM "${schema}".sdi_prisma_effect WHERE id=9`)).rows).toEqual([]);
    expect(await run(client => client.effect.create({ data: { id: 10, value: 'next command' } }))).toHaveProperty(
      'impact',
    );
  });

  it('rolls back a timed out Prisma savepoint before continuing the command', async () => {
    const result = await run(async client => {
      await expect(
        client.$transaction(
          async tx => {
            await tx.effect.create({ data: { id: 11, value: 'timeout' } });
            await new Promise(resolve => setTimeout(resolve, 60));
            return tx.effect.findMany();
          },
          { timeout: 30 },
        ),
      ).rejects.toThrow();
      return client.effect.create({ data: { id: 12, value: 'retained' } });
    });
    expect(included(result.impact, 'effect', 11)).toBe(false);
    expect(included(result.impact, 'effect', 12)).toBe(true);
  });
});
