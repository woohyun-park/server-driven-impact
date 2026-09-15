import { createHash } from 'node:crypto';
import { canonical } from '@server-driven-impact/core';
import type { Transaction } from './tracked-db.js';

export interface CatalogStamp {
  schemas: readonly string[];
  fingerprint: string;
}

/** Catalog definitions only: never reads application rows or sequence values. */
export async function catalogFingerprint(database: Transaction, schemas: readonly string[]): Promise<string> {
  const rows = await database.unsafe(
    `
    with namespaces as (select oid from pg_namespace where nspname=any($1::text[])),
    objects as (
      select 'relation' as kind,c.oid::text as id,jsonb_build_object('name',c.relname,'namespace',c.relnamespace,'owner',c.relowner,
        'kind',c.relkind,'rls',c.relrowsecurity,'forceRls',c.relforcerowsecurity,'acl',c.relacl,'options',c.reloptions,'partition',c.relpartbound::text) as definition
        from pg_class c where c.relnamespace in (select oid from namespaces)
      union all select 'column',a.attrelid::text||':'||a.attnum,to_jsonb(a) from pg_attribute a join pg_class c on c.oid=a.attrelid where c.relnamespace in (select oid from namespaces) and a.attnum>0
      union all select 'function',p.oid::text,to_jsonb(p) from pg_proc p where p.pronamespace in (select oid from namespaces)
      union all select 'type',t.oid::text,to_jsonb(t) from pg_type t where t.typnamespace in (select oid from namespaces)
      union all select 'operator',o.oid::text,to_jsonb(o) from pg_operator o where o.oprnamespace in (select oid from namespaces)
      union all select 'collation',c.oid::text,to_jsonb(c) from pg_collation c where c.collnamespace in (select oid from namespaces)
      union all select 'constraint',c.oid::text,to_jsonb(c) from pg_constraint c where c.connamespace in (select oid from namespaces)
      union all select 'rewrite',r.oid::text,to_jsonb(r) from pg_rewrite r join pg_class c on c.oid=r.ev_class where c.relnamespace in (select oid from namespaces)
      union all select 'policy',p.oid::text,to_jsonb(p) from pg_policy p join pg_class c on c.oid=p.polrelid where c.relnamespace in (select oid from namespaces)
      union all select 'trigger',t.oid::text,to_jsonb(t) from pg_trigger t join pg_class c on c.oid=t.tgrelid where c.relnamespace in (select oid from namespaces) and t.tgname not like 'sdi_observe_%'
      union all select 'inheritance',i.inhrelid::text||':'||i.inhparent,to_jsonb(i) from pg_inherits i join pg_class c on c.oid=i.inhparent where c.relnamespace in (select oid from namespaces)
      union all select 'cast',c.oid::text,to_jsonb(c) from pg_cast c
      union all select 'role',r.oid::text,to_jsonb(r)-'rolpassword' from pg_roles r
      union all select 'membership',m.roleid::text||':'||m.member,to_jsonb(m) from pg_auth_members m
      union all select 'extension',e.oid::text,to_jsonb(e) from pg_extension e
      union all select 'namespace',n.oid::text,to_jsonb(n) from pg_namespace n where n.oid in (select oid from namespaces)
      union all select 'environment',d.oid::text,jsonb_build_object('server',current_setting('server_version_num'),'encoding',d.encoding,'collate',d.datcollate,'ctype',d.datctype,'provider',to_jsonb(d)->'datlocprovider','collationVersion',to_jsonb(d)->'datcollversion') from pg_database d where d.datname=current_database()
    ) select kind,id,md5(definition::text) as hash from objects order by kind,id`,
    [[...schemas]],
  );
  return createHash('sha256')
    .update(canonical([...rows]))
    .digest('hex');
}
