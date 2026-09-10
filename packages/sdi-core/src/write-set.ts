import { LIMITS, byteLength, canonical, isScalar, type RowState, type Scalar, type WriteFact } from './contracts.js';

type Entry = { facts: WriteFact[]; bytes: number; summarized: boolean };
const SUMMARY_BYTES = 768;

/** Transaction-owned memory. Resource-local summaries preserve proven common values. */
export class WriteSet {
  private entries = new Map<string, Entry>();
  private closed = false;
  constructor(private readonly resources?: ReadonlySet<string>) {}
  fork(): WriteSet {
    if (this.closed) throw new Error('WRITE_CONTEXT_CLOSED');
    return new WriteSet(this.resources);
  }
  merge(child: WriteSet): void { this.add(child.snapshot()); }
  add(facts: readonly WriteFact[]): void {
    if (this.closed) throw new Error('WRITE_CONTEXT_CLOSED');
    for (const fact of facts) {
      if (this.resources && !this.resources.has(fact.resource)) throw new Error('UNREGISTERED_RESOURCE');
      if (!fact.resource || fact.resource.length > 128 || !['insert','update','delete','unknown'].includes(fact.operation) || !(fact.changedColumns === null || (Array.isArray(fact.changedColumns) && fact.changedColumns.every(c=>typeof c === 'string')))) throw new Error('INVALID_WRITE_FACT');
      for (const row of [fact.before,fact.after]) {
        if (!row || !['absent','unknown','known'].includes(row.kind)) throw new Error('INVALID_ROW_STATE');
        if (row.kind === 'known' && row.equalityFields !== undefined && (!row.equalityFields || typeof row.equalityFields !== 'object' || Array.isArray(row.equalityFields) || !Object.values(row.equalityFields).every(isScalar))) throw new Error('NON_SCALAR_FIELD');
        if (row.kind === 'known' && (!isScalar(row.scope) || !row.fields || !Object.values(row.fields).every(isScalar))) throw new Error('NON_SCALAR_FIELD');
      }
      if (!this.entries.has(fact.resource) && this.entries.size >= LIMITS.resources) throw new Error('RESOURCE_LIMIT');
      const copied = JSON.parse(canonical(fact)) as WriteFact;
      const entry = this.entries.get(fact.resource) ?? { facts: [], bytes: 0, summarized: false };
      this.entries.set(fact.resource, entry);
      if (entry.summarized) {
        entry.facts = [summarize([...entry.facts, copied])];
        entry.bytes = byteLength(entry.facts[0]);
      } else {
        entry.facts.push(copied);
        entry.bytes += byteLength(copied);
      }
      if (this.overBudget() && !entry.summarized && (entry.facts.length > 1 || entry.bytes > SUMMARY_BYTES)) this.compact(entry);
      // Shared limits may still require reclaiming another resource's detail. Prefer
      // the largest buffer, retaining small independent mutations whenever possible.
      while (this.overBudget()) {
        const largest = [...this.entries.values()].filter(value => !value.summarized).sort((a,b) => b.bytes-a.bytes)[0];
        if (!largest) throw new Error('RESOURCE_LIMIT');
        this.compact(largest);
      }
    }
  }
  private overBudget(): boolean {
    let count = 0, bytes = 0;
    for (const entry of this.entries.values()) { count += entry.facts.length; bytes += entry.bytes; }
    return count > LIMITS.facts || bytes + count + 1 > LIMITS.factBytes;
  }
  private compact(entry: Entry): void {
    entry.facts = [summarize(entry.facts)];
    entry.bytes = byteLength(entry.facts[0]);
    entry.summarized = true;
  }
  snapshot(): WriteFact[] { return JSON.parse(canonical([...this.entries.values()].flatMap(entry => entry.facts))) as WriteFact[]; }
  close(): void { this.closed = true; }
}

function commonRow(left: RowState, right: RowState): RowState {
  if (left.kind === 'absent') return right;
  if (right.kind === 'absent') return left;
  if (left.kind !== 'known' || right.kind !== 'known' || left.scope !== right.scope) return { kind: 'unknown' };
  return { kind: 'known', scope: left.scope, fields: commonFields(left.fields,right.fields), ...(left.equalityFields && right.equalityFields ? {equalityFields:commonFields(left.equalityFields,right.equalityFields)} : {}) };
}
function commonFields(left: Record<string, Scalar>, right: Record<string, Scalar>) {
  return Object.fromEntries(Object.entries(left).filter(([key,value]) => Object.hasOwn(right,key) && right[key] === value));
}
function summarize(facts: readonly WriteFact[]): WriteFact {
  const summary: WriteFact = { resource: facts[0].resource, operation: facts[0].operation, before: {kind:'absent'}, after: {kind:'absent'}, changedColumns: [] };
  for (const fact of facts) {
    summary.before = commonRow(summary.before,fact.before);
    summary.after = commonRow(summary.after,fact.after);
    if (summary.operation !== fact.operation) summary.operation = 'unknown';
    summary.changedColumns = summary.changedColumns === null || fact.changedColumns === null ? null : [...new Set([...summary.changedColumns,...fact.changedColumns])];
    // Bound intermediate retained values as well as the final summary. Losing a
    // constraint is conservative; a later fact must never restore that constraint.
    if (byteLength(summary) > SUMMARY_BYTES) {
      for (const row of [summary.before,summary.after]) if (row.kind === 'known') { row.fields = {}; delete row.equalityFields; }
      summary.changedColumns = null;
      if (byteLength(summary) > SUMMARY_BYTES) {
        if (summary.before.kind === 'known') summary.before = {kind:'unknown'};
        if (summary.after.kind === 'known') summary.after = {kind:'unknown'};
      }
    }
  }
  return summary;
}
