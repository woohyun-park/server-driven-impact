import type { Transaction } from './tracked-db.js';

export const transactionGateSchema = 'sdi_control';
export const transactionGateTable = 'transaction_gate';
export const transactionGateRelation = `"${transactionGateSchema}"."${transactionGateTable}"`;
export const validationTable = 'validation';
export const validationRelation = `"${transactionGateSchema}"."${validationTable}"`;
export const catalogHashFunction = `"${transactionGateSchema}".catalog_hash`;
export const recordValidationFunction = `"${transactionGateSchema}".record_validation`;
const validationColumns = [
  'singleton',
  'fingerprint',
  'report',
  'equality_resources',
  'catalog_hash',
  'catalog_schemas',
  'validated_at',
];

function quoteIdentifier(value: string): string {
  if (!value || value.includes('\0')) throw new Error('INVALID_POSTGRES_ROLE');
  return `"${value.replaceAll('"', '""')}"`;
}

/** The stable lock target every transaction-pooled operation shares. */
export function transactionGateSql(runtimeRole?: string): string[] {
  const statements = [
    `create schema if not exists "${transactionGateSchema}"`,
    `create table if not exists ${transactionGateRelation}(singleton boolean primary key default true check(singleton))`,
  ];
  if (runtimeRole) {
    const role = quoteIdentifier(runtimeRole);
    statements.push(
      `grant usage on schema "${transactionGateSchema}" to ${role}`,
      `grant select on table ${transactionGateRelation} to ${role}`,
    );
  }
  return statements;
}

/**
 * xmin of every catalog row validation can depend on. DDL rewrites catalog rows, so any change moves the
 * hash; in-place statistics updates (VACUUM, ANALYZE) do not. Roles are hashed by content because the
 * runtime role cannot read pg_authid.
 */
const catalogHashBody = `
with ns as (select oid from pg_namespace where nspname = any(schemas)),
rels as (select oid from pg_class where relnamespace in (select oid from ns)),
items as (
  select 'n'||n.oid||':'||n.xmin as item from pg_namespace n where n.oid in (select oid from ns)
  union all select 'c'||c.oid||':'||c.xmin from pg_class c where c.oid in (select oid from rels)
  union all select 'a'||a.attrelid||'.'||a.attnum||':'||a.xmin from pg_attribute a where a.attrelid in (select oid from rels) and a.attnum > 0
  union all select 'p'||p.oid||':'||p.xmin from pg_proc p where p.pronamespace in (select oid from ns)
  union all select 't'||t.oid||':'||t.xmin from pg_type t where t.typnamespace in (select oid from ns)
  union all select 'o'||o.oid||':'||o.xmin from pg_operator o where o.oprnamespace in (select oid from ns)
  union all select 'l'||l.oid||':'||l.xmin from pg_collation l where l.collnamespace in (select oid from ns)
  union all select 'k'||k.oid||':'||k.xmin from pg_constraint k where k.connamespace in (select oid from ns) or k.conrelid in (select oid from rels)
  union all select 'r'||r.oid||':'||r.xmin from pg_rewrite r where r.ev_class in (select oid from rels)
  union all select 'y'||y.oid||':'||y.xmin from pg_policy y where y.polrelid in (select oid from rels)
  union all select 'g'||g.oid||':'||g.xmin from pg_trigger g where g.tgrelid in (select oid from rels)
  union all select 'i'||i.inhrelid||'.'||i.inhparent||':'||i.xmin from pg_inherits i where i.inhparent in (select oid from rels) or i.inhrelid in (select oid from rels)
  union all select 'x'||x.oid||':'||x.xmin from pg_cast x
  union all select 'e'||e.oid||':'||e.xmin from pg_extension e
  union all select 'm'||m.roleid||'.'||m.member||':'||m.xmin from pg_auth_members m
  union all select 's'||s.setdatabase||'.'||s.setrole||':'||s.xmin from pg_db_role_setting s
  union all select 'u'||md5(to_jsonb(u)::text) from pg_roles u
  union all select 'd'||current_setting('server_version_num')||':'||d.datcollate||':'||d.datctype from pg_database d where d.datname = current_database()
)
select md5(string_agg(item, ',' order by item)) from items`;

/**
 * The owner-written validation snapshot, its catalog hash, and the recorder. The snapshot is a cache of a
 * full validation, so an outdated table shape is recreated instead of migrated.
 */
