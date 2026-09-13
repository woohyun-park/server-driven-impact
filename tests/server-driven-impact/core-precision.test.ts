import { describe, expect, it } from 'vitest';
import {
  byteLength,
  createImpact,
  LIMITS,
  matchesInputSelector,
  WriteSet,
  type CommandAdapter,
  type ImpactManifest,
  type WriteFact,
} from '@server-driven-impact/core';

const resources = {
  orders: { scopeColumn: 'tenant', columns: ['tenant', 'id', 'customer', 'value'] },
  notes: { scopeColumn: 'tenant', columns: ['tenant', 'id', 'customer', 'value'] },
};
const manifest: ImpactManifest = {
  protocolVersion: 1,
  reads: {
    orders: [
      {
        resource: 'orders',
        columns: '*',
        bindings: [
          { column: 'customer', input: 'customer' },
          { column: 'id', input: 'id' },
        ],
      },
    ],
    notes: [{ resource: 'notes', columns: '*', bindings: [{ column: 'id', input: 'id' }] }],
  },
};
const engine = createImpact({ resources, manifest });
function fact(resource: 'orders' | 'notes', id: string, customer = 'customer-a', scope = 'tenant-a'): WriteFact {
  return {
    resource,
    operation: 'insert',
    before: { kind: 'absent' },
    after: { kind: 'known', scope, fields: { id, customer } },
    changedColumns: null,
  };
}
const selector = (writes: WriteFact[], endpoint: string) =>
  engine.calculate(writes, 'tenant-a').targets.find(target => target.endpoint === endpoint)?.selector;

describe('resource-local WriteSet precision under hard limits', () => {
  it('keeps a small independent mutation and the overflowing resource common customer/scope', () => {
    const writes = new WriteSet();
    const note = fact('notes', 'note-1');
    writes.add([note, ...Array.from({ length: LIMITS.facts }, (_, i) => fact('orders', String(i)))]);
    expect(writes.snapshot().find(write => write.resource === 'notes')).toEqual(note);
    expect(selector(writes.snapshot(), 'notes')).toEqual({ kind: 'inputs', values: [{ id: 'note-1' }] });
    expect(selector(writes.snapshot(), 'orders')).toEqual({ kind: 'inputs', values: [{ customer: 'customer-a' }] });
    expect(engine.calculate(writes.snapshot(), 'tenant-b').targets).toEqual([]);
    expect(writes.snapshot().length).toBeLessThanOrEqual(LIMITS.facts);
    expect(byteLength(writes.snapshot())).toBeLessThanOrEqual(LIMITS.factBytes);
  });
  it('does not permanently summarize a small resource arriving at an already full buffer', () => {
    const writes = new WriteSet();
    writes.add(Array.from({ length: LIMITS.facts }, (_, i) => fact('orders', String(i))));
    writes.add([fact('notes', 'note-1'), fact('notes', 'note-2')]);
    expect(selector(writes.snapshot(), 'notes')).toEqual({
      kind: 'inputs',
      values: [{ id: 'note-1' }, { id: 'note-2' }],
    });
  });
  it('preserves old and new customer ranges across a summarized update batch', () => {
    const writes = new WriteSet();
    writes.add(
      Array.from({ length: LIMITS.facts + 1 }, (_, i) => ({
        ...fact('orders', String(i), 'new'),
        operation: 'update',
        before: fact('orders', String(i), 'old').after,
        changedColumns: ['customer'],
      })),
    );
    expect(selector(writes.snapshot(), 'orders')).toEqual({
      kind: 'inputs',
      values: [{ customer: 'new' }, { customer: 'old' }],
    });
  });
  it('preserves UPDATE column pruning and unions later changed columns', () => {
    const valueEngine = createImpact({
      resources,
      manifest: { protocolVersion: 1, reads: { values: [{ resource: 'orders', columns: ['value'], bindings: [] }] } },
    });
    const writes = new WriteSet();
    writes.add(
      Array.from({ length: LIMITS.facts + 1 }, (_, i) => ({
        ...fact('orders', String(i)),
        operation: 'update',
        changedColumns: ['customer'],
      })),
    );
    expect(valueEngine.calculate(writes.snapshot(), 'tenant-a').targets).toEqual([]);
    writes.add([{ ...fact('orders', 'later'), operation: 'update', changedColumns: ['value'] }]);
    expect(valueEngine.calculate(writes.snapshot(), 'tenant-a').targets).toHaveLength(1);
  });
  it('retains known scope while dropping oversized binding values', () => {
    const writes = new WriteSet();
    writes.add([fact('notes', 'note-1'), fact('orders', 'x'.repeat(LIMITS.factBytes))]);
    expect(selector(writes.snapshot(), 'notes')).toEqual({ kind: 'inputs', values: [{ id: 'note-1' }] });
    expect(engine.calculate(writes.snapshot(), 'tenant-b').targets).toEqual([]);
    expect(byteLength(writes.snapshot())).toBeLessThanOrEqual(LIMITS.factBytes);
  });
  it('unknown and mixed scopes never become falsely known after later facts', () => {
    const writes = new WriteSet();
    writes.add(
      Array.from({ length: LIMITS.facts + 1 }, (_, i) =>
        fact('orders', String(i), 'customer-a', i === 0 ? 'tenant-b' : 'tenant-a'),
      ),
    );
    writes.add([fact('orders', 'later')]);
    expect(selector(writes.snapshot(), 'orders')).toEqual({ kind: 'all' });
    expect(engine.calculate(writes.snapshot(), 'tenant-b').targets[0].selector).toEqual({ kind: 'all' });
  });
  it('bounds many resources and merges child summaries without losing effects', () => {
    const writes = new WriteSet();
    const child = writes.fork();
    child.add(Array.from({ length: LIMITS.facts + 1 }, (_, i) => fact('orders', String(i))));
    writes.add([fact('notes', 'note-1')]);
    writes.merge(child);
    expect(selector(writes.snapshot(), 'orders')).toEqual({ kind: 'inputs', values: [{ customer: 'customer-a' }] });
    const many = new WriteSet();
    for (let i = 0; i < LIMITS.resources; i++) many.add([{ ...fact('orders', 'x'.repeat(2000)), resource: String(i) }]);
    expect(byteLength(many.snapshot())).toBeLessThanOrEqual(LIMITS.factBytes);
    expect(many.snapshot()).toHaveLength(LIMITS.resources);
    expect(() => many.add([{ ...fact('orders', 'one'), resource: 'extra' }])).toThrow('RESOURCE_LIMIT');
  });
});

