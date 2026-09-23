import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { Pool } from 'pg';
import {
  generateObserverMigration,
  installPostgresTransactionGate,
  observerFingerprint,
  postgresAdapter,
  type PostgresOptions,
} from '@server-driven-impact/postgres';
import { pgAdapter } from '@server-driven-impact/postgres/pg';
import { bindAdapter, type QueryManifest } from '@server-driven-impact/runtime/adapter';
import type { PostgresQueryPlan } from '@server-driven-impact/runtime';
import { WriteSet } from '@server-driven-impact/core';

const adminUrl = process.env.SDI_POSTGRES_ADMIN_URL;
const transactionUrl = process.env.SDI_POSTGRES_TRANSACTION_URL;
const enabled = !!adminUrl && !!transactionUrl;
if (process.env.SDI_POSTGRES_TRANSACTION_REQUIRED === '1' && !enabled)
  throw new Error('POSTGRES_TRANSACTION_POOL_FIXTURE_REQUIRED');

const resources = {
  probe: { schema: 'public', table: 'sdi_pool_probe', idColumn: 'id', scopeColumn: null, columns: ['id'] },
} as const;
const manifest: QueryManifest = {
  reads: { probe: [{ resource: 'probe', columns: '*', bindings: [] }] },
};
const plan: PostgresQueryPlan = {
  kind: 'postgres-query',
  text: "select pg_backend_pid() as pid,current_user as role,current_setting('sdi.pool_probe',true) as claim,current_setting('sdi.request_token',true) as token,current_setting('sdi.observation_phase',true) as phase",
  parameters: [],
  reads: [],
};

