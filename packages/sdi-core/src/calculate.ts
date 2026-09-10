import { LIMITS, byteLength, canonical, scalarMayEqual, validateImpactManifest, validateImpactResources, type ImpactResources, type Scalar, type ImpactManifest, type WriteFact, type ImpactSet, type ImpactTarget } from './contracts.js';
import { WriteSet } from './write-set.js';
import { ImpactUnavailableError } from './errors.js';
export interface Decision { resource: string; endpoint?: string; reason: 'scope-excluded' | 'filter-excluded' | 'columns-unchanged' | 'unknown-row' | 'missing-binding' | 'matched' | 'selector-limit' | 'byte-limit' }
export interface CalculateOptions { resources: ImpactResources; manifest: ImpactManifest; scope: Scalar; explain?: (decision: Decision) => void }
type IndexedRead = { endpoint: string; read: ImpactManifest['reads'][string][number] };
type ReadIndex = ReadonlyMap<string,readonly IndexedRead[]>;
const utf8 = new TextEncoder();
function indexReads(manifest: ImpactManifest): ReadIndex {
  const index = new Map<string,IndexedRead[]>();
  for (const [endpoint,reads] of Object.entries(manifest.reads)) for (const read of reads) {
    const entries=index.get(read.resource) ?? [];
    entries.push({endpoint,read}); index.set(read.resource,entries);
  }
  return index;
}
export function calculateImpact(writes: readonly WriteFact[], options: CalculateOptions): ImpactSet {
  validateImpactResources(options.resources); validateImpactManifest(options.manifest,options.resources);
  return calculate(writes,options,indexReads(options.manifest));
}
function calculate(writes: readonly WriteFact[], options: CalculateOptions, readsByResource: ReadIndex): ImpactSet {
  const {resources,scope,explain} = options;
  type Alternative = { value: Record<string,Scalar>; fields: number; bytes: number };
  type TargetEntry = { target:ImpactTarget; bytes:number; alternatives:Map<string,Alternative>; minFields:number; maxFields:number };
  const targets = new Map<string,TargetEntry>();
  // Include the envelope and separators, so limits apply to the encoded response.
  let targetBytes = byteLength({protocolVersion:1,targets:[]}) - 1;
  function setTarget(key: string, target: ImpactTarget, alternatives = new Map<string,Alternative>(), bytes = byteLength(target), minFields = Infinity, maxFields = -Infinity): void {
    const previous = targets.get(key);
    if (previous) targetBytes -= previous.bytes + 1;
    targets.set(key,{target,bytes,alternatives,minFields,maxFields}); targetBytes += bytes + 1;
  }
  function enforceByteBudget(): void {
    while (targetBytes > LIMITS.impactBytes) {
      const candidates = [...targets.entries()].filter(([,entry]) => entry.target.selector.kind === 'inputs')
        .sort((a,b) => b[1].bytes-a[1].bytes || (a[0] < b[0] ? -1 : 1));
      const largest = candidates[0];
      if (!largest) throw new Error('MANIFEST_TARGET_BUDGET');
      const [key,{target}] = largest;
      setTarget(key,{...target,selector:{kind:'all'}});
      explain?.({resource:'*',endpoint:target.endpoint,reason:'byte-limit'});
    }
  }
  for (const write of writes) {
    if (!Object.hasOwn(resources,write.resource)) throw new Error('UNREGISTERED_RESOURCE');
    const resource = resources[write.resource];
    for (const row of [write.before,write.after]) {
      if (row.kind === 'absent') continue;
      if (resource.scopeColumn !== null && row.kind === 'known' && row.scope !== scope) { explain?.({resource:write.resource,reason:'scope-excluded'}); continue; }
      const targetScope = resource.scopeColumn === null ? 'global' : 'caller';
      for (const {endpoint,read} of readsByResource.get(write.resource) ?? []) {
        if (write.operation === 'update' && write.changedColumns !== null && !(resource.scopeColumn !== null && write.changedColumns.includes(resource.scopeColumn)) && !write.changedColumns.some(c => read.columns === '*' || read.columns.includes(c) || read.filters?.some(filter => filter.column === c))) {
          explain?.({resource:write.resource,endpoint,reason:'columns-unchanged'}); continue;
        }
        if (row.kind === 'known' && read.filters?.some(filter => row.equalityFields && Object.hasOwn(row.equalityFields,filter.column) && !filterMayEqual(row.equalityFields[filter.column],filter.value))) {
          explain?.({resource:write.resource,endpoint,reason:'filter-excluded'}); continue;
        }
        const input: Record<string,Scalar> = Object.create(null);
        let reason: Decision['reason'] = row.kind === 'unknown' ? 'unknown-row' : 'matched';
        for (const binding of read.bindings) {
          if (row.kind === 'known' && Object.hasOwn(row.fields,binding.column)) {
            const value = row.fields[binding.column];
            // Contradictory bindings cannot safely be represented by a single conjunction.
            if (Object.hasOwn(input,binding.input) && input[binding.input] !== value) { for (const k of Object.keys(input)) delete input[k]; reason='missing-binding'; break; }
            input[binding.input] = value;
          } else reason = row.kind === 'unknown' ? 'unknown-row' : 'missing-binding';
        }
        const key = canonical([endpoint,targetScope]);
        const previous = targets.get(key);
        if (previous?.target.selector.kind !== 'all') {
          const fields = Object.keys(input).length;
          const valueKey = canonical(input);
          const alternatives = previous?.alternatives ?? new Map<string,Alternative>();
          const covered = alternatives.has(valueKey) || (previous && previous.minFields < fields && [...alternatives.values()].some(value => value.fields < fields && subsumes(value.value,input)));
          if (!fields) setTarget(key,{endpoint,scope:targetScope,selector:{kind:'all'}});
          else if (!covered) {
            const oldCount = alternatives.size;
            const inputBytes = utf8.encode(valueKey).length;
            let deltaBytes = inputBytes;
            if (previous && previous.maxFields > fields) for (const [alternativeKey,value] of alternatives) if (fields < value.fields && subsumes(input,value.value)) {
              alternatives.delete(alternativeKey); deltaBytes -= value.bytes;
            }
            const removed = oldCount !== alternatives.size;
            let values = previous?.target.selector.kind === 'inputs' && !removed ? previous.target.selector.values : [...alternatives.values()].map(value => value.value);
            values.push(input);
            alternatives.set(valueKey,{value:input,fields,bytes:inputBytes});
            if (values.length > LIMITS.selectors) {
              // Preserve constraints shared by every alternative before widening all.
              const common = Object.fromEntries(Object.entries(values[0]).filter(([name,value]) => values.every(item => Object.hasOwn(item,name) && item[name] === value)));
              alternatives.clear();
              if (Object.keys(common).length) alternatives.set(canonical(common),{value:common,fields:Object.keys(common).length,bytes:byteLength(common)});
              values = [common]; reason = 'selector-limit';
              setTarget(key,{endpoint,scope:targetScope,selector:alternatives.size ? {kind:'inputs',values} : {kind:'all'}},alternatives,undefined,Object.keys(common).length,Object.keys(common).length);
            } else {
              const target: ImpactTarget = {endpoint,scope:targetScope,selector:{kind:'inputs',values}};
              const bytes = previous ? previous.bytes + deltaBytes + Math.max(0,values.length-1)-Math.max(0,oldCount-1) : byteLength(target);
              setTarget(key,target,alternatives,bytes,Math.min(previous?.minFields ?? Infinity,fields),Math.max(previous?.maxFields ?? -Infinity,fields));
            }
          }
          enforceByteBudget();
        }
        explain?.({resource:write.resource,endpoint,reason});
      }
    }
  }
  const result: ImpactSet = {protocolVersion:1,targets:[...targets.values()].map(value=>value.target).sort((a,b) => canonical([a.endpoint,a.scope]) < canonical([b.endpoint,b.scope]) ? -1 : 1)};
  for (const target of result.targets) if (target.selector.kind === 'inputs') target.selector.values.sort((a,b) => canonical(a) < canonical(b) ? -1 : canonical(a) > canonical(b) ? 1 : 0);
  return result;
}
// Mixed scalar types may be coerced by the DB (including PostgreSQL bool '1').
// Fractional/unsafe numbers may be rounded by database JSON encoders. Neither
// is proof of inequality, even when ordinary JavaScript comparison disagrees.
function filterMayEqual(actual: Scalar, expected: Scalar): boolean {
  if (actual === null || expected === null) return actual === expected;
  if (typeof actual !== typeof expected) return true;
  if (typeof actual === 'number' && (!Number.isSafeInteger(actual) || !Number.isSafeInteger(expected))) return true;
  return scalarMayEqual(actual,expected);
}
function subsumes(broad: Record<string,Scalar>, narrow: Record<string,Scalar>): boolean {
  return Object.entries(broad).every(([key,value]) => Object.hasOwn(narrow,key) && narrow[key] === value);
}
/** Resolves only after final commit and observer drain have populated the callback WriteSet. */
export interface CommandAdapter<Db> {
  command<T>(scope: Scalar, work: (db: Db, writes: WriteSet) => Promise<T>): Promise<T>;
}
export function createImpact(options: Omit<CalculateOptions,'scope'|'explain'>) {
  validateImpactResources(options.resources); validateImpactManifest(options.manifest,options.resources);
  // Freeze a private JSON snapshot so later caller mutation cannot change the validated policy.
  const policy = JSON.parse(canonical(options)) as typeof options;
  const reads=indexReads(policy.manifest);
  return {
    calculate(writes: readonly WriteFact[], scope: Scalar) { return calculate(writes,{...policy,scope},reads); },
    explain(writes: readonly WriteFact[], scope: Scalar) {
      const decisions: Decision[] = [];
      const impact = calculate(writes,{...policy,scope,explain:d=>decisions.push(d)},reads);
      return {impact,decisions};
    },
    async command<Db,T>(adapter: CommandAdapter<Db>, context: {scope: Scalar}, work: (db: Db) => Promise<T>): Promise<{data:T;impact:ImpactSet}> {
      const scope = context.scope;
      let committedWrites: WriteSet | undefined;
      const data = await adapter.command(scope,async (db,writes) => {
        committedWrites = writes;
        return work(db);
      });
      try {
        if (!committedWrites) throw new Error('COMMAND_CALLBACK_NOT_EXECUTED');
        return {data,impact:calculate(committedWrites.snapshot(),{...policy,scope},reads)};
      } catch (cause) { throw new ImpactUnavailableError(data, {cause}); }
    },
  };
}
