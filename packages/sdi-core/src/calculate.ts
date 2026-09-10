import { LIMITS, byteLength, canonical, validateImpactManifest, validateImpactResources, type ImpactResources, type Scalar, type ImpactManifest, type WriteFact, type ImpactSet, type ImpactTarget } from './contracts.js';
import { WriteSet } from './write-set.js';
export interface Decision { resource: string; endpoint?: string; reason: 'scope-excluded' | 'columns-unchanged' | 'unknown-row' | 'missing-binding' | 'matched' | 'selector-limit' | 'byte-limit' }
export interface CalculateOptions { resources: ImpactResources; manifest: ImpactManifest; scope: Scalar; explain?: (decision: Decision) => void }
export function calculateImpact(writes: readonly WriteFact[], options: CalculateOptions): ImpactSet {
  validateImpactResources(options.resources); validateImpactManifest(options.manifest,options.resources);
  return calculate(writes,options);
}
function calculate(writes: readonly WriteFact[], options: CalculateOptions): ImpactSet {
  const {resources,manifest,scope,explain} = options;
  const targets = new Map<string,ImpactTarget>();
  for (const write of writes) {
    if (!Object.hasOwn(resources,write.resource)) throw new Error('UNREGISTERED_RESOURCE');
    const resource = resources[write.resource];
    for (const row of [write.before,write.after]) {
      if (row.kind === 'absent') continue;
      if (resource.scopeColumn !== null && row.kind === 'known' && row.scope !== scope) { explain?.({resource:write.resource,reason:'scope-excluded'}); continue; }
      const targetScope = resource.scopeColumn === null ? 'global' : 'caller';
      for (const [endpoint,reads] of Object.entries(manifest.reads)) for (const read of reads) {
        if (read.resource !== write.resource) continue;
        if (write.operation === 'update' && write.changedColumns !== null && !(resource.scopeColumn !== null && write.changedColumns.includes(resource.scopeColumn)) && !write.changedColumns.some(c => read.columns === '*' || read.columns.includes(c))) {
          explain?.({resource:write.resource,endpoint,reason:'columns-unchanged'}); continue;
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
        if (previous?.selector.kind !== 'all') {
          const values = previous?.selector.kind === 'inputs' ? previous.selector.values : [];
          if (Object.keys(input).length && !values.some(v => canonical(v) === canonical(input))) values.push(input);
          const all = !Object.keys(input).length || values.length > LIMITS.selectors;
          if (values.length > LIMITS.selectors) reason='selector-limit';
          targets.set(key,{endpoint,scope:targetScope,selector:all ? {kind:'all'} : {kind:'inputs',values}});
        }
        explain?.({resource:write.resource,endpoint,reason});
      }
    }
  }
  const result: ImpactSet = {protocolVersion:1,targets:[...targets.values()].sort((a,b) => canonical([a.endpoint,a.scope]) < canonical([b.endpoint,b.scope]) ? -1 : 1)};
  for (const target of result.targets) if (target.selector.kind === 'inputs') target.selector.values.sort((a,b) => canonical(a) < canonical(b) ? -1 : canonical(a) > canonical(b) ? 1 : 0);
  if (byteLength(result) > LIMITS.impactBytes) for (const target of result.targets) { target.selector={kind:'all'}; explain?.({resource:'*',endpoint:target.endpoint,reason:'byte-limit'}); }
  return result;
}
export interface CommandAdapter<Db> {
  command<T>(scope: Scalar, work: (db: Db, writes: WriteSet) => Promise<T>): Promise<T>;
}
export function createImpact(options: Omit<CalculateOptions,'scope'|'explain'>) {
  validateImpactResources(options.resources); validateImpactManifest(options.manifest,options.resources);
  // Freeze a private JSON snapshot so later caller mutation cannot change the validated policy.
  const policy = JSON.parse(canonical(options)) as typeof options;
  return {
    calculate(writes: readonly WriteFact[], scope: Scalar) { return calculate(writes,{...policy,scope}); },
    explain(writes: readonly WriteFact[], scope: Scalar) {
      const decisions: Decision[] = [];
      const impact = calculate(writes,{...policy,scope,explain:d=>decisions.push(d)});
      return {impact,decisions};
    },
    async command<Db,T>(adapter: CommandAdapter<Db>, context: {scope: Scalar}, work: (db: Db) => Promise<T>): Promise<{data:T;impact:ImpactSet}> {
      return adapter.command(context.scope,async (db,writes) => {
        const data = await work(db);
        return {data,impact:calculate(writes.snapshot(),{...policy,scope:context.scope})};
      });
    },
  };
}
