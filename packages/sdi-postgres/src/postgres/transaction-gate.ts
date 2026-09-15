import type { Transaction } from './tracked-db.js';

export const transactionGateSchema = 'sdi_control';
export const transactionGateTable = 'transaction_gate';
export const transactionGateRelation = `"${transactionGateSchema}"."${transactionGateTable}"`;

function quoteIdentifier(value: string): string {
  if (!value || value.includes('\0')) throw new Error('INVALID_POSTGRES_ROLE');
  return `"${value.replaceAll('"', '""')}"`;
}

/** Install the stable lock target used by every transaction-pooled operation. */
export async function installPostgresTransactionGate(transaction: Transaction, runtimeRole?: string): Promise<void> {
  await transaction.unsafe(`create schema if not exists "${transactionGateSchema}"`);
  await transaction.unsafe(
    `create table if not exists ${transactionGateRelation}(singleton boolean primary key default true check(singleton))`,
  );
  const [shape] = await transaction.unsafe(
    `select c.relkind,(select array_agg(a.attname order by a.attnum) from pg_attribute a where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped) as columns from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname=$1 and c.relname=$2`,
    [transactionGateSchema, transactionGateTable],
  );
  if (shape?.relkind !== 'r' || JSON.stringify(shape.columns) !== JSON.stringify(['singleton']))
    throw new Error('POSTGRES_TRANSACTION_GATE_CONFLICT');
  if (runtimeRole) {
    const role = quoteIdentifier(runtimeRole);
    await transaction.unsafe(`grant usage on schema "${transactionGateSchema}" to ${role}`);
    await transaction.unsafe(`grant select on table ${transactionGateRelation} to ${role}`);
  }
}

export const transactionGateSharedLockSql = `lock table only ${transactionGateRelation} in access share mode`;
export const transactionGateExclusiveLockSql = `lock table only ${transactionGateRelation} in access exclusive mode`;