export function validationControlSql(runtimeRole?: string): string[] {
  const statements = [
    `do $sdi$ begin
      if (select array_agg(a.attname::text order by a.attnum) from pg_attribute a
          join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = '${transactionGateSchema}' and c.relname = '${validationTable}' and a.attnum > 0 and not a.attisdropped)
        is distinct from array[${validationColumns.map(column => `'${column}'`).join(',')}]::text[]
      then drop table if exists ${validationRelation}; end if;
    end $sdi$`,
    `create table if not exists ${validationRelation}(singleton boolean primary key default true check(singleton),fingerprint text not null,report jsonb not null,equality_resources jsonb not null,catalog_hash text not null,catalog_schemas text[] not null,validated_at timestamptz not null)`,
    `create or replace function ${catalogHashFunction}(schemas text[]) returns text language sql stable set search_path = pg_catalog, pg_temp as $sdi$${catalogHashBody}$sdi$`,
    // Records a snapshot only when the catalog still has the hash taken before validation, so a
    // concurrent DDL can never pair a newer hash with an older report. One recorder at a time; the
    // others keep their live result instead of waiting on the row lock.
    `create or replace function ${recordValidationFunction}(p_fingerprint text, p_catalog_hash text, p_catalog_schemas text[], p_report jsonb, p_equality_resources jsonb)
    returns boolean language plpgsql security definer set search_path = pg_catalog, pg_temp as $sdi$
    begin
      if p_fingerprint !~ '^[a-f0-9]{64}$' or jsonb_typeof(p_report -> 'endpoints') is distinct from 'object'
        or jsonb_typeof(p_equality_resources) is distinct from 'array' then return false; end if;
      if not pg_try_advisory_xact_lock(${0x534449}, ${0x5641}) then return false; end if;
      if ${catalogHashFunction}(p_catalog_schemas) is distinct from p_catalog_hash then return false; end if;
      insert into ${validationRelation}(singleton,fingerprint,report,equality_resources,catalog_hash,catalog_schemas,validated_at)
        values(true,p_fingerprint,p_report,p_equality_resources,p_catalog_hash,p_catalog_schemas,clock_timestamp())
        on conflict(singleton) do update set fingerprint=excluded.fingerprint,report=excluded.report,
          equality_resources=excluded.equality_resources,catalog_hash=excluded.catalog_hash,
          catalog_schemas=excluded.catalog_schemas,validated_at=excluded.validated_at;
      return true;
    end $sdi$`,
    `revoke all on function ${recordValidationFunction}(text,text,text[],jsonb,jsonb) from public`,
  ];
  if (runtimeRole) {
    const role = quoteIdentifier(runtimeRole);
    // The runtime may record what its own live validation proved; it cannot edit the table directly.
    statements.push(
      `grant select on table ${validationRelation} to ${role}`,
      `grant execute on function ${recordValidationFunction}(text,text,text[],jsonb,jsonb) to ${role}`,
    );
  }
  return statements;
}

/** Install the stable lock target and the validation snapshot relations. */
export async function installPostgresTransactionGate(transaction: Transaction, runtimeRole?: string): Promise<void> {
  const [schema, gate, ...gateGrants] = transactionGateSql(runtimeRole);
  await transaction.unsafe(schema);
  await transaction.unsafe(gate);
  const [shape] = await transaction.unsafe(
    `select c.relkind,(select array_agg(a.attname order by a.attnum) from pg_attribute a where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped) as columns from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname=$1 and c.relname=$2`,
    [transactionGateSchema, transactionGateTable],
  );
  if (shape?.relkind !== 'r' || JSON.stringify(shape.columns) !== JSON.stringify(['singleton']))
    throw new Error('POSTGRES_TRANSACTION_GATE_CONFLICT');
  for (const statement of [...gateGrants, ...validationControlSql(runtimeRole)]) await transaction.unsafe(statement);
}

export const transactionGateSharedLockSql = `lock table only ${transactionGateRelation} in access share mode`;
export const transactionGateExclusiveLockSql = `lock table only ${transactionGateRelation} in access exclusive mode`;

/** Map missing, outdated or inaccessible control relations to stable setup errors; other failures pass through. */
export function controlSetupError(cause: unknown): unknown {
  const code = cause && typeof cause === 'object' && 'code' in cause ? String(cause.code) : '';
  const message = cause instanceof Error ? cause.message : '';
  if (code === '42P01' || code === '42883' || code === '42703')
    return new Error('POSTGRES_CONTROL_NOT_INITIALIZED', { cause });
  if (code === '42501' && /sdi_control|transaction_gate|validation/.test(message))
    return new Error('POSTGRES_CONTROL_ACCESS_DENIED', { cause });
  return cause;
}
