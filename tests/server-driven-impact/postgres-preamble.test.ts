import { describe, expect, it } from 'vitest';
import {
  commandPreambleSql,
  ISOLATION_LEVELS,
  readPreambleSql,
  sessionLockSql,
} from '../../packages/sdi-postgres/src/postgres/preamble.js';
import { lockKeys } from '../../packages/sdi-postgres/src/postgres/session.js';
import { literal } from '../../packages/sdi-postgres/src/postgres/sql.js';

const token = '0f1e2d3c-4b5a-4678-9abc-def012345678';
const tag = '$sdi_0f1e2d3c4b5a46789abcdef012345678$';

describe('PostgreSQL preamble SQL', () => {
  it('escapes single-quoted literals and rejects NUL bytes', () => {
    expect(literal("it's")).toBe("'it''s'");
    expect(() => literal('a\0b')).toThrow('INVALID_LITERAL');
  });

  it('inlines the session lock keys as decimal constants', () => {
    expect(lockKeys).toEqual([0x534449, 0x5047]);
    expect(sessionLockSql).toBe('select pg_advisory_lock_shared(5456969,20551)');
  });

  it('orders quiet, lock, collector table, commit, begin, and request settings in one string', () => {
    const statements = commandPreambleSql({ isolationLevel: 'repeatable read', token, scope: "tenant'a" }).split(';\n');
    expect(statements).toHaveLength(6);
    expect(statements[0]).toBe('set local client_min_messages = error');
    expect(statements[1]).toBe(sessionLockSql);
    expect(statements[2]).toMatch(
      /^do \$sdi\$ begin if to_regclass\('pg_temp\.sdi_observed_facts'\) is null then create temporary table sdi_observed_facts\(/,
    );
    expect(statements[2]).toMatch(/on commit preserve rows; end if; end \$sdi\$$/);
    expect(statements[3]).toBe('commit');
    expect(statements[4]).toBe('begin isolation level repeatable read');
    expect(statements[5]).toBe(
      `select set_config('sdi.request_token','${token}',true),set_config('sdi.scope',${tag}tenant'a${tag},true)`,
    );
  });

  it('stringifies non-string scopes exactly like String()', () => {
    expect(commandPreambleSql({ isolationLevel: 'read committed', token, scope: 42 })).toContain(`${tag}42${tag}`);
    expect(commandPreambleSql({ isolationLevel: 'read committed', token, scope: null })).toContain(`${tag}null${tag}`);
    expect(commandPreambleSql({ isolationLevel: 'read committed', token, scope: true })).toContain(`${tag}true${tag}`);
  });

  it('rejects unknown isolation levels, malformed tokens, and scopes containing the quote tag', () => {
    expect(() => commandPreambleSql({ isolationLevel: 'snapshot' as never, token, scope: 'a' })).toThrow(
      'INVALID_ISOLATION_LEVEL',
    );
    expect(() =>
      commandPreambleSql({ isolationLevel: 'read committed', token: "x'; drop table t; --", scope: 'a' }),
    ).toThrow('INVALID_REQUEST_TOKEN');
    expect(() => commandPreambleSql({ isolationLevel: 'read committed', token, scope: `a${tag}b` })).toThrow(
      'INVALID_SCOPE_LITERAL',
    );
    expect(() => commandPreambleSql({ isolationLevel: 'read committed', token, scope: 'a\0b' })).toThrow(
      'INVALID_SCOPE_LITERAL',
    );
    expect(() => readPreambleSql('serializable read only' as never)).toThrow('INVALID_ISOLATION_LEVEL');
    expect(ISOLATION_LEVELS).toEqual(['read uncommitted', 'read committed', 'repeatable read', 'serializable']);
  });

  it('builds the read-only preamble with the same quiet-lock-commit-begin order', () => {
    expect(readPreambleSql('read committed')).toBe(
      'set local client_min_messages = error;\nselect pg_advisory_lock_shared(5456969,20551);\ncommit;\nbegin isolation level read committed read only',
    );
  });
});
