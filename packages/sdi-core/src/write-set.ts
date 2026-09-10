import { LIMITS, byteLength, canonical, isScalar, type WriteFact } from './contracts.js';
/** Transaction-owned memory. Overflow retains resource identity and widens unknown scopes. */
export class WriteSet {
  private facts: WriteFact[] = [];
  private broad = new Map<string, WriteFact>();
  private bytes = 0;
  private overflow = false;
  private closed = false;
  constructor(private readonly resources?: ReadonlySet<string>) {}
  fork(): WriteSet {
    if (this.closed) throw new Error('WRITE_CONTEXT_CLOSED');
    return new WriteSet(this.resources);
  }
  merge(child: WriteSet): void {
    this.add(child.snapshot());
  }
  add(facts: readonly WriteFact[]): void {
    if (this.closed) throw new Error('WRITE_CONTEXT_CLOSED');
    for (const fact of facts) {
      if (this.resources && !this.resources.has(fact.resource)) throw new Error('UNREGISTERED_RESOURCE');
      if (!fact.resource || fact.resource.length > 128 || !['insert','update','delete','unknown'].includes(fact.operation) || !(fact.changedColumns === null || (Array.isArray(fact.changedColumns) && fact.changedColumns.every(c=>typeof c === 'string')))) throw new Error('INVALID_WRITE_FACT');
      for (const row of [fact.before,fact.after]) {
        if (!row || !['absent','unknown','known'].includes(row.kind)) throw new Error('INVALID_ROW_STATE');
        if (row.kind === 'known' && (!isScalar(row.scope) || !row.fields || !Object.values(row.fields).every(isScalar))) throw new Error('NON_SCALAR_FIELD');
      }
      const size = byteLength(fact);
      if (!this.overflow && this.facts.length < LIMITS.facts && this.bytes + size <= LIMITS.factBytes) {
        this.facts.push(JSON.parse(canonical(fact)) as WriteFact); this.bytes += size; continue;
      }
      if (!this.overflow) { this.overflow = true; for (const previous of this.facts) this.widen(previous); this.facts = []; }
      this.widen(fact);
    }
  }
  private widen(fact: WriteFact): void {
    // At most one compact fact per configured resource; preserves both scopes by widening.
    if (fact.resource.length > 128 || (!this.broad.has(fact.resource) && this.broad.size >= LIMITS.resources)) throw new Error('RESOURCE_LIMIT');
    this.broad.set(fact.resource,{resource:fact.resource,operation:'unknown',before:{kind:'unknown'},after:{kind:'unknown'},changedColumns:null});
  }
  snapshot(): WriteFact[] { return JSON.parse(canonical(this.overflow ? [...this.broad.values()] : this.facts)) as WriteFact[]; }
  close(): void { this.closed = true; }
}