describe.skipIf(!enabled)('PostgreSQL transaction pool', () => {
  const admin = enabled ? postgres(adminUrl!, { max: 2, prepare: false, onnotice: () => {} }) : undefined!;

  beforeAll(async () => {
    await admin.unsafe('create role routine_runtime nologin nobypassrls').catch(error => {
      if ((error as { code?: string }).code !== '42710') throw error;
    });
    await admin.unsafe('create table if not exists public.sdi_pool_probe(id text primary key)');
    await admin.unsafe('grant select,insert,update,delete on public.sdi_pool_probe to routine_runtime');
    await admin.begin(transaction => installPostgresTransactionGate(transaction, 'routine_runtime'));
    await admin.unsafe(generateObserverMigration(resources, manifest, { runtimeRole: 'routine_runtime' }));
  });

  afterAll(async () => {
    await admin?.end();
  });

  it('runs concurrent Query and Command transactions without leaking local state', async () => {
    const backendPids = new Set<number>();
    const latencies: number[] = [];
    const clients: Array<{
      close(): Promise<void>;
      query(): Promise<void>;
      command(): Promise<void>;
      validate(): Promise<import('@server-driven-impact/core').ValidationReport>;
    }> = [];
    const clientCount = Number(process.env.SDI_POSTGRES_TRANSACTION_CLIENTS ?? 30);
    for (let index = 0; index < clientCount; index++) {
      if (process.env.SDI_POSTGRES_DRIVER === 'pg') {
        const pool = new Pool({ connectionString: transactionUrl, max: 1 });
        const engine = pgAdapter({
          database: pool,
          setup: async tx => {
            const [state] = await tx.unsafe(
              "select current_user as role,current_setting('sdi.pool_probe',true) as claim",
            );
            if (state.claim || state.role !== 'postgres') throw new Error('POSTGRES_TRANSACTION_SESSION_STATE_LEAK');
            await tx.unsafe('set local role routine_runtime');
            await tx.unsafe("select set_config('sdi.pool_probe',$1,true)", [`probe-${index}`]);
          },
        })[bindAdapter](resources, manifest);
        clients.push({
          close: () => pool.end(),
          validate: () => engine.validate(),
          query: async () => {
            const started = performance.now();
            const result = await engine.query(`scope-${index}`, async select => [
              await select(plan, {}),
              await select(plan, {}),
            ]);
            const rows = result.flat() as Array<{
              pid: number;
              role: string;
              claim: string;
              token: string;
              phase: string;
            }>;
            expect(new Set(rows.map(row => row.pid)).size).toBe(1);
            expect(rows.every(row => row.role === 'routine_runtime' && row.claim === `probe-${index}`)).toBe(true);
            expect(rows.every(row => !row.token && !row.phase)).toBe(true);
            rows.forEach(row => {
              backendPids.add(row.pid);
            });
            latencies.push(performance.now() - started);
          },
          command: async () => {
            const started = performance.now();
            await engine.command(`scope-${index}`, new WriteSet(new Set(['probe'])), async db => {
              const current = await db.query<{ pid: number }>('select pg_backend_pid() as pid');
              backendPids.add(current.rows[0].pid);
              await db.query(
                'insert into public.sdi_pool_probe(id) values($1) on conflict(id) do update set id=excluded.id',
                [`probe-${index}`],
              );
            });
            latencies.push(performance.now() - started);
          },
        });
      } else {
        const database = postgres(transactionUrl!, { max: 1, prepare: false, onnotice: () => {} });
        const options: PostgresOptions = {
          database,
          setup: async tx => {
            const [state] = await tx.unsafe(
              "select current_user as role,current_setting('sdi.pool_probe',true) as claim",
            );
            if (state.claim || state.role !== 'postgres') throw new Error('POSTGRES_TRANSACTION_SESSION_STATE_LEAK');
            await tx.unsafe('set local role routine_runtime');
            await tx.unsafe("select set_config('sdi.pool_probe',$1,true)", [`probe-${index}`]);
          },
        };
        const engine = postgresAdapter(options)[bindAdapter](resources, manifest);
        clients.push({
          close: () => database.end(),
          validate: () => engine.validate(),
          query: async () => {
            const started = performance.now();
            const result = await engine.query(`scope-${index}`, async select => [
              await select(plan, {}),
              await select(plan, {}),
            ]);
            const rows = result.flat() as Array<{
              pid: number;
              role: string;
              claim: string;
              token: string;
              phase: string;
            }>;
            expect(new Set(rows.map(row => row.pid)).size).toBe(1);
            expect(rows.every(row => row.role === 'routine_runtime' && row.claim === `probe-${index}`)).toBe(true);
            expect(rows.every(row => !row.token && !row.phase)).toBe(true);
            rows.forEach(row => {
              backendPids.add(row.pid);
            });
            latencies.push(performance.now() - started);
          },
          command: async () => {
            const started = performance.now();
            await engine.command(`scope-${index}`, new WriteSet(new Set(['probe'])), async db => {
              const [current] = await db.unsafe('select pg_backend_pid() as pid');
              backendPids.add(Number(current.pid));
              await db.unsafe(
                'insert into public.sdi_pool_probe(id) values($1) on conflict(id) do update set id=excluded.id',
                [`probe-${index}`],
              );
            });
            latencies.push(performance.now() - started);
          },
        });
      }
    }
    try {
      await Promise.all(clients.map(client => client.validate()));
      for (const operations of [
        clients.flatMap(client => [client.query(), client.command()]),
        clients.flatMap(client => [client.command(), client.query()]),
      ]) {
        const results = await Promise.allSettled(operations);
        const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
        if (failed) throw failed.reason;
      }
      const [locks] = await admin.unsafe(
        "select count(*)::int as count from pg_locks where locktype='advisory' and classid=$1 and objid=$2",
        [0x534449, 0x5047],
      );
      expect(locks.count).toBe(0);
      expect(backendPids.size).toBeLessThanOrEqual(5);
      if (clientCount > 5) expect(backendPids.size).toBeGreaterThan(1);
      expect(latencies).toHaveLength(clientCount * 4);
      const p95Ms = [...latencies].sort((a, b) => a - b)[Math.ceil(latencies.length * 0.95) - 1];
      expect(p95Ms).toBeGreaterThanOrEqual(0);
      process.stdout.write(
        `${JSON.stringify({ driver: process.env.SDI_POSTGRES_DRIVER ?? 'postgres', clients: clientCount, backendPids: backendPids.size, p95Ms })}\n`,
      );
      expect(observerFingerprint(resources, manifest)).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      await Promise.all(clients.map(client => client.close()));
    }
  }, 90_000);
});