describe('endpoint-local impact precision', () => {
  it('retains independent detail when another endpoint exceeds the byte budget', () => {
    const result = engine.explain(
      [fact('notes', 'note-1'), fact('orders', 'x'.repeat(LIMITS.impactBytes))],
      'tenant-a',
    );
    expect(result.impact.targets.find(target => target.endpoint === 'notes')?.selector).toEqual({
      kind: 'inputs',
      values: [{ id: 'note-1' }],
    });
    expect(result.impact.targets.find(target => target.endpoint === 'orders')?.selector).toEqual({ kind: 'all' });
    expect(byteLength(result.impact)).toBeLessThanOrEqual(LIMITS.impactBytes);
    expect(result.decisions.some(decision => decision.endpoint === 'orders' && decision.reason === 'byte-limit')).toBe(
      true,
    );
  });
  it('deduplicates exact conjunction subsets in either encounter order', () => {
    const broad = fact('orders', 'unused');
    broad.after = { kind: 'known', scope: 'tenant-a', fields: { customer: 'customer-a' } };
    for (const writes of [
      [fact('orders', '1'), broad],
      [broad, fact('orders', '1')],
    ]) {
      expect(selector(writes, 'orders')).toEqual({ kind: 'inputs', values: [{ customer: 'customer-a' }] });
    }
  });
  it('reclaims encoded selector bytes when a partial conjunction subsumes detail', () => {
    const broad = fact('orders', 'unused');
    broad.after = { kind: 'known', scope: 'tenant-a', fields: { customer: 'customer-a' } };
    const writes = [
      ...Array.from({ length: 20 }, (_, i) => fact('orders', String(i) + '한'.repeat(1000))),
      broad,
      ...Array.from({ length: 30 }, (_, i) => fact('notes', String(i) + '한'.repeat(1000))),
    ];
    const result = engine.calculate(writes, 'tenant-a');
    expect(result.targets.every(target => target.selector.kind === 'inputs')).toBe(true);
    expect(result.targets.find(target => target.endpoint === 'orders')?.selector).toEqual({
      kind: 'inputs',
      values: [{ customer: 'customer-a' }],
    });
    expect(byteLength(result)).toBeLessThanOrEqual(LIMITS.impactBytes);
  });
  it('retains a shared customer when selector alternatives exceed their budget', () => {
    const writes = Array.from({ length: LIMITS.selectors + 1 }, (_, i) => fact('orders', String(i)));
    const actual = selector(writes, 'orders');
    expect(actual).toEqual({ kind: 'inputs', values: [{ customer: 'customer-a' }] });
    for (let i = 0; i < writes.length; i++)
      expect(matchesInputSelector({ customer: 'customer-a', id: String(i) }, actual)).toBe(true);
    expect(matchesInputSelector({ customer: 'customer-b', id: '0' }, actual)).toBe(false);
  });
});

describe('core command final observer lifecycle', () => {
  it('calculates after commit-time effects are drained into the original WriteSet', async () => {
    const adapter: CommandAdapter<object> = {
      async command(_scope, work) {
        const writes = new WriteSet();
        const result = await work({}, writes);
        // A deferred trigger and final collector drain occur after callback completion.
        writes.add([fact('orders', 'deferred')]);
        writes.close();
        return result;
      },
    };
    const result = await engine.command(adapter, { scope: 'tenant-a' }, async () => 'committed');
    expect(result.data).toBe('committed');
    expect(result.impact.targets[0].selector).toEqual({
      kind: 'inputs',
      values: [{ customer: 'customer-a', id: 'deferred' }],
    });
  });
  it('never returns a successful response after commit or drain rejection', async () => {
    for (const failure of ['COMMIT_FAILED', 'COMMITTED_OBSERVATION_FAILED']) {
      const adapter: CommandAdapter<object> = {
        async command(_scope, work) {
          const writes = new WriteSet();
          await work({}, writes);
          writes.add([fact('orders', '1')]);
          throw new Error(failure);
        },
      };
      await expect(engine.command(adapter, { scope: 'tenant-a' }, async () => 1)).rejects.toThrow(failure);
    }
  });
});
