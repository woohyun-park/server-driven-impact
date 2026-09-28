import { describe, expect, it } from 'vitest';
import {
  commandPreambleSql,
  ISOLATION_LEVELS,
  transactionReadPreambleSql,
} from '../../packages/sdi-postgres/src/postgres/preamble.js';
import { literal } from '../../packages/sdi-postgres/src/postgres/sql.js';

const token = '0f1e2d3c-4b5a-4678-9abc-def012345678';
const tag = '$sdi_0f1e2d3c4b5a46789abcdef012345678$';
const fingerprint = 'a'.repeat(64);

describe('PostgreSQL preamble SQL', () => {
  it('escapes single-quoted literals and rejects NUL bytes', () => {
    expect(literal("it's")).toBe("'it''s'");
    expect(() => literal('a\0b')).toThrow('INVALID_LITERAL');
  });

  it('starts a transaction, takes the migration gate, creates a transaction collector, and sets local state', () => {
    const statements = commandPreambleSql({
      isolationLevel: 'repeatable read',
      token,
      scope: "tenant'a",
      fingerprint,
      catalogGate: true,
    }).split(';\n');
    expect(statements).toHaveLength(4);
    expect(statements[0]).toBe('begin isolation level repeatable read');
    expect(statements[1]).toBe('lock table only "sdi_control"."transaction_gate" in access share mode');
    expect(statements[2]).toMatch(/^create temporary table sdi_observed_facts\(/);
    expect(statements[2]).toMatch(/on commit drop$/);
    expect(statements[3]).toBe(
      `select set_config('sdi.request_token','${token}',true),set_config('sdi.scope',${tag}tenant'a${tag},true),set_config('sdi.observation_phase','collecting',true),` +
        `(select jsonb_build_object('now',clock_timestamp(),'row',to_jsonb(v),'match',coalesce(case when v.fingerprint='${fingerprint}' then v.catalog_hash = "sdi_control".catalog_hash(v.catalog_schemas) else false end,false)) from (select 1) one left join "sdi_control"."validation" v on true) as sdi_validation`,
    );
    // Later commands of the same adapter skip the catalog hash.
    expect(
      commandPreambleSql({ isolationLevel: 'repeatable read', token, scope: 'a', fingerprint, catalogGate: false }),
    ).not.toContain('catalog_hash');
  });

  it('stringifies non-string scopes exactly like String()', () => {
    expect(
      commandPreambleSql({ isolationLevel: 'read committed', token, scope: 42, fingerprint, catalogGate: true }),
    ).toContain(`${tag}42${tag}`);
    expect(
      commandPreambleSql({ isolationLevel: 'read committed', token, scope: null, fingerprint, catalogGate: true }),
    ).toContain(`${tag}null${tag}`);
    expect(
      commandPreambleSql({ isolationLevel: 'read committed', token, scope: true, fingerprint, catalogGate: true }),
    ).toContain(`${tag}true${tag}`);
  });

  it('rejects unknown isolation levels, malformed tokens, and scopes containing the quote tag', () => {
    expect(() =>
      commandPreambleSql({ isolationLevel: 'snapshot' as never, token, scope: 'a', fingerprint, catalogGate: true }),
    ).toThrow('INVALID_ISOLATION_LEVEL');
    expect(() =>
      commandPreambleSql({
        isolationLevel: 'read committed',
        token: "x'; drop table t; --",
        scope: 'a',
        fingerprint,
        catalogGate: true,
      }),
    ).toThrow('INVALID_REQUEST_TOKEN');
    expect(() =>
      commandPreambleSql({
        isolationLevel: 'read committed',
        token,
        scope: `a${tag}b`,
        fingerprint,
        catalogGate: true,
      }),
    ).toThrow('INVALID_SCOPE_LITERAL');
    expect(() =>
      commandPreambleSql({
        isolationLevel: 'read committed',
        token,
        scope: 'a',
        fingerprint: "x' or true --",
        catalogGate: true,
      }),
    ).toThrow('INVALID_OBSERVER_FINGERPRINT');
    // A scope ending in the tag minus its trailing `$` borrows that `$` from the closing tag and
    // terminates the quoted string just as well, so it must be rejected too.
    expect(() =>
      commandPreambleSql({
        isolationLevel: 'read committed',
        token,
        scope: `a${tag.slice(0, -1)}`,
        fingerprint,
        catalogGate: true,
      }),
    ).toThrow('INVALID_SCOPE_LITERAL');
    expect(() =>
      commandPreambleSql({ isolationLevel: 'read committed', token, scope: 'a\0b', fingerprint, catalogGate: true }),
    ).toThrow('INVALID_SCOPE_LITERAL');
    expect(() => transactionReadPreambleSql('serializable read only' as never)).toThrow('INVALID_ISOLATION_LEVEL');
    expect(ISOLATION_LEVELS).toEqual(['read uncommitted', 'read committed', 'repeatable read', 'serializable']);
  });

  it('builds a transaction-pool read preamble without session state', () => {
    expect(transactionReadPreambleSql('repeatable read')).toBe(
      'begin isolation level repeatable read read only;\nlock table only "sdi_control"."transaction_gate" in access share mode',
    );
  });
});
