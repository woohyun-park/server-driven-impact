import type { Scalar } from '@server-driven-impact/core';
import { observerInternals } from './observer.js';
import { lockKeys } from './session.js';
import { literal } from './sql.js';

export const ISOLATION_LEVELS = Object.freeze([
  'read uncommitted',
  'read committed',
  'repeatable read',
  'serializable',
] as const);
export type IsolationLevel = (typeof ISOLATION_LEVELS)[number];

const TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertIsolationLevel(level: string): asserts level is IsolationLevel {
  if (!ISOLATION_LEVELS.includes(level as IsolationLevel)) throw new Error('INVALID_ISOLATION_LEVEL');
}

/**
 * The multi-statement string starts in an implicit transaction block; the `commit` that closes it
 * raises WARNING 25P01. SET LOCAL silences it and reverts when that block ends.
 */
export const quietCommitSql = 'set local client_min_messages = error';

/** Session-level lock taken before BEGIN so the transaction snapshot follows any migration commit. */
export const sessionLockSql = `select pg_advisory_lock_shared(${lockKeys[0]},${lockKeys[1]})`;

/** Per-session collector; `on commit preserve rows` keeps it across commands on the same backend. */
export const collectorTableSql =
  `do $sdi$ begin if to_regclass('pg_temp.${observerInternals.collectorTable}') is null then ` +
  `create temporary table ${observerInternals.collectorTable}(` +
  'token text not null,resource text not null,operation text not null,' +
  'before_state jsonb not null,after_state jsonb not null,changed_columns jsonb' +
  ') on commit preserve rows; end if; end $sdi$';

/**
 * One simple-protocol round trip. The `commit` closes the implicit multi-statement
 * transaction block; otherwise BEGIN could not change the isolation level.
 */
export function readPreambleSql(isolationLevel: IsolationLevel): string {
  assertIsolationLevel(isolationLevel);
  return [quietCommitSql, sessionLockSql, 'commit', `begin isolation level ${isolationLevel} read only`].join(';\n');
}

export function commandPreambleSql(options: { isolationLevel: IsolationLevel; token: string; scope: Scalar }): string {
  assertIsolationLevel(options.isolationLevel);
  if (!TOKEN.test(options.token)) throw new Error('INVALID_REQUEST_TOKEN');
  const tag = `$sdi_${options.token.replaceAll('-', '')}$`;
  const scope = String(options.scope);
  // A scope ending in the tag minus its trailing `$` also terminates the quoted string, by borrowing
  // that `$` from the closing tag, so reject the prefix rather than the full tag.
  //
  // This guard is sound only because the token is server-generated and unpredictable: it comes from a
  // fresh randomUUID() per command, so a caller cannot aim a scope at the tag. If the token ever
  // becomes caller-supplied, reused across commands, or otherwise predictable, this check stops being
  // a guard and the scope must be escaped instead of dollar-quoted.
  if (scope.includes(tag.slice(0, -1)) || scope.includes('\0')) throw new Error('INVALID_SCOPE_LITERAL');
  return [
    quietCommitSql,
    sessionLockSql,
    collectorTableSql,
    'commit',
    `begin isolation level ${options.isolationLevel}`,
    `select set_config('sdi.request_token',${literal(options.token)},true),set_config('sdi.scope',${tag}${scope}${tag},true)`,
  ].join(';\n');
}
